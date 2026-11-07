import { describe, expect, it } from "vitest";
import { startCheckout } from "../../src/application/checkout.js";
import { reconcile, type ReconcileReport } from "../../src/application/reconcile.js";
import { GatewayError } from "../../src/application/ports.js";
import { requestRefund } from "../../src/application/refunds.js";
import { checkoutRequest, deliver, deliverAll, enabledSeller, handCharge, sale, sessionOf, type World } from "../support/world.js";
import { asSeller, freshWorld, type DbFactory } from "./support.js";

async function report(w: World, options: { since?: number; stuckAfterMs?: number } = {}): Promise<ReconcileReport> {
  const result = await reconcile(w.deps, { since: options.since ?? 0, ...(options.stuckAfterMs === undefined ? {} : { stuckAfterMs: options.stuckAfterMs }) });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const kinds = (r: ReconcileReport): string[] => r.findings.map((f) => f.kind).sort();

export function reconciliationScenarios(open: DbFactory): void {
  describe("reconciliation of the ledger against Stripe", () => {
    it("finds nothing after a complete history: sale, refund, won dispute, payout, in two currencies", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const seller = await enabledSeller(w);
      const { checkout, chargeId } = await sale(w, seller, 10_000);
      await requestRefund(w.deps, asSeller(seller), { orderId: checkout.orderId, amount: 2_500, idempotencyKey: "refund-rec-0001" });
      await deliverAll(w);
      w.stripe.closeDispute(w.stripe.openDispute(chargeId, 7_500), "won");
      await sale(w, seller, 4_000, { currency: "eur" });
      await sale(w, seller, 5_000, { currency: "jpy" });
      w.stripe.settleBalances();
      const payout = w.stripe.payout(seller.accountId, "usd", 6_000);
      w.stripe.settlePayout(payout);
      await deliverAll(w);
      const r = await report(w);
      expect(r).toMatchObject({ sellers: 1, payments: 3, payouts: 1, findings: [] });
      await f.close();
    });

    it("finds a payout whose events were lost, then nothing once they arrive", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const seller = await enabledSeller(w);
      await sale(w, seller, 10_000);
      w.stripe.settleBalances();
      w.stripe.settlePayout(w.stripe.payout(seller.accountId, "usd", 5_000));
      const lost = w.stripe.takeEvents(); // the webhook endpoint was down
      expect(kinds(await report(w))).toEqual(["balance_mismatch", "payout_missing_in_ledger"]);
      await deliver(w, lost);
      expect((await report(w)).findings).toEqual([]);
      await f.close();
    });

    it("finds a sale whose events were lost: Stripe took the money, the ledger never heard of it", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const seller = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      w.stripe.pay(sessionOf(started.value));
      const lost = w.stripe.takeEvents();
      const r = await report(w);
      expect(kinds(r)).toEqual(["balance_mismatch", "charge_missing_in_ledger"]);
      expect(r.findings.find((x) => x.kind === "charge_missing_in_ledger")?.message).toContain(`order ${started.value.orderId}`);
      await deliver(w, lost);
      expect((await report(w)).findings).toEqual([]);
      await f.close();
    });

    it("finds a refund whose events were lost, in the balance and in the amount refunded", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const seller = await enabledSeller(w);
      const { checkout } = await sale(w, seller, 10_000);
      await requestRefund(w.deps, asSeller(seller), { orderId: checkout.orderId, amount: 3_000, idempotencyKey: "refund-rec-0002" });
      const lost = w.stripe.takeEvents();
      expect(kinds(await report(w))).toEqual(["balance_mismatch", "refund_mismatch"]);
      await deliver(w, lost);
      expect((await report(w)).findings).toEqual([]);
      await f.close();
    });

    it("finds a payout whose `paid` event was lost as a status that lags, a warning and not an error", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const seller = await enabledSeller(w);
      await sale(w, seller, 10_000);
      w.stripe.settleBalances();
      const payout = w.stripe.payout(seller.accountId, "usd", 5_000);
      await deliverAll(w);
      w.stripe.settlePayout(payout);
      w.stripe.takeEvents();
      const r = await report(w);
      expect(r.findings).toMatchObject([{ kind: "payout_status_mismatch", severity: "warning", message: "ledger says pending, Stripe says paid" }]);
      await f.close();
    });

    it("reports a charge sent to the wrong account, and the transfer that waits for it once it has waited long enough", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const seller = await enabledSeller(w);
      const other = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      w.stripe.pay(sessionOf(started.value), { destination: other.accountId });
      await deliverAll(w);
      expect(kinds(await report(w))).toEqual(["balance_mismatch", "charge_missing_in_ledger", "rejected_event"]);
      w.clock.advance(20 * 60_000);
      expect(kinds(await report(w))).toContain("stuck_event");
      expect(kinds(await report(w, { stuckAfterMs: 60 * 60_000 }))).not.toContain("stuck_event");
      await f.close();
    });

    it("reports a sale that differs from its order", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const seller = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      await deliver(w, [handCharge(seller, { id: started.value.orderId, amount: 10_000, fee: 1_030 }, { amount: 9_900, application_fee_amount: 1_020 })]);
      const r = await report(w);
      expect(r.findings.find((x) => x.kind === "order_mismatch")).toMatchObject({ severity: "error" });
      await f.close();
    });

    it("limits the comparison of objects to the window, and keeps comparing balances", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const seller = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      w.stripe.pay(sessionOf(started.value));
      w.stripe.takeEvents();
      expect(kinds(await report(w))).toContain("charge_missing_in_ledger");
      const later = await report(w, { since: w.clock.now() + 1_000 });
      expect(kinds(later)).toEqual(["balance_mismatch"]);
      await f.close();
    });

    it("says when Stripe cannot be read, and does not report a half-compared ledger", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const seller = await enabledSeller(w);
      await sale(w, seller, 10_000);
      w.stripe.injectFailure("listCharges", new GatewayError("rate_limited", "slow down"));
      expect(await reconcile(w.deps, { since: 0 })).toEqual({ ok: false, error: "gateway_failed" });
      w.stripe.injectFailure("retrieveBalance", new TypeError("a bug") as never);
      await expect(reconcile(w.deps, { since: 0 })).rejects.toThrow("a bug");
      expect((await report(w)).findings).toEqual([]);
      await f.close();
    });
  });
}
