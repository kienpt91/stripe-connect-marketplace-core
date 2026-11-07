/** Hand-written Stripe objects and events for the parser and application tests (the shapes follow Stripe's public API reference). */
export const ACCT = "acct_1SellerAaaa";
export const CHARGE = "ch_1ChargeAaaaa";
export const ORDER = "0a000000-0000-4000-8000-000000000001";
export const T0 = 1_762_000_000;

export function chargeObject(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CHARGE, object: "charge", amount: 1000, currency: "usd", status: "succeeded", created: T0, application_fee_amount: 130,
    transfer_data: { destination: ACCT, amount: 870 }, transfer: "tr_1TransferAaa", payment_intent: "pi_1IntentAaaaa", metadata: { order_id: ORDER }, ...patch,
  };
}

export function refundObject(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "re_1RefundAaaaa", object: "refund", amount: 500, charge: CHARGE, currency: "usd", status: "succeeded", created: T0 + 60, ...patch };
}

export function disputeObject(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "du_1DisputeAaaa", object: "dispute", amount: 1000, charge: CHARGE, currency: "usd", status: "needs_response", created: T0 + 120, ...patch };
}

export function payoutObject(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "po_1PayoutAaaaa", object: "payout", amount: 700, currency: "usd", status: "pending", created: T0 + 180, arrival_date: T0 + 90_000, ...patch };
}

export function transferObject(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "tr_1TransferAaa", object: "transfer", amount: 870, amount_reversed: 0, currency: "usd", destination: ACCT, source_transaction: CHARGE, created: T0, ...patch };
}

export function accountObject(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ACCT, object: "account", charges_enabled: false, payouts_enabled: false, details_submitted: false,
    requirements: { currently_due: ["external_account"], past_due: [], pending_verification: [], disabled_reason: null }, ...patch,
  };
}

let counter = 0;
/** The envelope Stripe wraps around an object. Every call without an id gets a new one. */
export function event(type: string, object: unknown, patch: { id?: string; created?: number; account?: string | null } = {}): Record<string, unknown> {
  counter += 1;
  return {
    id: patch.id ?? `evt_1Fixture${String(counter).padStart(6, "0")}`, object: "event", type, created: patch.created ?? T0, livemode: false,
    ...(patch.account === undefined ? {} : { account: patch.account }), data: { object }, pending_webhooks: 1,
  };
}
