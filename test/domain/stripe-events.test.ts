import { describe, expect, it } from "vitest";
import { disputeRank, handledEventTypes, parseStripeEvent, payoutRank, refundRank, DISPUTE_STATUSES, PAYOUT_STATUSES, REFUND_STATUSES } from "../../src/domain/stripe-events.js";
import { ACCT, accountObject, CHARGE, chargeObject, disputeObject, event, ORDER, payoutObject, refundObject, T0, transferObject } from "../support/stripe-fixtures.js";

const ok = (json: unknown) => {
  const r = parseStripeEvent(json);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const fails = (json: unknown) => {
  const r = parseStripeEvent(json);
  return r.ok ? "ok" : r.error;
};

describe("the envelope", () => {
  it("reads the id, type, timestamp and connected account", () => {
    const e = ok(event("charge.succeeded", chargeObject(), { id: "evt_1AbCdEfGhIj", created: 1_762_000_123, account: ACCT }));
    expect(e).toMatchObject({ id: "evt_1AbCdEfGhIj", type: "charge.succeeded", created: 1_762_000_123, account: ACCT });
  });

  it("refuses what is not an event", () => {
    for (const json of [null, undefined, "x", 5, [], {}, { id: "evt_1AbCdEfGhIj" }]) expect(fails(json), JSON.stringify(json)).toBe("malformed_event");
    expect(fails(event("charge.succeeded", chargeObject(), { id: "cus_1AbCdEfGhIj" }))).toBe("malformed_event");
    expect(fails({ ...event("charge.succeeded", chargeObject()), type: 5 })).toBe("malformed_event");
    expect(fails({ ...event("charge.succeeded", chargeObject()), type: "x".repeat(101) })).toBe("malformed_event");
    expect(fails({ ...event("charge.succeeded", chargeObject()), created: -1 })).toBe("malformed_event");
    expect(fails({ ...event("charge.succeeded", chargeObject()), created: 1.5 })).toBe("malformed_event");
    expect(fails({ ...event("charge.succeeded", chargeObject()), account: "cus_x" })).toBe("malformed_event");
    expect(fails({ ...event("charge.succeeded", chargeObject()), data: null })).toBe("malformed_event");
  });

  it("turns an event type it does not handle into an ignored fact without looking inside it", () => {
    expect(ok(event("customer.created", { garbage: true })).fact).toEqual({ kind: "ignored" });
    expect(ok(event("charge.dispute.funds_withdrawn", "not even an object")).fact).toEqual({ kind: "ignored" });
  });

  it("lists the event types it handles", () => {
    expect(handledEventTypes()).toEqual(expect.arrayContaining(["account.updated", "charge.succeeded", "refund.created", "charge.dispute.closed", "payout.paid", "transfer.reversed"]));
  });

  it("refuses a handled type whose object is missing", () => {
    expect(fails({ ...event("charge.succeeded", chargeObject()), data: {} })).toBe("malformed_object");
    expect(fails(event("charge.succeeded", [1]))).toBe("malformed_object");
  });
});

describe("account.updated", () => {
  it("carries the account id; the state is read from Stripe, not from the event", () => {
    expect(ok(event("account.updated", accountObject(), { account: ACCT })).fact).toEqual({ kind: "account_updated", accountId: ACCT });
    expect(ok(event("account.updated", accountObject())).fact).toEqual({ kind: "account_updated", accountId: ACCT });
  });

  it("refuses an object that is not an account, or an event about another account", () => {
    expect(fails(event("account.updated", accountObject({ id: "ch_1AbCdEfGhIj" })))).toBe("malformed_object");
    expect(fails(event("account.updated", accountObject(), { account: "acct_1Other0000" }))).toBe("malformed_object");
  });
});

describe("charge.succeeded", () => {
  it("reads the amount, the application fee, the destination and the order the checkout put in the metadata", () => {
    const e = ok(event("charge.succeeded", chargeObject()));
    expect(e.fact).toEqual({
      kind: "charge_succeeded",
      charge: { id: CHARGE, amount: 1000, currency: "usd", applicationFee: 130, destination: ACCT, orderId: ORDER, transferId: "tr_1TransferAaa", createdAt: T0 * 1000 },
    });
  });

  it("accepts a charge without a fee, a destination or an order, and expanded references", () => {
    const e = ok(event("charge.succeeded", chargeObject({ application_fee_amount: null, transfer_data: null, transfer: null, metadata: {} })));
    expect(e.fact).toMatchObject({ charge: { applicationFee: null, destination: null, orderId: null, transferId: null } });
    const expanded = ok(event("charge.succeeded", chargeObject({ transfer_data: { destination: { id: ACCT } }, transfer: { id: "tr_1TransferAaa" } })));
    expect(expanded.fact).toMatchObject({ charge: { destination: ACCT, transferId: "tr_1TransferAaa" } });
    const longOrder = ok(event("charge.succeeded", chargeObject({ metadata: { order_id: "x".repeat(65) } })));
    expect(longOrder.fact).toMatchObject({ charge: { orderId: null } });
  });

  it.each([
    ["a fractional amount", { amount: 10.5 }],
    ["a zero amount", { amount: 0 }],
    ["a negative amount", { amount: -5 }],
    ["an amount as a string", { amount: "1000" }],
    ["an id of another kind", { id: "re_1AbCdEfGhIj" }],
    ["a charge that did not succeed", { status: "failed" }],
    ["a fee that is not a number", { application_fee_amount: "130" }],
    ["a negative fee", { application_fee_amount: -1 }],
    ["a destination that is not an account", { transfer_data: { destination: "cus_1AbCdEfGhIj" } }],
    ["transfer data that is not an object", { transfer_data: "x" }],
    ["metadata that is not an object", { metadata: "x" }],
    ["a transfer that is not a transfer id", { transfer: "acct_1AbCdEfGhIj" }],
    ["no timestamp", { created: undefined }],
  ])("refuses %s", (_name, patch) => {
    expect(fails(event("charge.succeeded", chargeObject(patch)))).toBe("malformed_object");
  });

  it("names a currency it does not know instead of guessing the exponent", () => {
    expect(fails(event("charge.succeeded", chargeObject({ currency: "xyz" })))).toBe("unsupported_currency");
    expect(fails(event("charge.succeeded", chargeObject({ currency: "USD" })))).toBe("unsupported_currency");
  });
});

describe("refund.created, refund.updated, refund.failed", () => {
  it("reads one refund fact whichever of the three types carried it", () => {
    for (const type of ["refund.created", "refund.updated", "refund.failed"]) {
      expect(ok(event(type, refundObject())).fact).toEqual({
        kind: "refund", refund: { id: "re_1RefundAaaaa", chargeId: CHARGE, amount: 500, currency: "usd", status: "succeeded", createdAt: (T0 + 60) * 1000 },
      });
    }
  });

  it("accepts an expanded charge and every status Stripe documents", () => {
    for (const status of REFUND_STATUSES) expect(ok(event("refund.updated", refundObject({ status, charge: { id: CHARGE } }))).fact).toMatchObject({ refund: { status } });
  });

  it.each([
    ["no charge", { charge: null }],
    ["a payment intent where the charge should be", { charge: "pi_1AbCdEfGhIj" }],
    ["an unknown status", { status: "refunded" }],
    ["a zero amount", { amount: 0 }],
    ["no id", { id: undefined }],
  ])("refuses %s", (_name, patch) => {
    expect(fails(event("refund.created", refundObject(patch)))).toBe("malformed_object");
  });

  it("refuses a currency it does not know", () => {
    expect(fails(event("refund.created", refundObject({ currency: "btc" })))).toBe("unsupported_currency");
  });
});

describe("disputes", () => {
  it("reads one dispute fact from created, updated and closed", () => {
    for (const type of ["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"]) {
      expect(ok(event(type, disputeObject({ status: "won" }))).fact).toMatchObject({ kind: "dispute", dispute: { id: "du_1DisputeAaaa", chargeId: CHARGE, amount: 1000, status: "won" } });
    }
  });

  it("accepts every documented status", () => {
    for (const status of DISPUTE_STATUSES) expect(ok(event("charge.dispute.updated", disputeObject({ status }))).fact).toMatchObject({ dispute: { status } });
  });

  it("refuses a bad object", () => {
    expect(fails(event("charge.dispute.created", disputeObject({ status: "resolved" })))).toBe("malformed_object");
    expect(fails(event("charge.dispute.created", disputeObject({ charge: undefined })))).toBe("malformed_object");
    expect(fails(event("charge.dispute.created", disputeObject({ amount: 0.5 })))).toBe("malformed_object");
    expect(fails(event("charge.dispute.created", disputeObject({ currency: "zzz" })))).toBe("unsupported_currency");
  });
});

describe("payouts", () => {
  it("need the connected account the event came from", () => {
    expect(ok(event("payout.paid", payoutObject({ status: "paid" }), { account: ACCT })).fact).toEqual({
      kind: "payout", payout: { id: "po_1PayoutAaaaa", accountId: ACCT, amount: 700, currency: "usd", status: "paid", createdAt: (T0 + 180) * 1000 },
    });
    expect(fails(event("payout.paid", payoutObject({ status: "paid" })))).toBe("account_missing");
  });

  it("accepts every documented status and refuses others", () => {
    for (const status of PAYOUT_STATUSES) expect(ok(event("payout.updated", payoutObject({ status }), { account: ACCT })).fact).toMatchObject({ payout: { status } });
    expect(fails(event("payout.paid", payoutObject({ status: "done" }), { account: ACCT }))).toBe("malformed_object");
    expect(fails(event("payout.paid", payoutObject({ amount: 0 }), { account: ACCT }))).toBe("malformed_object");
    expect(fails(event("payout.paid", payoutObject({ currency: "zzz" }), { account: ACCT }))).toBe("unsupported_currency");
  });
});

describe("transfers", () => {
  it("read the amount, the amount reversed, the destination and the charge that funded it", () => {
    expect(ok(event("transfer.created", transferObject())).fact).toEqual({
      kind: "transfer", transfer: { id: "tr_1TransferAaa", amount: 870, amountReversed: 0, currency: "usd", destination: ACCT, sourceCharge: CHARGE, createdAt: T0 * 1000 },
    });
    expect(ok(event("transfer.reversed", transferObject({ amount_reversed: 435 }))).fact).toMatchObject({ transfer: { amountReversed: 435 } });
  });

  it("accept a transfer without a source charge and a missing amount_reversed", () => {
    expect(ok(event("transfer.created", transferObject({ source_transaction: null, amount_reversed: undefined }))).fact).toMatchObject({ transfer: { sourceCharge: null, amountReversed: 0 } });
  });

  it("refuse a reversal larger than the transfer, a missing destination and other nonsense", () => {
    expect(fails(event("transfer.reversed", transferObject({ amount_reversed: 871 })))).toBe("malformed_object");
    expect(fails(event("transfer.created", transferObject({ destination: null })))).toBe("malformed_object");
    expect(fails(event("transfer.created", transferObject({ amount: 0 })))).toBe("malformed_object");
    expect(fails(event("transfer.created", transferObject({ source_transaction: "re_1AbCdEfGhIj" })))).toBe("malformed_object");
    expect(fails(event("transfer.created", transferObject({ currency: "zzz" })))).toBe("unsupported_currency");
  });
});

describe("status ranks: the order in which a status may change", () => {
  it("orders refunds pending < succeeded < failed or canceled", () => {
    expect(refundRank("pending")).toBe(1);
    expect(refundRank("requires_action")).toBe(1);
    expect(refundRank("succeeded")).toBe(2);
    expect(refundRank("failed")).toBe(3);
    expect(refundRank("canceled")).toBe(3);
  });

  it("orders disputes inquiry < open < won or lost", () => {
    for (const s of ["warning_needs_response", "warning_under_review", "warning_closed", "prevented"] as const) expect(disputeRank(s)).toBe(0);
    for (const s of ["needs_response", "under_review", "appeal_needs_response", "appeal_under_review"] as const) expect(disputeRank(s)).toBe(1);
    expect(disputeRank("won")).toBe(2);
    expect(disputeRank("lost")).toBe(2);
  });

  it("orders payouts pending < in transit < paid < failed or canceled", () => {
    expect(PAYOUT_STATUSES.map(payoutRank)).toEqual([1, 2, 3, 4, 4]);
  });
});
