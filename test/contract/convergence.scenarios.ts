import { describe, expect, it } from "vitest";
import { ingestEvent } from "../../src/application/ingest.js";
import { startCheckout } from "../../src/application/checkout.js";
import { reconcile } from "../../src/application/reconcile.js";
import type { SellerRecord } from "../../src/application/store.js";
import { deliver, checkoutRequest, enabledSeller, sellerUuid, sessionOf, type World } from "../support/world.js";
import { event } from "../support/stripe-fixtures.js";
import { int, rng, shuffle } from "../support/random.js";
import { accountsOf, freshWorld, operator, sellerBalance, system, type DbFactory } from "./support.js";

/**
 * One busy afternoon of two sellers, as Stripe would report it: sales, partial refunds (one pending that succeeds, one that fails, one
 * that succeeds and then fails), disputes that are won and lost, payouts (one paid, one that failed), account changes and events this
 * system does not handle. All of it is done at Stripe first; the events come back as one list in the order they were created.
 */
async function busyAfternoon(w: World): Promise<{ sellers: SellerRecord[]; events: unknown[] }> {
  const one = await enabledSeller(w, sellerUuid(), "One");
  const two = await enabledSeller(w, sellerUuid(), "Two");
  const pay = async (seller: SellerRecord, amount: number) => {
    const started = await startCheckout(w.deps, checkoutRequest(seller, amount));
    if (!started.ok) throw new Error(started.error);
    return { orderId: started.value.orderId, ...w.stripe.pay(sessionOf(started.value)) };
  };
  const refund = (chargeId: string, orderId: string, amount: number, key: string) => w.stripe.createRefund({ chargeId, amount, orderId, idempotencyKey: key });

  const a = await pay(one, 10_000);
  await refund(a.chargeId, a.orderId, 2_500, "refund-a-1");
  await refund(a.chargeId, a.orderId, 3_000, "refund-a-2");
  const disputeA = w.stripe.openDispute(a.chargeId, 4_500);
  w.stripe.updateDispute(disputeA, "under_review");
  w.stripe.closeDispute(disputeA, "lost");
  w.stripe.reverseTransfer(a.chargeId, 4_036); // the operator recovers the seller's share of the lost dispute: 4500 less the platform's fee part (464)

  const b = await pay(one, 4_321);
  const disputeB = w.stripe.openDispute(b.chargeId);
  w.stripe.closeDispute(disputeB, "won");
  w.stripe.nextRefundStatus = "pending";
  const pending = await refund(b.chargeId, b.orderId, 1_000, "refund-b-1");
  w.stripe.settleRefund(pending.refundId, "succeeded");

  const c = await pay(two, 7_777);
  const failing = await refund(c.chargeId, c.orderId, 700, "refund-c-1");
  w.stripe.settleRefund(failing.refundId, "failed");
  w.stripe.nextRefundStatus = "succeeded";
  const d = await pay(two, 2_000);
  const undone = await refund(d.chargeId, d.orderId, 2_000, "refund-d-1");
  w.stripe.failRefund(undone.refundId);

  w.stripe.settleBalances();
  w.stripe.settlePayout(w.stripe.payout(two.accountId, "usd", 3_000));
  w.stripe.failPayout(w.stripe.payout(two.accountId, "usd", 1_000));
  w.stripe.requireInformation(one.accountId, ["external_account"]);
  w.stripe.completeOnboarding(one.accountId);
  w.stripe.touch(two.accountId);
  const noise = [
    event("customer.created", { id: "cus_1Noise000001" }),
    event("payout.paid", { id: "po_1Unknown0001", amount: 5, currency: "usd", status: "paid", created: 1_762_000_000 }, { account: "acct_1Unknown0001" }),
  ];
  return { sellers: [one, two], events: [...w.stripe.takeEvents(), ...noise] };
}

/** What a history ended in, with no ids in it: the same history must give the same fingerprint however its events were delivered. */
async function fingerprint(w: World, sellers: readonly SellerRecord[]): Promise<unknown> {
  const rows = await w.db.transaction(operator, async (tx) => ({
    payments: (await tx.payments.list()).filter((p) => sellers.some((s) => s.id === p.sellerId)).map((p) => ({ amount: p.amount, fee: p.fee, refunded: p.refunded, reversed: p.reversed, reversedFee: p.reversedFee, anomaly: p.anomaly })),
    objects: [...(await tx.objects.list("refund")), ...(await tx.objects.list("dispute")), ...(await tx.objects.list("payout")), ...(await tx.objects.list("transfer"))]
      .filter((o) => sellers.some((s) => s.id === o.sellerId)).map((o) => ({ kind: o.kind, amount: o.amount, status: o.status, rank: o.rank, secondary: o.secondaryAmount })),
    orders: (await Promise.all(sellers.map((s) => tx.orders.listForSeller(s.id)))).flat().map((o) => ({ amount: o.amount, status: o.status })),
    states: await Promise.all(sellers.map(async (s) => (await tx.sellers.get(s.id))?.state)),
    flagged: (await tx.events.flagged()).length,
  }));
  const sorted = (list: object[]) => list.map((x) => JSON.stringify(x)).sort();
  const accounts = await Promise.all(sellers.map((s) => accountsOf(w, s)));
  const balances = await Promise.all(sellers.map((s) => sellerBalance(w, s)));
  return { payments: sorted(rows.payments), objects: sorted(rows.objects), orders: sorted(rows.orders), states: rows.states, flagged: rows.flagged, accounts, balances };
}

export function convergenceScenarios(open: DbFactory, iterations: number): void {
  describe("the order of events does not change the books", () => {
    async function baseline(): Promise<unknown> {
      const f = await freshWorld(open);
      try {
        const { sellers, events } = await busyAfternoon(f.world);
        for (const e of events) await ingestEvent(f.world.deps, e);
        const result = await fingerprint(f.world, sellers);
        const report = await reconcile(f.world.deps, { since: 0 });
        // what is left to report is a warning: Stripe never announces that the reversal of a refund that failed was undone
        expect(report.ok && report.value.findings.filter((x) => x.severity === "error")).toEqual([]);
        expect(await f.world.db.transaction(system, (tx) => tx.events.listDeferred())).toEqual([]);
        return result;
      } finally {
        await f.close();
      }
    }

    it(`delivers ${iterations} shuffled copies of one afternoon, some events twice, and ends where the in-order run ends`, async () => {
      const expected = await baseline();
      const seen = new Set<string>();
      for (let i = 0; i < iterations; i++) {
        const seed = 1_000 + i;
        const next = rng(seed);
        const f = await freshWorld(open);
        try {
          const { sellers, events } = await busyAfternoon(f.world);
          const delivery = shuffle(next, events);
          for (const e of events) if (next() < 0.35) delivery.splice(int(next, 0, delivery.length), 0, e);
          seen.add(delivery.map((e) => (e as { id: string }).id).join());
          const results = await deliver(f.world, delivery);
          expect(results.filter((r) => r.status === "duplicate").length, `seed ${seed}`).toBeGreaterThanOrEqual(delivery.length - events.length);
          expect(await fingerprint(f.world, sellers), `seed ${seed}`).toEqual(expected);
          expect(await f.world.db.transaction(system, (tx) => tx.events.listDeferred()), `seed ${seed}`).toEqual([]);
        } finally {
          await f.close();
        }
      }
      expect(seen.size).toBe(iterations); // every run was a different order
    });

    it("ends in the same place when the shuffled events arrive in concurrent groups of six", async () => {
      const expected = await baseline();
      for (let i = 0; i < Math.max(2, Math.floor(iterations / 3)); i++) {
        const seed = 5_000 + i;
        const next = rng(seed);
        const f = await freshWorld(open);
        try {
          const { sellers, events } = await busyAfternoon(f.world);
          const delivery = shuffle(next, [...events, ...events.filter(() => next() < 0.3)]);
          for (let at = 0; at < delivery.length; at += 6) await Promise.all(delivery.slice(at, at + 6).map((e) => ingestEvent(f.world.deps, e)));
          expect(await fingerprint(f.world, sellers), `seed ${seed}`).toEqual(expected);
          expect(await f.world.db.transaction(system, (tx) => tx.events.listDeferred()), `seed ${seed}`).toEqual([]);
        } finally {
          await f.close();
        }
      }
    });
  });
}
