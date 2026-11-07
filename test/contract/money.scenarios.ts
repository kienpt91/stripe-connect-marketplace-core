import { describe, expect, it } from "vitest";
import { startCheckout } from "../../src/application/checkout.js";
import { requestRefund, type RefundError } from "../../src/application/refunds.js";
import { GatewayError } from "../../src/application/ports.js";
import { reconcile } from "../../src/application/reconcile.js";
import { checkoutRequest, deliverAll, enabledSeller, sale, sellerUuid } from "../support/world.js";
import { accountsOf, asSeller, freshWorld, objectOf, operator, orderOf, paymentOf, sellerBalance, sharedDb, system, type DbFactory } from "./support.js";

export function moneyScenarios(open: DbFactory): void {
  describe("refunds, rounding and who bears what", () => {
    const world = sharedDb(open);

    it("asks Stripe for the refund and books nothing until Stripe confirms it with a signed event", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const { checkout } = await sale(w, seller, 10_000);
      const result = await requestRefund(w.deps, asSeller(seller), { orderId: checkout.orderId, amount: 2_500, idempotencyKey: "refund-key-0001" });
      expect(result).toMatchObject({ ok: true, value: { status: "succeeded", amount: 2_500 } });
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 }); // the event has not been delivered
      expect((await deliverAll(w)).every((r) => r.status === "applied")).toBe(true);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 - 2_243 });
    });

    it("splits every refund between seller and platform so that the parts add up exactly, however awkward the numbers", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      // 1001 at 10% + 30 = fee 130; refunds 500 + 501 -> floor(130 * 500 / 1001) = 64, then the rest of the fee: 66
      const { checkout, chargeId } = await sale(w, seller, 1_001);
      expect(await paymentOf(w, chargeId)).toMatchObject({ fee: 130 });
      await requestRefund(w.deps, asSeller(seller), { orderId: checkout.orderId, amount: 500, idempotencyKey: "refund-key-0002" });
      await deliverAll(w);
      expect(await paymentOf(w, chargeId)).toMatchObject({ reversed: 500, reversedFee: 64 });
      await requestRefund(w.deps, asSeller(seller), { orderId: checkout.orderId, amount: 501, idempotencyKey: "refund-key-0003" });
      await deliverAll(w);
      expect(await paymentOf(w, chargeId)).toMatchObject({ refunded: 1_001, reversed: 1_001, reversedFee: 130 });
      expect(await accountsOf(w, seller)).toEqual({ "usd/stripe_funds": 0, "usd/seller_balance": 0, "usd/platform_fees": 0, "usd/disputed_funds": 0 });
      expect((await orderOf(w, checkout.orderId))?.status).toBe("refunded");
    });

    it("never refunds more than what is left, for a seller or an operator, and says so before calling Stripe", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const { checkout } = await sale(w, seller, 10_000);
      const refund = (amount: unknown, key = "refund-key-0004", actor = asSeller(seller), orderId: unknown = checkout.orderId) => requestRefund(w.deps, actor, { orderId, amount, idempotencyKey: key });
      const calls = w.stripe.calls.length;
      const cases: [unknown, RefundError][] = [[0, "invalid_amount"], [-5, "invalid_amount"], [1.5, "invalid_amount"], ["100", "invalid_amount"], [NaN, "invalid_amount"], [10_001, "exceeds_refundable"]];
      for (const [amount, error] of cases) expect(await refund(amount), String(amount)).toEqual({ ok: false, error });
      expect(await refund(100, "short")).toEqual({ ok: false, error: "invalid_idempotency_key" });
      expect(await refund(100, "refund-key-0004", asSeller(seller), "not-a-uuid")).toEqual({ ok: false, error: "invalid_order_id" });
      expect(w.stripe.calls).toHaveLength(calls);
      expect((await refund(6_000, "refund-key-0005")).ok).toBe(true);
      await deliverAll(w);
      expect(await refund(4_001, "refund-key-0006")).toEqual({ ok: false, error: "exceeds_refundable" });
      expect((await refund(undefined, "refund-key-0007", operator)).ok).toBe(true); // everything that is left
      await deliverAll(w);
      expect(await refund(1, "refund-key-0008")).toEqual({ ok: false, error: "exceeds_refundable" });
      expect(await sellerBalance(w, seller)).toEqual({ usd: 0 });
    });

    it("answers an order that is not the seller's exactly as one that does not exist", async () => {
      const w = world();
      const a = await enabledSeller(w);
      const b = await enabledSeller(w);
      const { checkout } = await sale(w, b, 10_000);
      const mine = await requestRefund(w.deps, asSeller(a), { orderId: checkout.orderId, amount: 100, idempotencyKey: "refund-key-0009" });
      const nobody = await requestRefund(w.deps, asSeller(a), { orderId: sellerUuid(), amount: 100, idempotencyKey: "refund-key-0010" });
      expect(mine).toEqual({ ok: false, error: "not_found" });
      expect(nobody).toEqual(mine);
      expect(await requestRefund(w.deps, system, { orderId: checkout.orderId, amount: 100, idempotencyKey: "refund-key-0011" })).toEqual({ ok: false, error: "not_found" });
      expect(w.stripe.calls.filter((c) => c.method === "createRefund")).toHaveLength(0);
      expect(await sellerBalance(w, b)).toEqual({ usd: 8_970 });
    });

    it("refuses to refund an order that has not been paid", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      expect(await requestRefund(w.deps, asSeller(seller), { orderId: started.value.orderId, amount: 100, idempotencyKey: "refund-key-0012" })).toEqual({ ok: false, error: "not_paid" });
    });

    it("maps a gateway failure, and a reused idempotency key with another amount, to gateway_failed", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const { checkout } = await sale(w, seller, 10_000);
      w.stripe.injectFailure("createRefund", new GatewayError("unavailable", "down"));
      expect(await requestRefund(w.deps, asSeller(seller), { orderId: checkout.orderId, amount: 100, idempotencyKey: "refund-key-0013" })).toEqual({ ok: false, error: "gateway_failed" });
      expect((await requestRefund(w.deps, asSeller(seller), { orderId: checkout.orderId, amount: 100, idempotencyKey: "refund-key-0013" })).ok).toBe(true);
      expect(await requestRefund(w.deps, asSeller(seller), { orderId: checkout.orderId, amount: 200, idempotencyKey: "refund-key-0013" })).toEqual({ ok: false, error: "gateway_failed" });
      w.stripe.injectFailure("createRefund", new TypeError("a bug") as never);
      await expect(requestRefund(w.deps, asSeller(seller), { orderId: checkout.orderId, amount: 100, idempotencyKey: "refund-key-0014" })).rejects.toThrow("a bug");
    });

    it("books a refund once even when the same refund is asked for twice with one idempotency key", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const { checkout } = await sale(w, seller, 10_000);
      const first = await requestRefund(w.deps, asSeller(seller), { orderId: checkout.orderId, amount: 1_000, idempotencyKey: "refund-key-0015" });
      const second = await requestRefund(w.deps, asSeller(seller), { orderId: checkout.orderId, amount: 1_000, idempotencyKey: "refund-key-0015" });
      expect(first.ok && second.ok && first.value.refundId === second.value.refundId).toBe(true);
      await deliverAll(w);
      expect(await paymentOf(w, (await orderOf(w, checkout.orderId))?.chargeId ?? "")).toMatchObject({ refunded: 1_000 });
    });
  });

  describe("a refund after the payout", () => {
    it("leaves the seller owing the platform, keeps the ledger balanced, and is the one thing reconciliation reports", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const seller = await enabledSeller(w);
      const { checkout, chargeId } = await sale(w, seller, 10_000);
      w.stripe.settleBalances();
      const payout = w.stripe.payout(seller.accountId, "usd"); // everything the seller has: 8970
      w.stripe.settlePayout(payout);
      await deliverAll(w);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 0 });

      const refund = await requestRefund(w.deps, asSeller(seller), { orderId: checkout.orderId, amount: 10_000, idempotencyKey: "refund-key-0016" });
      expect(refund.ok).toBe(true); // Stripe takes it; the connected account balance goes negative
      await deliverAll(w);
      expect(await sellerBalance(w, seller)).toEqual({ usd: -8_970 });
      expect(await paymentOf(w, chargeId)).toMatchObject({ refunded: 10_000, reversed: 10_000, reversedFee: 1_030 });
      expect(await accountsOf(w, seller)).toEqual({ "usd/stripe_funds": -8_970, "usd/seller_balance": -8_970, "usd/platform_fees": 0, "usd/disputed_funds": 0 });

      const report = await reconcile(w.deps, { since: 0 });
      if (!report.ok) throw new Error("reconcile");
      expect(report.value.findings.map((x) => `${x.severity}:${x.kind}`)).toEqual(["warning:negative_seller_balance"]);
      expect(report.value.findings[0]?.message).toContain("89.70 USD");
      await f.close();
    });
  });

  describe("a dispute that is lost", () => {
    it("charges the seller's share in the ledger; reconciliation shows the gap until the transfer is reversed at Stripe, then nothing", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const seller = await enabledSeller(w);
      const { chargeId } = await sale(w, seller, 10_000);
      w.stripe.settleBalances();
      const dispute = w.stripe.openDispute(chargeId);
      w.stripe.closeDispute(dispute, "lost");
      await deliverAll(w);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 0 });
      expect(await objectOf(w, "dispute", dispute)).toMatchObject({ status: "lost", rank: 2, feePart: 1_030 });

      const before = await reconcile(w.deps, { since: 0 });
      if (!before.ok) throw new Error("reconcile");
      const kinds = before.value.findings.map((x) => x.kind);
      expect(kinds).toContain("balance_mismatch");
      expect(kinds).toContain("transfer_mismatch");
      expect(before.value.findings.find((x) => x.kind === "balance_mismatch")?.message).toContain("ledger owes the seller 0.00 USD, the Stripe balance of");

      // the operator recovers the seller's share at Stripe; the signed event reports it
      w.stripe.reverseTransfer(chargeId, 8_970);
      await deliverAll(w);
      const after = await reconcile(w.deps, { since: 0 });
      expect(after.ok && after.value.findings).toEqual([]);
      await f.close();
    });
  });
}
