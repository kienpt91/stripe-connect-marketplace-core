import { describe, expect, it } from "vitest";
import { ingestEvent, retryDeferred } from "../../src/application/ingest.js";
import { startCheckout } from "../../src/application/checkout.js";
import { requestRefund } from "../../src/application/refunds.js";
import type { Database, PaymentRecord, Tx } from "../../src/application/store.js";
import { saleEntry, type Entry } from "../../src/domain/ledger.js";
import { asId } from "../../src/domain/ids.js";
import { checkoutRequest, deliver, deliverAll, enabledSeller, handCharge, sale, sessionOf, type World } from "../support/world.js";
import { ACCT, disputeObject, event, payoutObject, refundObject, transferObject } from "../support/stripe-fixtures.js";
import { accountsOf, asSeller, entriesOf, eventOf, objectOf, operator, orderOf, paymentOf, sellerBalance, sharedDb, system, type DbFactory } from "./support.js";

const statuses = (results: readonly { status: string }[]): string[] => results.map((r) => r.status);

/** A database that fails the nth ledger write, to show that nothing of an event survives a failure half way. */
function failingOnPost(db: Database, nth: number): Database {
  let posts = 0;
  return {
    ping: () => db.ping(),
    transaction: (actor, work) =>
      db.transaction(actor, (tx: Tx) =>
        work(
          Object.create(tx, {
            ledger: { value: { ...tx.ledger, post: (entry: Entry, eventId: string | null) => (++posts === nth ? Promise.reject(new Error("the disk is full")) : tx.ledger.post(entry, eventId)) } },
          }) as Tx,
        ),
      ),
  };
}

export function webhookScenarios(open: DbFactory): void {
  describe("webhook ingestion", () => {
    const world = sharedDb(open);

    async function refund(w: World, seller: { id: string }, orderId: string, amount: number, key: string): Promise<string> {
      const r = await requestRefund(w.deps, asSeller(seller as never), { orderId, amount, idempotencyKey: key });
      if (!r.ok) throw new Error(r.error);
      return r.value.refundId;
    }

    /** A refund asked of Stripe directly, for a charge the ledger has not been told about yet. */
    async function stripeRefund(w: World, chargeId: string, orderId: string, amount: number, key: string): Promise<string> {
      return (await w.stripe.createRefund({ chargeId, amount, orderId, idempotencyKey: key })).refundId;
    }

    it("follows a sale, a partial refund, a dispute that is won and a payout to the cent", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const { checkout, chargeId } = await sale(w, seller, 10_000);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 });
      expect(await orderOf(w, checkout.orderId)).toMatchObject({ status: "paid", chargeId });
      expect(await paymentOf(w, chargeId)).toMatchObject({ amount: 10_000, fee: 1_030, refunded: 0, reversed: 0, reversedFee: 0, anomaly: null, accountId: seller.accountId });

      await refund(w, seller, checkout.orderId, 2_500, "refund-0000001");
      expect(statuses(await deliverAll(w))).toEqual(["applied", "applied"]); // transfer.reversed, refund.created
      // 1030 * 2500 / 10000 = 257.5 -> the platform gives back 257, the seller 2243
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 - 2_243 });
      expect(await paymentOf(w, chargeId)).toMatchObject({ refunded: 2_500, reversed: 2_500, reversedFee: 257 });
      expect((await orderOf(w, checkout.orderId))?.status).toBe("partially_refunded");

      const dispute = w.stripe.openDispute(chargeId, 7_500);
      expect(statuses(await deliverAll(w))).toEqual(["applied"]);
      expect((await accountsOf(w, seller))["usd/disputed_funds"]).toBe(7_500);
      w.stripe.closeDispute(dispute, "won");
      await deliverAll(w);
      expect((await accountsOf(w, seller))["usd/disputed_funds"]).toBe(0);

      w.stripe.settleBalances();
      const payout = w.stripe.payout(seller.accountId, "usd", 6_000);
      await deliverAll(w);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 727 });
      w.stripe.settlePayout(payout);
      await deliverAll(w);

      expect(await accountsOf(w, seller)).toEqual({ "usd/stripe_funds": 1_500, "usd/seller_balance": 727, "usd/platform_fees": 773, "usd/disputed_funds": 0 });
      const keys = (await entriesOf(w, seller)).map((e) => e.postingKey);
      expect(keys).toEqual([`sale:${chargeId}`, expect.stringMatching(/^refund:re_/), expect.stringMatching(/^dispute:du_.*:open$/), expect.stringMatching(/^dispute:du_.*:won$/), expect.stringMatching(/^payout:po_/)]);
      expect(await objectOf(w, "payout", payout)).toMatchObject({ status: "paid", rank: 3 });
    });

    it("applies a duplicate delivery once and answers it without calling Stripe again", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      w.stripe.pay(sessionOf(started.value));
      w.stripe.touch(seller.accountId);
      const events = w.stripe.takeEvents();
      expect(statuses(await deliver(w, events))).toEqual(["applied", "applied", "applied"]);
      const before = { balance: await sellerBalance(w, seller), reads: w.stripe.calls.filter((c) => c.method === "retrieveAccount").length };
      const again = await deliver(w, events);
      expect(statuses(again)).toEqual(["duplicate", "duplicate", "duplicate"]);
      expect(await sellerBalance(w, seller)).toEqual(before.balance);
      expect(w.stripe.calls.filter((c) => c.method === "retrieveAccount")).toHaveLength(before.reads);
      expect(await entriesOf(w, seller)).toHaveLength(1);
    });

    it("applies a charge once when the same event is delivered eight times at the same moment", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      w.stripe.pay(sessionOf(started.value));
      const [charge] = w.stripe.takeEvents();
      const results = await Promise.all(Array.from({ length: 8 }, () => ingestEvent(w.deps, charge)));
      expect(results.filter((r) => r.status === "applied")).toHaveLength(1);
      expect(results.filter((r) => r.status === "duplicate")).toHaveLength(7);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 });
      expect((await entriesOf(w, seller)).filter((e) => e.kind === "sale")).toHaveLength(1);
    });

    it("holds a refund, a transfer and a dispute that arrive before their charge and applies them when it comes", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const { checkout, chargeId } = await sale(w, seller, 10_000);

      // a second sale whose whole history is delivered backwards
      const second = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!second.ok) throw new Error("checkout");
      const { chargeId: charge2 } = w.stripe.pay(sessionOf(second.value));
      await stripeRefund(w, charge2, second.value.orderId, 2_500, "refund-0000002");
      const dispute = w.stripe.openDispute(charge2, 7_500);
      w.stripe.closeDispute(dispute, "won");
      const events = w.stripe.takeEvents();
      const backwards = [...events].reverse();
      const results = await deliver(w, backwards);
      expect(results.at(-1)?.status).toBe("applied"); // the charge came last
      expect(results.slice(0, -1).every((r) => r.status === "deferred")).toBe(true);
      expect(results.slice(0, -1).map((r) => r.reason).every((r) => r === `waiting for ${charge2}`)).toBe(true);

      const waiting = await w.db.transaction(system, (tx) => tx.events.listDeferred());
      expect(waiting.filter((e) => e.subject === charge2)).toEqual([]);
      expect(await paymentOf(w, charge2)).toMatchObject({ refunded: 2_500, reversed: 2_500, reversedFee: 257 });
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 * 2 - 2_243 });
      expect((await orderOf(w, second.value.orderId))?.status).toBe("partially_refunded");
      expect(await objectOf(w, "dispute", dispute)).toMatchObject({ status: "won", rank: 2 });
      expect((await accountsOf(w, seller))["usd/disputed_funds"]).toBe(0);
      expect(checkout.orderId).not.toBe(second.value.orderId);
      expect(chargeId).not.toBe(charge2);
    });

    it("drops the stored payload of an event once it has been applied, and keeps it while the event is waiting", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      const { chargeId } = w.stripe.pay(sessionOf(started.value));
      await stripeRefund(w, chargeId, started.value.orderId, 1_000, "refund-0000003");
      const [charge, , reversed, created] = w.stripe.takeEvents();
      const [first] = await deliver(w, [created]);
      expect(first?.status).toBe("deferred");
      const waiting = await eventOf(w, (created as { id: string }).id);
      expect(waiting?.payload).toMatchObject({ type: "refund.created" });
      await deliver(w, [charge, reversed]);
      expect(await eventOf(w, (created as { id: string }).id)).toBeUndefined();
      const rows = await w.db.transaction(operator, (tx) => tx.events.count());
      expect(rows).toBeGreaterThanOrEqual(4);
      expect(await paymentOf(w, chargeId)).toMatchObject({ refunded: 1_000 });
    });

    it("books a payout once whichever of its events comes first, and does not book one that failed before it was seen", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      await sale(w, seller, 10_000);
      w.stripe.settleBalances();
      const p1 = w.stripe.payout(seller.accountId, "usd", 3_000);
      w.stripe.settlePayout(p1);
      const [created1, paid1] = w.stripe.takeEvents();
      expect(statuses(await deliver(w, [paid1, created1, paid1]))).toEqual(["applied", "stale", "duplicate"]);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 5_970 });

      const p2 = w.stripe.payout(seller.accountId, "usd", 2_000);
      w.stripe.failPayout(p2);
      const [created2, failed2] = w.stripe.takeEvents();
      expect(statuses(await deliver(w, [failed2, created2]))).toEqual(["applied", "stale"]);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 5_970 }); // it never left, so nothing to put back
      expect(await objectOf(w, "payout", p2)).toMatchObject({ status: "failed", rank: 4 });
    });

    it("puts the money back when a payout that was booked fails afterwards, even one that was shown as paid", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      await sale(w, seller, 10_000);
      w.stripe.settleBalances();
      const payout = w.stripe.payout(seller.accountId, "usd", 8_970);
      w.stripe.settlePayout(payout);
      await deliverAll(w);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 0 });
      w.stripe.failPayout(payout);
      expect(statuses(await deliverAll(w))).toEqual(["applied"]);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 });
      const keys = (await entriesOf(w, seller)).map((e) => e.postingKey);
      expect(keys.filter((k) => k.includes("po_"))).toHaveLength(2);
      expect(keys.some((k) => k.endsWith(":reversal"))).toBe(true);
    });

    it("takes a refund that succeeded and failed afterwards back out of the ledger, and ignores a late `succeeded` after `failed`", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const { checkout, chargeId } = await sale(w, seller, 10_000);
      w.stripe.nextRefundStatus = "pending";
      const refundId = await refund(w, seller, checkout.orderId, 4_000, "refund-0000004");
      expect(statuses(await deliverAll(w))).toEqual(["applied"]); // pending: recorded, nothing moved
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 });
      w.stripe.settleRefund(refundId, "succeeded");
      const [succeeded] = [...w.stripe.takeEvents()].filter((e) => (e as { type: string }).type === "refund.updated");
      await deliver(w, [succeeded]);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 - (4_000 - 412) });
      expect((await orderOf(w, checkout.orderId))?.status).toBe("partially_refunded");

      w.stripe.failRefund(refundId);
      const [failed] = w.stripe.takeEvents();
      expect((await deliver(w, [failed]))[0]?.status).toBe("applied");
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 });
      expect(await paymentOf(w, chargeId)).toMatchObject({ refunded: 0, reversed: 0, reversedFee: 0 });
      expect((await orderOf(w, checkout.orderId))?.status).toBe("paid");
      // the succeeded event arrives again, late: the refund is final in its failed state
      expect((await deliver(w, [event("refund.updated", refundObject({ id: refundId, amount: 4_000, charge: chargeId, status: "succeeded" }))]))[0]).toMatchObject({ status: "stale" });
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 });
    });

    it("never books a refund that failed before it succeeded", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const { checkout } = await sale(w, seller, 10_000);
      w.stripe.nextRefundStatus = "pending";
      await refund(w, seller, checkout.orderId, 1_000, "refund-0000005");
      const [pending] = w.stripe.takeEvents();
      const refundId = (pending as { data: { object: { id: string } } }).data.object.id;
      w.stripe.settleRefund(refundId, "failed");
      const [failed] = w.stripe.takeEvents();
      expect(statuses(await deliver(w, [failed, pending]))).toEqual(["applied", "stale"]);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 });
    });

    it("handles a dispute: an inquiry moves nothing, an open dispute is held aside, a lost one is charged to seller and platform", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const { chargeId } = await sale(w, seller, 10_000);
      const inquiry = event("charge.dispute.created", disputeObject({ id: "du_1Inquiry0001", charge: chargeId, amount: 10_000, status: "warning_needs_response" }));
      expect((await deliver(w, [inquiry]))[0]?.status).toBe("applied");
      expect((await accountsOf(w, seller))["usd/disputed_funds"]).toBe(0);
      const escalated = event("charge.dispute.updated", disputeObject({ id: "du_1Inquiry0001", charge: chargeId, amount: 10_000, status: "needs_response" }));
      await deliver(w, [escalated]);
      expect((await accountsOf(w, seller))["usd/disputed_funds"]).toBe(10_000);
      const lost = event("charge.dispute.closed", disputeObject({ id: "du_1Inquiry0001", charge: chargeId, amount: 10_000, status: "lost" }));
      await deliver(w, [lost]);
      expect(await accountsOf(w, seller)).toEqual({ "usd/stripe_funds": 0, "usd/seller_balance": 0, "usd/platform_fees": 0, "usd/disputed_funds": 0 });
      expect(await paymentOf(w, chargeId)).toMatchObject({ reversed: 10_000, reversedFee: 1_030, refunded: 0 });
      // a contradicting close and the opening event arriving late change nothing
      const contradicting = event("charge.dispute.closed", disputeObject({ id: "du_1Inquiry0001", charge: chargeId, amount: 10_000, status: "won" }));
      const late = event("charge.dispute.created", disputeObject({ id: "du_1Inquiry0001", charge: chargeId, amount: 10_000, status: "needs_response" }));
      expect(await deliver(w, [contradicting, late])).toMatchObject([{ status: "stale", reason: "conflicting_close" }, { status: "stale" }]);
      expect((await accountsOf(w, seller))["usd/seller_balance"]).toBe(0);
    });

    it("books a dispute whose closing event comes before its opening event as opened and closed", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const { chargeId } = await sale(w, seller, 10_000);
      const open = event("charge.dispute.created", disputeObject({ id: "du_1Backwards01", charge: chargeId, amount: 10_000, status: "needs_response" }));
      const won = event("charge.dispute.closed", disputeObject({ id: "du_1Backwards01", charge: chargeId, amount: 10_000, status: "won" }));
      expect(statuses(await deliver(w, [won, open]))).toEqual(["applied", "stale"]);
      expect((await accountsOf(w, seller))["usd/stripe_funds"]).toBe(10_000);
      const keys = (await entriesOf(w, seller)).map((e) => e.postingKey).filter((k) => k.startsWith("dispute"));
      expect(keys).toEqual(["dispute:du_1Backwards01:open", "dispute:du_1Backwards01:won"]);
    });

    it("records a transfer, lets its reversal grow, and ignores a transfer that is not for a destination charge", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const { chargeId, transferId } = await sale(w, seller, 10_000);
      expect(await objectOf(w, "transfer", transferId)).toMatchObject({ amount: 8_970, secondaryAmount: 0, accountId: seller.accountId, chargeId, status: "created" });
      const reversed = (n: number) => event("transfer.reversed", transferObject({ id: transferId, amount: 8_970, amount_reversed: n, source_transaction: chargeId, destination: seller.accountId }));
      expect(statuses(await deliver(w, [reversed(400), reversed(200), reversed(900)]))).toEqual(["applied", "stale", "applied"]);
      expect(await objectOf(w, "transfer", transferId)).toMatchObject({ secondaryAmount: 900, status: "reversed" });
      expect((await deliver(w, [event("transfer.created", transferObject({ id: "tr_1Manual00001", source_transaction: null, destination: seller.accountId }))]))[0]).toMatchObject({ status: "ignored", reason: "not_a_marketplace_transfer" });
      expect((await deliver(w, [event("transfer.updated", transferObject({ id: transferId, amount: 9_000, source_transaction: chargeId, destination: seller.accountId }))]))[0]).toMatchObject({ status: "rejected", reason: "object_changed" });
      expect((await deliver(w, [event("transfer.created", transferObject({ id: "tr_1Euros000001", currency: "eur", source_transaction: chargeId, destination: seller.accountId }))]))[0]).toMatchObject({ status: "rejected", reason: "currency_mismatch" });
    });

    it("rejects a charge that pays another account than the order's seller, books nothing and keeps the event for a person", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const other = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      w.stripe.pay(sessionOf(started.value), { destination: other.accountId });
      const results = await deliverAll(w);
      expect(results[0]).toMatchObject({ status: "rejected", reason: "destination_mismatch" });
      expect(await sellerBalance(w, seller)).toEqual({});
      expect(await sellerBalance(w, other)).toEqual({});
      expect((await orderOf(w, started.value.orderId))?.status).toBe("awaiting_payment");
      const flagged = (await w.db.transaction(operator, (tx) => tx.events.flagged())).filter((f) => f.id === results[0]?.eventId);
      expect(flagged).toMatchObject([{ status: "rejected", reason: "destination_mismatch", type: "charge.succeeded" }]);
      // the transfer Stripe made for that charge has no sale to belong to: it waits, and reconciliation reports it once it has waited long enough
      expect((await w.db.transaction(system, (tx) => tx.events.listDeferred())).map((e) => e.type)).toContain("transfer.created");
    });

    it("books what Stripe took even when it differs from the order, and flags the difference", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      const order = { id: started.value.orderId, amount: 10_000, fee: 1_030 };
      const short = handCharge(seller, order, { amount: 9_900, application_fee_amount: 1_020 });
      expect((await deliver(w, [short]))[0]).toMatchObject({ status: "applied", reason: "charged 9900 usd, the order was 10000 usd; application fee 1020, the order was 1030" });
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_880 });
      const chargeId = (short as { data: { object: { id: string } } }).data.object.id;
      expect((await paymentOf(w, chargeId))?.anomaly).toContain("the order was 10000 usd");
      // a second charge for the order that was paid already
      const double = handCharge(seller, order);
      expect((await deliver(w, [double]))[0]?.reason).toBe(`the order was already paid by ${chargeId}`);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_880 + 8_970 });
      // the fee of the order is what the platform asked for: a charge with a fee of 0 is flagged too
      const free = handCharge(seller, order, { application_fee_amount: null });
      expect((await deliver(w, [free]))[0]?.reason).toContain("application fee 0");
    });

    it("rejects a charge whose fee leaves the seller nothing, without booking it", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      const greedy = handCharge(seller, { id: started.value.orderId, amount: 10_000, fee: 10_000 });
      expect((await deliver(w, [greedy]))[0]).toMatchObject({ status: "rejected", reason: "fee_not_below_amount" });
      expect(await sellerBalance(w, seller)).toEqual({});
    });

    it("ignores what is not the marketplace's: a charge without a known order, an unknown event type, an unknown account", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const order = { id: "0a000000-0000-4000-8000-0000000000ff", amount: 1_000, fee: 100 };
      const noOrder = handCharge(seller, order);
      const noMetadata = handCharge(seller, order, { metadata: {} });
      const badMetadata = handCharge(seller, order, { metadata: { order_id: "not a uuid" } });
      const other = event("customer.created", { id: "cus_1Whatever001" });
      const payout = event("payout.paid", payoutObject({ status: "paid" }), { account: "acct_1Unknown0001" });
      const account = event("account.updated", { id: "acct_1Unknown0001", charges_enabled: true, payouts_enabled: true, details_submitted: true }, { account: "acct_1Unknown0001" });
      w.stripe.touch(seller.accountId);
      const result = await deliver(w, [noOrder, noMetadata, badMetadata, other, payout]);
      expect(result.map((r) => `${r.status}:${r.reason}`)).toEqual([
        "ignored:not_a_marketplace_charge", "ignored:not_a_marketplace_charge", "ignored:not_a_marketplace_charge", "ignored:unhandled_event_type", "ignored:unknown_account",
      ]);
      // an account Stripe knows and the marketplace does not: the account is read from Stripe, which does not know it either
      await expect(deliver(w, [account])).rejects.toMatchObject({ code: "not_found" });
      expect(await entriesOf(w, seller)).toEqual([]);
    });

    it("records an event it cannot read as rejected when it has an id, and only logs it when it has none", async () => {
      const w = world();
      const broken = event("refund.created", { id: "re_1Broken00001", amount: "lots", charge: "ch_1Whatever001" });
      const first = await ingestEvent(w.deps, broken);
      expect(first).toMatchObject({ status: "rejected", reason: "malformed_object" });
      expect((await ingestEvent(w.deps, broken)).status).toBe("duplicate");
      expect((await w.db.transaction(operator, (tx) => tx.events.flagged())).filter((f) => f.id === (broken as { id: string }).id)).toMatchObject([{ status: "rejected" }]);
      const noId = await ingestEvent(w.deps, { type: "refund.created", data: {} });
      expect(noId).toEqual({ status: "rejected", eventId: null, reason: "malformed_event" });
      expect(await ingestEvent(w.deps, "text")).toEqual({ status: "rejected", eventId: null, reason: "malformed_event" });
      expect(await ingestEvent(w.deps, { id: "evt_1NoTypeEvent", data: {} })).toMatchObject({ status: "rejected", reason: "malformed_event" });
      expect(w.logs.filter((l) => l.event === "webhook.unreadable").length).toBeGreaterThanOrEqual(3);
    });

    it("refuses a refund or a dispute that is more than the charge, or in another currency, or that changed after it was first seen", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const { chargeId } = await sale(w, seller, 10_000);
      const re = (patch: Record<string, unknown>) => event("refund.created", refundObject({ charge: chargeId, ...patch }));
      expect((await deliver(w, [re({ id: "re_1TooMuch0001", amount: 10_001 })]))[0]).toMatchObject({ status: "rejected", reason: "refund_exceeds_charge" });
      expect((await deliver(w, [re({ id: "re_1Euros000001", currency: "eur" })]))[0]).toMatchObject({ status: "rejected", reason: "currency_mismatch" });
      expect((await deliver(w, [re({ id: "re_1Original001", amount: 6_000 })]))[0]?.status).toBe("applied");
      expect((await deliver(w, [re({ id: "re_1Second00001", amount: 4_001 })]))[0]).toMatchObject({ status: "rejected", reason: "refund_exceeds_charge" });
      expect((await deliver(w, [event("refund.updated", refundObject({ id: "re_1Original001", charge: chargeId, amount: 5_000, status: "failed" }))]))[0]).toMatchObject({ status: "rejected", reason: "object_changed" });
      expect((await deliver(w, [event("charge.dispute.created", disputeObject({ id: "du_1TooMuch0001", charge: chargeId, amount: 10_001 }))]))[0]).toMatchObject({ status: "rejected", reason: "dispute_exceeds_charge" });
      expect((await deliver(w, [event("charge.dispute.created", disputeObject({ id: "du_1Euros000001", charge: chargeId, currency: "eur" }))]))[0]).toMatchObject({ status: "rejected", reason: "currency_mismatch" });
      const lost = event("charge.dispute.closed", disputeObject({ id: "du_1AfterRefund", charge: chargeId, amount: 4_001, status: "lost" }));
      expect((await deliver(w, [lost]))[0]).toMatchObject({ status: "rejected", reason: "dispute_exceeds_charge" });
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 - (6_000 - 618) });
      const changed = event("charge.dispute.updated", disputeObject({ id: "du_1Original001", charge: chargeId, amount: 1_000 }));
      await deliver(w, [changed]);
      expect((await deliver(w, [event("charge.dispute.updated", disputeObject({ id: "du_1Original001", charge: chargeId, amount: 2_000, status: "under_review" }))]))[0]).toMatchObject({ status: "rejected", reason: "object_changed" });
      expect((await deliver(w, [event("payout.created", payoutObject({ id: "po_1Original001", amount: 100 }), { account: seller.accountId })]))[0]?.status).toBe("applied");
      expect((await deliver(w, [event("payout.paid", payoutObject({ id: "po_1Original001", amount: 200, status: "paid" }), { account: seller.accountId })]))[0]).toMatchObject({ status: "rejected", reason: "object_changed" });
    });

    it("leaves nothing behind when the application fails half way: no event row, no entry, and the retry applies it", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      w.stripe.pay(sessionOf(started.value));
      const [charge] = w.stripe.takeEvents();
      const broken = { ...w.deps, db: failingOnPost(w.db, 1) };
      await expect(ingestEvent(broken, charge)).rejects.toThrow("the disk is full");
      expect(await w.db.transaction(system, (tx) => tx.events.exists((charge as { id: string }).id))).toBe(false);
      expect(await entriesOf(w, seller)).toEqual([]);
      expect((await orderOf(w, started.value.orderId))?.status).toBe("awaiting_payment");
      expect((await ingestEvent(w.deps, charge)).status).toBe("applied");
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 });
    });

    it("does not record an `account.updated` event when Stripe cannot be reached, so Stripe's retry is processed", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      w.stripe.requireInformation(seller.accountId, ["external_account"]);
      const [updated] = w.stripe.takeEvents();
      w.stripe.injectFailure("retrieveAccount", new (await import("../../src/application/ports.js")).GatewayError("unavailable", "down"));
      await expect(ingestEvent(w.deps, updated)).rejects.toMatchObject({ code: "unavailable" });
      expect(await w.db.transaction(system, (tx) => tx.events.exists((updated as { id: string }).id))).toBe(false);
      expect((await ingestEvent(w.deps, updated)).status).toBe("applied");
    });

    it("refuses to apply an account that is not the one the event names", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const other = await enabledSeller(w);
      w.stripe.touch(seller.accountId);
      const [updated] = w.stripe.takeEvents();
      const gateway = Object.create(w.stripe) as typeof w.stripe;
      gateway.retrieveAccount = async () => w.stripe.retrieveAccount(other.accountId);
      await expect(ingestEvent({ ...w.deps, stripe: gateway }, updated)).rejects.toMatchObject({ code: "unknown" });
    });

    it("applies waiting events again on request, when their charge was recorded some other way", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      const { chargeId } = w.stripe.pay(sessionOf(started.value));
      await stripeRefund(w, chargeId, started.value.orderId, 1_000, "refund-0000006");
      const events = w.stripe.takeEvents().filter((e) => (e as { type: string }).type !== "charge.succeeded");
      expect(statuses(await deliver(w, events))).toEqual(["deferred", "deferred", "deferred"]);
      expect(await retryDeferred(w.deps)).toBe(0);
      // an operator restores the sale by hand
      const payment: PaymentRecord = {
        chargeId, orderId: started.value.orderId, sellerId: seller.id, accountId: seller.accountId, currency: "usd", amount: 10_000, fee: 1_030,
        refunded: 0, reversed: 0, reversedFee: 0, anomaly: null, createdAt: w.clock.now(),
      };
      await w.db.transaction(system, async (tx) => {
        await tx.payments.insert(payment);
        await tx.ledger.post(saleEntry({ chargeId, sellerId: seller.id, currency: "usd", amount: 10_000, fee: 1_030, occurredAt: payment.createdAt }), null);
      });
      expect(await retryDeferred(w.deps)).toBe(3);
      expect(await retryDeferred(w.deps)).toBe(0);
      expect(await sellerBalance(w, seller)).toEqual({ usd: 8_970 - (1_000 - 103) });
      expect(await paymentOf(w, chargeId)).toMatchObject({ refunded: 1_000 });
    });

    it("reads a waiting event that was stored damaged as rejected instead of looping on it", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
      if (!started.ok) throw new Error("checkout");
      const { chargeId } = w.stripe.pay(sessionOf(started.value));
      await w.db.transaction(system, (tx) => tx.events.insert({ id: "evt_1Damaged0001", type: "refund.created", account: null, subject: chargeId, receivedAt: 1, status: "deferred", reason: "waiting", payload: { id: "evt_1Damaged0001" } }));
      await deliverAll(w);
      expect((await w.db.transaction(system, (tx) => tx.events.listDeferred())).filter((e) => e.subject === chargeId)).toEqual([]);
      expect((await w.db.transaction(operator, (tx) => tx.events.flagged())).map((f) => f.id)).toContain("evt_1Damaged0001");
    });

    it("keeps the account id of a connected account out of the way of platform events", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const refundEvent = event("refund.created", refundObject({ charge: "ch_1Nothing0001" }), { account: seller.accountId });
      expect((await deliver(w, [refundEvent]))[0]).toMatchObject({ status: "deferred" });
      expect(ACCT).toMatch(/^acct_/);
      expect(asId<"SellerId">(seller.id)).toBe(seller.id);
    });
  });
}
