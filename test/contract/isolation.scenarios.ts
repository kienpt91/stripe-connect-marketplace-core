import { describe, expect, it } from "vitest";
import { requestRefund } from "../../src/application/refunds.js";
import { sellerLedger, sellerOrders } from "../../src/application/views.js";
import { saleEntry } from "../../src/domain/ledger.js";
import type { OrderId } from "../../src/domain/ids.js";
import { deliverAll, enabledSeller, sale, type World } from "../support/world.js";
import { asSeller, operator, sharedDb, system, type DbFactory } from "./support.js";

export function isolationScenarios(open: DbFactory): void {
  describe("a seller and another seller's ledger", () => {
    const world = sharedDb(open);

    async function twoSellers(w: World) {
      const a = await enabledSeller(w, undefined, "Alba Ceramics");
      const b = await enabledSeller(w, undefined, "Bruno Leather");
      const saleA = await sale(w, a, 10_000);
      const saleB = await sale(w, b, 20_000);
      await sale(w, b, 5_000);
      w.stripe.settleBalances();
      const payoutB = w.stripe.payout(b.accountId, "usd", 10_000);
      await deliverAll(w);
      await requestRefund(w.deps, asSeller(a), { orderId: saleA.checkout.orderId, amount: 1_000, idempotencyKey: "refund-iso-0001" });
      await deliverAll(w);
      return { a, b, saleA, saleB, payoutB };
    }

    it("shows a seller their own ledger a page at a time, with the balance, and nothing else", async () => {
      const w = world();
      const { a, saleA } = await twoSellers(w);
      const first = await sellerLedger(w.deps, asSeller(a), a.id, { limit: 1 });
      if (!first.ok) throw new Error(first.error);
      expect(first.value.lines).toHaveLength(1);
      expect(first.value.lines[0]).toMatchObject({ postingKey: `sale:${saleA.chargeId}`, account: "seller_balance", side: "credit", amount: 8_970, currency: "usd", kind: "sale" });
      expect(first.value.next).toBe(first.value.lines[0]?.seq);
      expect(first.value.balance).toEqual({ usd: 8_970 - 897 });
      const second = await sellerLedger(w.deps, asSeller(a), a.id, { limit: 1, afterSeq: first.value.next ?? 0 });
      if (!second.ok) throw new Error(second.error);
      expect(second.value.lines).toHaveLength(1);
      expect(second.value.lines[0]).toMatchObject({ kind: "refund", account: "seller_balance", side: "debit", amount: 897 });
      expect(second.value.next).toBeNull();
      const all = await sellerLedger(w.deps, asSeller(a), a.id);
      expect(all.ok && all.value.lines.every((l) => l.account === "seller_balance")).toBe(true);
    });

    it("refuses another seller's ledger and orders at the door, and refuses the system role", async () => {
      const w = world();
      const { a, b } = await twoSellers(w);
      expect(await sellerLedger(w.deps, asSeller(a), b.id)).toEqual({ ok: false, error: "forbidden" });
      expect(await sellerOrders(w.deps, asSeller(a), b.id)).toEqual({ ok: false, error: "forbidden" });
      expect(await sellerLedger(w.deps, system, b.id)).toEqual({ ok: false, error: "forbidden" });
      expect(await sellerOrders(w.deps, system, b.id)).toEqual({ ok: false, error: "forbidden" });
      const asOperator = await sellerLedger(w.deps, operator, b.id);
      expect(asOperator.ok && asOperator.value.balance).toEqual({ usd: 17_970 + 4_470 - 10_000 });
      const orders = await sellerOrders(w.deps, asSeller(b), b.id);
      expect(orders.ok && orders.value.map((o) => o.amount).sort((x, y) => x - y)).toEqual([5_000, 20_000]);
    });

    it("returns nothing of another seller to a query that asks for it by id, because the transaction runs as the seller", async () => {
      const w = world();
      const { a, b, saleB, payoutB } = await twoSellers(w);
      await w.db.transaction(asSeller(a), async (tx) => {
        expect(await tx.ledger.linesFor(b.id, { afterSeq: 0, limit: 100 })).toEqual([]);
        expect(await tx.ledger.balanceOf(b.id)).toEqual({});
        expect(await tx.sellers.get(b.id)).toBeUndefined();
        expect(await tx.sellers.getByAccount(b.accountId)).toBeUndefined();
        expect((await tx.sellers.list()).map((s) => s.id)).toEqual([a.id]);
        expect(await tx.orders.get(saleB.checkout.orderId as OrderId)).toBeUndefined();
        expect(await tx.orders.findByKey(b.id, "anything")).toBeUndefined();
        expect(await tx.orders.listForSeller(b.id)).toEqual([]);
        expect(await tx.payments.get(saleB.chargeId)).toBeUndefined();
        expect((await tx.payments.list()).map((p) => p.sellerId)).toEqual([a.id]);
        expect(await tx.objects.get("payout", payoutB)).toBeUndefined();
        expect((await tx.objects.list("payout")).filter((o) => o.sellerId === b.id)).toEqual([]);
        expect((await tx.objects.list("transfer")).every((o) => o.sellerId === a.id)).toBe(true);
      });
    });

    it("never shows a seller the platform's side of an entry or anybody else's entry", async () => {
      const w = world();
      const { a, b } = await twoSellers(w);
      await w.db.transaction(asSeller(a), async (tx) => {
        const entries = await tx.ledger.entries();
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.every((e) => e.sellerId === a.id)).toBe(true);
        for (const e of entries) expect(e.lines.every((l) => l.account === "seller_balance")).toBe(true);
        const totals = await tx.ledger.totals();
        expect(totals.every((t) => t.account === "seller_balance")).toBe(true);
        expect(await tx.ledger.has("anything:at_all")).toBe(false);
      });
      await w.db.transaction(operator, async (tx) => {
        const entries = await tx.ledger.entries();
        expect(entries.some((e) => e.sellerId === b.id)).toBe(true);
        expect(entries.some((e) => e.lines.some((l) => l.account === "platform_fees"))).toBe(true);
      });
    });

    it("cannot write anything: not a ledger line, not an order, not a seller, not an event", async () => {
      const w = world();
      const { a, saleA } = await twoSellers(w);
      const forged = saleEntry({ chargeId: "ch_1Forged00001", sellerId: a.id, currency: "usd", amount: 1_000_000, fee: 0, occurredAt: 1 });
      const attempts: [string, (tx: Parameters<Parameters<typeof w.db.transaction>[1]>[0]) => Promise<unknown>][] = [
        ["post a ledger entry", (tx) => tx.ledger.post(forged, null)],
        ["add a payment", (tx) => tx.payments.insert({ chargeId: "ch_1Forged00001", orderId: saleA.checkout.orderId, sellerId: a.id, accountId: a.accountId, currency: "usd", amount: 1, fee: 0, refunded: 0, reversed: 0, reversedFee: 0, anomaly: null, createdAt: 1 })],
        ["change a payment", (tx) => tx.payments.addReversal(saleA.chargeId, { refunded: -1, reversed: -1, reversedFee: 0 })],
        ["mark an order paid", (tx) => tx.orders.markPaid(saleA.checkout.orderId as OrderId, "ch_1Forged00001")],
        ["add a seller", (tx) => tx.sellers.insert({ ...a, id: "5e11e700-0000-4000-8000-00000000ffff" as never, accountId: "acct_1Forged00001" })],
        ["change the seller's state", (tx) => tx.sellers.applySnapshot(a.id, "rejected", a.snapshot ?? { accountId: a.accountId, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, currentlyDue: [], pastDue: [], pendingVerification: [], disabledReason: null }, Number.MAX_SAFE_INTEGER)],
        ["record an event", (tx) => tx.events.insert({ id: "evt_1Forged00001", type: "charge.succeeded", account: null, subject: "x", receivedAt: 1, status: "applied", reason: null, payload: null })],
        ["read the events", (tx) => tx.events.exists("evt_1Forged00001")],
        ["read the waiting events", (tx) => tx.events.listDeferred()],
      ];
      for (const [what, attempt] of attempts) {
        await expect(w.db.transaction(asSeller(a), (tx) => attempt(tx)), what).rejects.toThrow();
      }
      // and none of it took effect
      const view = await sellerLedger(w.deps, asSeller(a), a.id);
      expect(view.ok && view.value.balance).toEqual({ usd: 8_970 - 897 });
    });

    it("lets an operator read all of it and write none of it", async () => {
      const w = world();
      const { a } = await twoSellers(w);
      await w.db.transaction(operator, async (tx) => {
        expect((await tx.sellers.list()).length).toBeGreaterThanOrEqual(2);
        expect((await tx.payments.list()).length).toBeGreaterThanOrEqual(3);
        expect(await tx.events.count()).toBeGreaterThan(0);
      });
      const forged = saleEntry({ chargeId: "ch_1Forged00002", sellerId: a.id, currency: "usd", amount: 1_000, fee: 0, occurredAt: 1 });
      await expect(w.db.transaction(operator, (tx) => tx.ledger.post(forged, null))).rejects.toThrow();
      await expect(w.db.transaction(operator, (tx) => tx.orders.setStatus("x" as OrderId, "paid"))).rejects.toThrow();
    });
  });
}
