import { describe, expect, it } from "vitest";
import { GatewayError, type CheckoutInput } from "../../src/application/ports.js";
import { parseStripeEvent } from "../../src/domain/stripe-events.js";
import { FakeStripe } from "../../src/infrastructure/stripe/fake-stripe.js";
import { ManualClock } from "../../src/infrastructure/system.js";

const clock = () => new ManualClock(Date.UTC(2026, 10, 9, 9, 0));
const checkout = (accountId: string, patch: Partial<CheckoutInput> = {}): CheckoutInput => ({
  orderId: "0a000000-0000-4000-8000-000000000001", accountId, amount: 10_000, currency: "usd", applicationFee: 1_030, description: "Mug", successUrl: "https://m.example/ok", cancelUrl: "https://m.example/no",
  idempotencyKey: "order-0001-key", ...patch,
});

async function enabled(): Promise<{ stripe: FakeStripe; accountId: string; sessionId: string }> {
  const stripe = new FakeStripe(clock());
  const { accountId } = await stripe.createAccount({ sellerId: "s1", country: "DE", idempotencyKey: "seller-s1" });
  stripe.completeOnboarding(accountId);
  const { sessionId } = await stripe.createCheckoutSession(checkout(accountId));
  return { stripe, accountId, sessionId };
}

const rejection = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return "no error";
  } catch (error) {
    return error instanceof GatewayError ? error.code : String(error);
  }
};

describe("the fake Stripe keeps Stripe's rules, so that what passes against it means something", () => {
  it("answers the same idempotency key with the same answer and refuses other parameters under it", async () => {
    const stripe = new FakeStripe(clock());
    const a = await stripe.createAccount({ sellerId: "s1", country: "DE", idempotencyKey: "seller-s1" });
    expect(await stripe.createAccount({ sellerId: "s1", country: "DE", idempotencyKey: "seller-s1" })).toEqual(a);
    expect(await rejection(() => stripe.createAccount({ sellerId: "s1", country: "FR", idempotencyKey: "seller-s1" }))).toBe("invalid_request");
    expect((await stripe.createAccount({ sellerId: "s2", country: "DE", idempotencyKey: "seller-s2" })).accountId).not.toBe(a.accountId);
  });

  it("starts an account with requirements due and no charges, and an account link points at it", async () => {
    const stripe = new FakeStripe(clock());
    const { accountId } = await stripe.createAccount({ sellerId: "s1", country: "DE", idempotencyKey: "seller-s1" });
    expect(await stripe.retrieveAccount(accountId)).toMatchObject({ chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, disabledReason: "requirements.past_due" });
    const link = await stripe.createAccountLink({ accountId, returnUrl: "https://m.example/a", refreshUrl: "https://m.example/b" });
    expect(link.url).toContain(accountId);
    expect(link.expiresAt).toBe(Date.UTC(2026, 10, 9, 9, 5));
    expect(await rejection(() => stripe.createAccountLink({ accountId: "acct_1Nothing0001", returnUrl: "a", refreshUrl: "b" }))).toBe("not_found");
    expect(await rejection(() => stripe.retrieveAccount("acct_1Nothing0001"))).toBe("not_found");
  });

  it("refuses a checkout for an account that cannot take charges, and for an impossible amount or fee", async () => {
    const stripe = new FakeStripe(clock());
    const { accountId } = await stripe.createAccount({ sellerId: "s1", country: "DE", idempotencyKey: "seller-s1" });
    expect(await rejection(() => stripe.createCheckoutSession(checkout(accountId)))).toBe("invalid_request");
    stripe.completeOnboarding(accountId);
    for (const patch of [{ amount: 0 }, { amount: 10.5 }, { applicationFee: -1 }, { applicationFee: 10_000 }]) {
      expect(await rejection(() => stripe.createCheckoutSession(checkout(accountId, { ...patch, idempotencyKey: `key-${JSON.stringify(patch)}` })))).toBe("invalid_request");
    }
    expect(await rejection(() => stripe.createCheckoutSession(checkout("acct_1Nothing0001")))).toBe("not_found");
  });

  it("lets a session be paid once, credits the net as pending, and makes it available when the balances settle", async () => {
    const { stripe, accountId, sessionId } = await enabled();
    const { chargeId } = stripe.pay(sessionId);
    expect(() => stripe.pay(sessionId)).toThrow("no open session");
    expect(() => stripe.pay("cs_1Nothing00001")).toThrow("no open session");
    expect(await stripe.retrieveBalance(accountId)).toEqual([{ currency: "usd", available: 0, pending: 8_970 }]);
    stripe.settleBalances();
    expect(await stripe.retrieveBalance(accountId)).toEqual([{ currency: "usd", available: 8_970, pending: 0 }]);
    expect(await stripe.listCharges(0)).toEqual([{ id: chargeId, amount: 10_000, currency: "usd", applicationFee: 1_030, amountRefunded: 0, destination: accountId, orderId: "0a000000-0000-4000-8000-000000000001", createdAt: Date.UTC(2026, 10, 9, 9, 0) }]);
    expect(await stripe.listCharges(Date.UTC(2026, 10, 10))).toEqual([]);
  });

  it("refunds take the seller's share back from the account and refuse more than what is left", async () => {
    const { stripe, accountId, sessionId } = await enabled();
    const { chargeId } = stripe.pay(sessionId);
    stripe.settleBalances();
    const input = { chargeId, amount: 2_500, orderId: "0a000000-0000-4000-8000-000000000001", idempotencyKey: "refund-0001-key" };
    const refund = await stripe.createRefund(input);
    expect(refund.status).toBe("succeeded");
    expect(await stripe.createRefund(input)).toEqual(refund); // the same key is the same refund
    expect((await stripe.retrieveBalance(accountId))[0]?.available).toBe(8_970 - 2_243);
    expect((await stripe.listCharges(0))[0]?.amountRefunded).toBe(2_500);
    expect(await rejection(() => stripe.createRefund({ ...input, amount: 7_501, idempotencyKey: "refund-0002-key" }))).toBe("invalid_request");
    expect(await rejection(() => stripe.createRefund({ ...input, chargeId: "ch_1Nothing00001", idempotencyKey: "refund-0003-key" }))).toBe("not_found");
    expect(await rejection(() => stripe.createRefund({ ...input, amount: 100 }))).toBe("invalid_request"); // the key was used for 2500
  });

  it("settles a pending refund, and undoes a refund that fails after it succeeded", async () => {
    const { stripe, accountId, sessionId } = await enabled();
    const { chargeId } = stripe.pay(sessionId);
    const input = { chargeId, amount: 4_000, orderId: "0a000000-0000-4000-8000-000000000001", idempotencyKey: "refund-0001-key" };
    stripe.nextRefundStatus = "pending";
    const { refundId } = await stripe.createRefund(input);
    expect((await stripe.retrieveBalance(accountId))[0]?.pending).toBe(8_970);
    stripe.settleRefund(refundId, "succeeded");
    expect((await stripe.retrieveBalance(accountId))[0]?.pending).toBe(8_970); // pending funds are reduced through the available side, the total is what counts
    const total = async () => (await stripe.retrieveBalance(accountId)).reduce((s, b) => s + b.available + b.pending, 0);
    expect(await total()).toBe(8_970 - 3_588);
    expect(() => stripe.settleRefund(refundId, "failed")).toThrow("no pending refund");
    stripe.failRefund(refundId);
    expect(await total()).toBe(8_970);
    expect(() => stripe.failRefund(refundId)).toThrow("no succeeded refund");
    expect(() => stripe.failRefund("re_1Nothing00001")).toThrow("no succeeded refund");
  });

  it("refuses to refund a charge that was charged back", async () => {
    const { stripe, sessionId } = await enabled();
    const { chargeId } = stripe.pay(sessionId);
    const dispute = stripe.openDispute(chargeId);
    stripe.updateDispute(dispute, "under_review");
    stripe.closeDispute(dispute, "lost");
    expect(await rejection(() => stripe.createRefund({ chargeId, amount: 100, orderId: "0a000000-0000-4000-8000-000000000001", idempotencyKey: "refund-0001-key" }))).toBe("invalid_request");
    expect(() => stripe.updateDispute("du_1Nothing00001", "needs_response")).toThrow("no such dispute");
  });

  it("recovers a lost dispute from the seller only when an operator reverses the transfer, and not more than the transfer", async () => {
    const { stripe, accountId, sessionId } = await enabled();
    const { chargeId } = stripe.pay(sessionId);
    stripe.settleBalances();
    stripe.closeDispute(stripe.openDispute(chargeId), "lost");
    expect((await stripe.retrieveBalance(accountId))[0]?.available).toBe(8_970); // the platform's balance paid, not the seller's
    stripe.reverseTransfer(chargeId, 8_970);
    expect((await stripe.retrieveBalance(accountId))[0]?.available).toBe(0);
    expect(() => stripe.reverseTransfer(chargeId, 1)).toThrow("invalid reversal");
    expect(() => stripe.reverseTransfer("ch_1Nothing00001", 1)).toThrow("no such charge");
  });

  it("pays out from the available balance only, and puts a failed payout back", async () => {
    const { stripe, accountId, sessionId } = await enabled();
    stripe.pay(sessionId);
    expect(() => stripe.payout(accountId, "usd", 100)).toThrow("insufficient available balance"); // still pending
    stripe.settleBalances();
    expect(() => stripe.payout(accountId, "usd", 8_971)).toThrow("insufficient available balance");
    expect(() => stripe.payout(accountId, "usd", 0)).toThrow("insufficient available balance");
    const payout = stripe.payout(accountId, "usd", 5_000);
    expect(await stripe.listPayouts(accountId, 0)).toEqual([{ id: payout, amount: 5_000, currency: "usd", status: "pending", createdAt: Date.UTC(2026, 10, 9, 9, 0) }]);
    expect(await stripe.listPayouts(accountId, Date.UTC(2026, 10, 10))).toEqual([]);
    stripe.settlePayout(payout);
    stripe.failPayout(payout);
    expect((await stripe.retrieveBalance(accountId))[0]?.available).toBe(8_970);
    expect(() => stripe.settlePayout("po_1Nothing00001")).toThrow("no such payout");
    expect(stripe.payout(accountId, "usd")).toMatch(/^po_/); // the whole balance
  });

  it("fails the next call of a method on request, and keeps a log of the calls", async () => {
    const stripe = new FakeStripe(clock());
    stripe.injectFailure("createAccount", new GatewayError("rate_limited", "slow"), 2);
    expect(await rejection(() => stripe.createAccount({ sellerId: "s1", country: "DE", idempotencyKey: "seller-s1" }))).toBe("rate_limited");
    expect(await rejection(() => stripe.createAccount({ sellerId: "s1", country: "DE", idempotencyKey: "seller-s1" }))).toBe("rate_limited");
    expect((await stripe.createAccount({ sellerId: "s1", country: "DE", idempotencyKey: "seller-s1" })).accountId).toMatch(/^acct_/);
    expect(stripe.calls.map((c) => c.method)).toEqual(["createAccount", "createAccount", "createAccount"]);
  });

  it("emits events the parser reads: every event it makes is one a real endpoint could be sent", async () => {
    const { stripe, accountId, sessionId } = await enabled();
    stripe.touch(accountId);
    stripe.submitForReview(accountId);
    stripe.requireInformation(accountId, ["x"]);
    stripe.disable(accountId, "rejected.fraud");
    stripe.completeOnboarding(accountId);
    const { chargeId } = stripe.pay(sessionId);
    await stripe.createRefund({ chargeId, amount: 1_000, orderId: "0a000000-0000-4000-8000-000000000001", idempotencyKey: "refund-0001-key" });
    const dispute = stripe.openDispute(chargeId, 500);
    stripe.updateDispute(dispute, "under_review");
    stripe.closeDispute(dispute, "won");
    stripe.settleBalances();
    stripe.reverseTransfer(chargeId, 100);
    const payout = stripe.payout(accountId, "usd", 1_000);
    stripe.settlePayout(payout);
    stripe.failPayout(payout);
    const events = stripe.takeEvents();
    expect(events.length).toBeGreaterThanOrEqual(15);
    for (const event of events) {
      const parsed = parseStripeEvent(event);
      expect(parsed.ok, JSON.stringify(event)).toBe(true);
      expect(parsed.ok && parsed.value.fact.kind).not.toBe("ignored");
    }
    expect(new Set(events.map((e) => e["id"])).size).toBe(events.length);
    expect(stripe.takeEvents()).toEqual([]);
  });
});
