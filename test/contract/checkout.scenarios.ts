import { describe, expect, it } from "vitest";
import { startCheckout, type CheckoutError } from "../../src/application/checkout.js";
import { GatewayError } from "../../src/application/ports.js";
import { registerSeller } from "../../src/application/sellers.js";
import { checkoutRequest, deliverAll, enabledSeller, sale, sellerUuid, sessionOf } from "../support/world.js";
import { accountsOf, operator, orderOf, sharedDb, system, type DbFactory } from "./support.js";

export function checkoutScenarios(open: DbFactory): void {
  describe("checkout with a destination charge", () => {
    const world = sharedDb(open);
    const ordersOf = async (w: ReturnType<typeof world>, sellerId: string) => w.db.transaction(operator, (tx) => tx.orders.listForSeller(sellerId as never));

    it("creates the order and the session with the fee computed by the platform, in integers", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const result = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!result.ok) throw new Error(result.error);
      expect(result.value).toMatchObject({ amount: 10_000, currency: "usd", fee: 1_030, sellerNet: 8_970, replayed: false });
      expect(result.value.checkoutUrl).toMatch(/^https:\/\/checkout\.fake\.invalid\/pay\/cs_/);
      const call = w.stripe.calls.find((c) => c.method === "createCheckoutSession")?.input as Record<string, unknown>;
      expect(call).toMatchObject({
        orderId: result.value.orderId, accountId: seller.accountId, amount: 10_000, currency: "usd", applicationFee: 1_030,
        successUrl: "https://market.example/orders/done", cancelUrl: "https://market.example/orders/cancelled", idempotencyKey: `order-${result.value.orderId}`,
      });
      const order = await orderOf(w, result.value.orderId);
      expect(order).toMatchObject({ sellerId: seller.id, amount: 10_000, fee: 1_030, status: "awaiting_payment", buyerRef: "buyer-1001" });
      expect(order?.sessionId).toBe(sessionOf(result.value));
    });

    it("rounds the fee half up to a whole minor unit and never hands Stripe a fraction", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      for (const [amount, fee] of [[100, 40], [105, 41], [333, 63], [1_001, 130], [1_005, 131], [99_999_999, 10_000_030]] as const) {
        const result = await startCheckout(w.deps, checkoutRequest(seller, amount));
        expect(result.ok && result.value.fee, String(amount)).toBe(fee);
      }
      for (const call of w.stripe.calls.filter((c) => c.method === "createCheckoutSession")) {
        const input = call.input as { amount: number; applicationFee: number };
        expect(Number.isSafeInteger(input.amount) && Number.isSafeInteger(input.applicationFee)).toBe(true);
      }
    });

    it("applies one fee policy in the minor unit of whichever currency is charged: the fixed fee and the minimum are not currency-aware", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const outcome = async (amount: number, currency: string) => {
        const result = await startCheckout(w.deps, checkoutRequest(seller, amount, { currency }));
        return result.ok ? result.value.fee : result.error;
      };
      // 10 %, 30 and 100 minor units: 0.30 and 1.00 where a currency has cents, but 30 and 100 whole yen where it has none
      expect(await outcome(1_000, "usd")).toBe(130); // 1.30 of 10.00 USD
      expect(await outcome(1_000, "jpy")).toBe(130); // 130 of 1,000 JPY: the same number, a different amount of money
      expect(await outcome(99, "usd")).toBe("amount_below_minimum"); // 0.99 USD
      expect(await outcome(99, "jpy")).toBe("amount_below_minimum"); // 99 JPY
      expect(await outcome(100, "jpy")).toBe(40); // 10 + 30 yen of 100 yen

      // the sale is booked in yen, as charged
      await sale(w, seller, 1_000, { currency: "jpy" });
      expect(await accountsOf(w, seller)).toEqual({ "jpy/stripe_funds": 1_000, "jpy/seller_balance": 870, "jpy/platform_fees": 130, "jpy/disputed_funds": 0 });
    });

    it("refuses an amount that is not a whole, allowed number of minor units, without touching the database or Stripe", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const calls = w.stripe.calls.length;
      const cases: [unknown, CheckoutError][] = [
        [0, "invalid_amount"], [-100, "invalid_amount"], [10.5, "invalid_amount"], [0.1 + 0.2, "invalid_amount"], ["10000", "invalid_amount"], [null, "invalid_amount"],
        [NaN, "invalid_amount"], [Infinity, "invalid_amount"], [2 ** 53, "invalid_amount"], [99, "amount_below_minimum"], [100_000_000, "amount_above_maximum"],
      ];
      for (const [amount, error] of cases) expect(await startCheckout(w.deps, checkoutRequest(seller, 0, { amount })), String(amount)).toEqual({ ok: false, error });
      expect(w.stripe.calls).toHaveLength(calls);
      expect(await ordersOf(w, seller.id)).toEqual([]);
    });

    it("refuses a fee that would leave the seller nothing", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const greedy = { ...w.deps, fees: { percentBps: 9_000, fixedMinor: 20, minimumChargeMinor: 100 } };
      expect(await startCheckout(greedy, checkoutRequest(seller, 120))).toEqual({ ok: false, error: "fee_not_below_amount" });
      expect((await startCheckout(greedy, checkoutRequest(seller, 300))).ok).toBe(true);
    });

    it("has no way for the caller to set the fee: an extra field in the request is ignored", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const request = { ...checkoutRequest(seller, 10_000), fee: 1, applicationFee: 1, application_fee_amount: 1 };
      const result = await startCheckout(w.deps, request);
      expect(result.ok && result.value.fee).toBe(1_030);
    });

    it("sells only for a seller whose account is enabled", async () => {
      const w = world();
      const reg = await registerSeller(w.deps, { sellerId: sellerUuid(), displayName: "New Seller", country: "DE" });
      if (!reg.ok) throw new Error("register");
      const states: [string, () => void][] = [
        ["new", () => undefined],
        ["requirements_due", () => w.stripe.touch(reg.value.accountId)],
        ["pending_review", () => w.stripe.submitForReview(reg.value.accountId)],
        ["enabled, then restricted", () => w.stripe.completeOnboarding(reg.value.accountId)],
        ["restricted", () => w.stripe.requireInformation(reg.value.accountId, ["external_account"])],
        ["held by Stripe", () => w.stripe.disable(reg.value.accountId, "under_review")],
        ["rejected", () => w.stripe.disable(reg.value.accountId, "rejected.fraud")],
      ];
      for (const [name, act] of states) {
        act();
        await deliverAll(w);
        const state = (await w.db.transaction(system, (tx) => tx.sellers.get(reg.value.id)))?.state;
        if (name === "enabled, then restricted") {
          // enabled: a checkout works, and then the account loses its standing in the next steps
          expect(state).toBe("enabled");
          expect((await startCheckout(w.deps, checkoutRequest(reg.value, 10_000))).ok).toBe(true);
          continue;
        }
        expect(await startCheckout(w.deps, checkoutRequest(reg.value, 10_000)), `${name} (${state})`).toEqual({ ok: false, error: "seller_not_enabled" });
      }
      expect(w.stripe.calls.filter((c) => c.method === "createCheckoutSession")).toHaveLength(1);
      expect(await startCheckout(w.deps, checkoutRequest({ id: sellerUuid() } as never, 10_000))).toEqual({ ok: false, error: "seller_not_found" });
    });

    it("refuses malformed fields before anything is written", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const bad: [Record<string, unknown>, CheckoutError][] = [
        [{ sellerId: "nope" }, "invalid_seller_id"], [{ sellerId: undefined }, "invalid_seller_id"],
        [{ buyerRef: "" }, "invalid_buyer_ref"], [{ buyerRef: "a b" }, "invalid_buyer_ref"], [{ buyerRef: "x".repeat(101) }, "invalid_buyer_ref"], [{ buyerRef: 5 }, "invalid_buyer_ref"],
        [{ currency: "USD" }, "invalid_currency"], [{ currency: "btc" }, "invalid_currency"], [{ currency: undefined }, "invalid_currency"],
        [{ description: "" }, "invalid_description"], [{ description: "a\nb" }, "invalid_description"], [{ description: "x".repeat(201) }, "invalid_description"], [{ description: 7 }, "invalid_description"],
        [{ idempotencyKey: "short" }, "invalid_idempotency_key"], [{ idempotencyKey: "has space in it" }, "invalid_idempotency_key"], [{ idempotencyKey: undefined }, "invalid_idempotency_key"],
        [{ successPath: "https://evil.example/x" }, "invalid_redirect"], [{ cancelPath: "//evil.example" }, "invalid_redirect"], [{ successPath: "/a\\b" }, "invalid_redirect"], [{ cancelPath: "" }, "invalid_redirect"],
      ];
      for (const [patch, error] of bad) expect(await startCheckout(w.deps, checkoutRequest(seller, 10_000, patch)), JSON.stringify(patch)).toEqual({ ok: false, error });
      expect(await ordersOf(w, seller.id)).toEqual([]);
    });

    it("treats the same idempotency key as the same order, and another request under it as a conflict", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const request = checkoutRequest(seller, 10_000);
      const first = await startCheckout(w.deps, request);
      const second = await startCheckout(w.deps, request);
      if (!first.ok || !second.ok) throw new Error("checkout");
      expect(second.value).toMatchObject({ orderId: first.value.orderId, checkoutUrl: first.value.checkoutUrl, replayed: true });
      expect(await ordersOf(w, seller.id)).toHaveLength(1);
      // Stripe was asked twice with one key and answered with one session
      const keys = w.stripe.calls.filter((c) => c.method === "createCheckoutSession").map((c) => (c.input as { idempotencyKey: string }).idempotencyKey);
      expect(keys).toEqual([`order-${first.value.orderId}`, `order-${first.value.orderId}`]);
      for (const patch of [{ amount: 10_001 }, { buyerRef: "buyer-2002" }, { description: "Something else" }, { currency: "eur" }]) {
        expect(await startCheckout(w.deps, { ...request, ...patch }), JSON.stringify(patch)).toEqual({ ok: false, error: "idempotency_conflict" });
      }
      expect(await ordersOf(w, seller.id)).toHaveLength(1);
    });

    it("keeps idempotency keys apart per seller", async () => {
      const w = world();
      const a = await enabledSeller(w);
      const b = await enabledSeller(w);
      const key = "purchase-shared-key";
      const first = await startCheckout(w.deps, checkoutRequest(a, 10_000, { idempotencyKey: key }));
      const second = await startCheckout(w.deps, checkoutRequest(b, 10_000, { idempotencyKey: key }));
      expect(first.ok && second.ok && first.value.orderId !== second.value.orderId).toBe(true);
    });

    it("creates one order and one session when ten identical requests arrive at once", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const request = checkoutRequest(seller, 25_000);
      const results = await Promise.all(Array.from({ length: 10 }, () => startCheckout(w.deps, request)));
      for (const r of results) expect(r.ok).toBe(true);
      const orderIds = new Set(results.map((r) => (r.ok ? r.value.orderId : "")));
      const urls = new Set(results.map((r) => (r.ok ? r.value.checkoutUrl : "")));
      expect(orderIds.size).toBe(1);
      expect(urls.size).toBe(1);
      expect(results.filter((r) => r.ok && !r.value.replayed)).toHaveLength(1);
      expect(await ordersOf(w, seller.id)).toHaveLength(1);
    });

    it("leaves the order waiting when Stripe fails and finishes the same order on the retry", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const request = checkoutRequest(seller, 10_000);
      w.stripe.injectFailure("createCheckoutSession", new GatewayError("unavailable", "Stripe is down"));
      expect(await startCheckout(w.deps, request)).toEqual({ ok: false, error: "gateway_failed" });
      const [waiting] = await ordersOf(w, seller.id);
      expect(waiting).toMatchObject({ status: "awaiting_payment", sessionId: null });
      const retry = await startCheckout(w.deps, request);
      if (!retry.ok) throw new Error(retry.error);
      expect(retry.value).toMatchObject({ orderId: waiting?.id, replayed: true });
      expect((await orderOf(w, retry.value.orderId))?.sessionId).toBe(sessionOf(retry.value));
      expect(w.logs.some((l) => l.event === "checkout.session_failed" && l.fields?.["code"] === "unavailable")).toBe(true);
    });

    it("surfaces an error that is not the gateway's instead of hiding it", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      w.stripe.injectFailure("createCheckoutSession", new TypeError("a bug") as never);
      await expect(startCheckout(w.deps, checkoutRequest(seller, 10_000))).rejects.toThrow("a bug");
    });

    it("will not start a checkout again for an order that has been paid", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const request = checkoutRequest(seller, 10_000);
      const first = await startCheckout(w.deps, request);
      if (!first.ok) throw new Error("checkout");
      w.stripe.pay(sessionOf(first.value));
      await deliverAll(w);
      expect(await startCheckout(w.deps, request)).toEqual({ ok: false, error: "order_not_payable" });
    });

    it("lets a seller be sold for again after a sale (the order of one seller does not block the next)", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      await sale(w, seller, 5_000);
      await sale(w, seller, 7_000);
      expect(await ordersOf(w, seller.id)).toHaveLength(2);
    });
  });
}
