import { describe, expect, it } from "vitest";
import { startCheckout } from "../../src/application/checkout.js";
import { requestRefund, type RefundError } from "../../src/application/refunds.js";
import { GatewayError } from "../../src/application/ports.js";
import { reconcile } from "../../src/application/reconcile.js";
import { checkoutRequest, deliver, deliverAll, enabledSeller, sale, sellerUuid, type World } from "../support/world.js";
import { accountsOf, asSeller, entriesOf, freshWorld, objectOf, operator, orderOf, paymentOf, sellerBalance, sharedDb, system, type DbFactory } from "./support.js";
import { event, refundObject } from "../support/stripe-fixtures.js";

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

  // A charge in dispute can still be refunded (Stripe does not stop it), and the dispute can then be lost: the money has gone out twice.
  // The seller and the fee have paid for it once, by the refund; the platform bears the second time. Nothing may stay in disputed_funds.
  describe("a dispute that is lost after the same money was refunded", () => {
    const identity = (books: Record<string, number>): boolean => (books["usd/stripe_funds"] ?? NaN) + (books["usd/disputed_funds"] ?? NaN) === (books["usd/seller_balance"] ?? NaN) + (books["usd/platform_fees"] ?? NaN);

    /** A sale of 100.00, a dispute for the whole charge, a refund of `refunded` while it is open, then the dispute is lost. */
    async function history(w: World, refunded: number, suffix: string) {
      const seller = await enabledSeller(w);
      const { checkout, chargeId } = await sale(w, seller, 10_000);
      const dispute = w.stripe.openDispute(chargeId);
      const refund = await requestRefund(w.deps, asSeller(seller), { orderId: checkout.orderId, amount: refunded, idempotencyKey: `refund-key-${suffix}` });
      if (!refund.ok) throw new Error("refund");
      w.stripe.closeDispute(dispute, "lost");
      return { seller, chargeId, dispute, refundId: refund.value.refundId };
    }
    /** The events as Stripe made them, except that every dispute event comes before the refund's: the loss is applied first. */
    const disputeFirst = (events: readonly unknown[]): unknown[] => {
      const disputes: unknown[] = [];
      const others: unknown[] = [];
      for (const e of events) {
        const type = typeof e === "object" && e !== null && "type" in e ? e.type : undefined;
        (typeof type === "string" && type.startsWith("charge.dispute.") ? disputes : others).push(e);
      }
      return [...disputes, ...others];
    };

    it("books the loss, bears on the platform what the refund already took, and leaves nothing held for a dispute that is over", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const { seller, chargeId, dispute } = await history(w, 10_000, "0040");
      expect((await deliverAll(w)).every((r) => r.status === "applied")).toBe(true);

      const books = await accountsOf(w, seller);
      expect(books).toEqual({ "usd/stripe_funds": -10_000, "usd/seller_balance": 0, "usd/platform_fees": -10_000, "usd/disputed_funds": 0 });
      expect(identity(books)).toBe(true);
      expect(await paymentOf(w, chargeId)).toMatchObject({ refunded: 10_000, reversed: 10_000, reversedFee: 1_030 });
      expect(await objectOf(w, "dispute", dispute)).toMatchObject({ status: "lost", rank: 2, feePart: 0, secondaryAmount: 10_000 });
      const lost = (await entriesOf(w, seller)).find((e) => e.kind === "dispute_lost");
      expect(lost?.lines).toEqual([{ account: "platform_fees", side: "debit", amount: 10_000 }, { account: "disputed_funds", side: "credit", amount: 10_000 }]);
      const report = await reconcile(w.deps, { since: 0 });
      expect(report.ok && report.value.findings).toEqual([]);
      await f.close();
    });

    it("charges the part of the sale that is left to seller and fee as usual, and the rest to the platform", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const { seller, chargeId, dispute } = await history(w, 6_000, "0041");
      expect((await deliverAll(w)).every((r) => r.status === "applied")).toBe(true);

      // the refund took 5382 from the seller and 618 from the fee; the 4000 left of the sale take 3588 and 412; the other 6000 are the platform's
      const books = await accountsOf(w, seller);
      expect(books).toEqual({ "usd/stripe_funds": -6_000, "usd/seller_balance": 0, "usd/platform_fees": -6_000, "usd/disputed_funds": 0 });
      expect(identity(books)).toBe(true);
      expect(await paymentOf(w, chargeId)).toMatchObject({ refunded: 6_000, reversed: 10_000, reversedFee: 1_030 });
      expect(await objectOf(w, "dispute", dispute)).toMatchObject({ status: "lost", feePart: 412, secondaryAmount: 6_000 });
      const lost = (await entriesOf(w, seller)).find((e) => e.kind === "dispute_lost");
      expect(lost?.lines).toEqual([
        { account: "seller_balance", side: "debit", amount: 3_588 },
        { account: "platform_fees", side: "debit", amount: 6_412 },
        { account: "disputed_funds", side: "credit", amount: 10_000 },
      ]);

      // the same gap as for any lost dispute: the operator has yet to recover the seller's 3588 at Stripe
      const before = await reconcile(w.deps, { since: 0 });
      if (!before.ok) throw new Error("reconcile");
      expect(before.value.findings.map((x) => x.kind)).toContain("balance_mismatch");
      w.stripe.reverseTransfer(chargeId, 3_588);
      await deliverAll(w);
      const after = await reconcile(w.deps, { since: 0 });
      expect(after.ok && after.value.findings).toEqual([]);
      await f.close();
    });

    it("ends in the same books when the loss is applied before the refund it overlaps, a refund that fails afterwards included", async () => {
      for (const refunded of [10_000, 6_000]) {
        const inOrder = await freshWorld(open);
        const first = await history(inOrder.world, refunded, "0042");
        await deliverAll(inOrder.world);

        const swapped = await freshWorld(open);
        const second = await history(swapped.world, refunded, "0043");
        const results = await deliver(swapped.world, disputeFirst(swapped.world.stripe.takeEvents()));
        expect(results.every((r) => r.status === "applied"), `${refunded}: ${results.map((r) => `${r.status} ${r.reason ?? ""}`).join(", ")}`).toBe(true);

        expect(await accountsOf(swapped.world, second.seller), String(refunded)).toEqual(await accountsOf(inOrder.world, first.seller));
        const [a, b] = [await paymentOf(inOrder.world, first.chargeId), await paymentOf(swapped.world, second.chargeId)];
        expect({ refunded: b?.refunded, reversed: b?.reversed, reversedFee: b?.reversedFee }).toEqual({ refunded: a?.refunded, reversed: a?.reversed, reversedFee: a?.reversedFee });
        await inOrder.close();
        await swapped.close();
      }

      // the refund that was applied after the loss fails: what the platform had borne comes back, and the loss stays where it belongs
      const f = await freshWorld(open);
      const w = f.world;
      const { seller, chargeId, refundId } = await history(w, 10_000, "0044");
      w.stripe.failRefund(refundId);
      expect((await deliver(w, disputeFirst(w.stripe.takeEvents()))).every((r) => r.status === "applied")).toBe(true);
      expect(await accountsOf(w, seller)).toEqual({ "usd/stripe_funds": 0, "usd/seller_balance": 0, "usd/platform_fees": 0, "usd/disputed_funds": 0 });
      expect(await paymentOf(w, chargeId)).toMatchObject({ refunded: 0, reversed: 10_000, reversedFee: 1_030 });
      await f.close();
    });

    it("keeps the loss on the platform when the refund fails after the loss was applied", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const { seller, chargeId, refundId } = await history(w, 10_000, "0045");
      await deliverAll(w);
      w.stripe.failRefund(refundId);
      expect((await deliverAll(w)).every((r) => r.status === "applied")).toBe(true);
      // the refund had taken the seller's 89.70 and the fee's 10.30, so the loss was the platform's; the refund is undone, the seller is owed the money again, the platform's loss stays
      const books = await accountsOf(w, seller);
      expect(books).toEqual({ "usd/stripe_funds": 0, "usd/seller_balance": 8_970, "usd/platform_fees": -8_970, "usd/disputed_funds": 0 });
      expect(await paymentOf(w, chargeId)).toMatchObject({ refunded: 0, reversed: 0, reversedFee: 0 });
      // the operator recovers the seller's share of the lost dispute at Stripe: the ledger has not charged it, and reconciliation says so
      w.stripe.reverseTransfer(chargeId, 8_970);
      await deliverAll(w);
      const report = await reconcile(w.deps, { since: 0 });
      if (!report.ok) throw new Error("reconcile");
      expect(report.value.findings.map((x) => x.kind)).toEqual(expect.arrayContaining(["balance_mismatch", "transfer_mismatch"]));
      await f.close();
    });

    it("still refuses refunds that add up to more than the charge, and bears the rest on the platform when a lost dispute had already taken it", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const seller = await enabledSeller(w);
      const { chargeId } = await sale(w, seller, 10_000);
      w.stripe.closeDispute(w.stripe.openDispute(chargeId, 4_000), "lost");
      await deliverAll(w);
      const refundOf = (id: string, amount: number) => deliver(w, [event("refund.created", refundObject({ id, charge: chargeId, amount }))]);
      expect((await refundOf("re_1SixThousand", 6_000))[0]).toMatchObject({ status: "applied" }); // 4000 lost and 6000 refunded: the sale is all taken back
      expect((await refundOf("re_1TooMuch0001", 4_001))[0]).toMatchObject({ status: "rejected", reason: "refund_exceeds_charge" }); // 10001 refunded in all
      expect((await refundOf("re_1FourThousand", 4_000))[0]).toMatchObject({ status: "applied" }); // the dispute had taken these 4000 already: the platform bears them
      expect(await accountsOf(w, seller)).toEqual({ "usd/stripe_funds": -4_000, "usd/seller_balance": 0, "usd/platform_fees": -4_000, "usd/disputed_funds": 0 });
      expect(await paymentOf(w, chargeId)).toMatchObject({ refunded: 10_000, reversed: 10_000, reversedFee: 1_030 });
      await f.close();
    });
  });
}
