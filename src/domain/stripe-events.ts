import { parseStripeId } from "./ids.js";
import { isMinor, parseCurrency, type Currency } from "./money.js";
import { err, ok, type Result } from "./result.js";

/**
 * Stripe webhook events as the rest of the system sees them: a strict reading of the envelope and of the one object each handled
 * event type carries. Nothing here trusts a field it has not checked, and nothing outside this file reads raw event JSON.
 *
 * Statuses have a rank. A webhook endpoint can receive the events of one object in any order, so the state of a refund, a
 * dispute or a payout only ever moves to a higher rank: whatever order the events arrive in, and however often, the final state
 * is the highest one seen (docs/adr/0004).
 */

export const REFUND_STATUSES = ["pending", "requires_action", "succeeded", "failed", "canceled"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const DISPUTE_STATUSES = [
  "warning_needs_response", "warning_under_review", "warning_closed", "prevented",
  "needs_response", "under_review", "appeal_needs_response", "appeal_under_review", "won", "lost",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const PAYOUT_STATUSES = ["pending", "in_transit", "paid", "failed", "canceled"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** pending = 1, succeeded = 2, failed or canceled = 3 (a refund that succeeded can still fail later, never the other way). */
export function refundRank(status: RefundStatus): number {
  return status === "succeeded" ? 2 : status === "failed" || status === "canceled" ? 3 : 1;
}

/** inquiry or prevented = 0 (no money moved), open = 1, closed (won or lost) = 2. */
export function disputeRank(status: DisputeStatus): number {
  if (status === "won" || status === "lost") return 2;
  if (status.startsWith("warning_") || status === "prevented") return 0;
  return 1;
}

/** pending = 1, in_transit = 2, paid = 3, failed or canceled = 4 (a payout shown as paid can fail later). */
export function payoutRank(status: PayoutStatus): number {
  return status === "pending" ? 1 : status === "in_transit" ? 2 : status === "paid" ? 3 : 4;
}

export interface ChargeFact {
  readonly id: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly applicationFee: number | null;
  /** the connected account the charge pays out to (`transfer_data.destination`) */
  readonly destination: string | null;
  /** the order id the checkout put in the charge's metadata */
  readonly orderId: string | null;
  readonly transferId: string | null;
  readonly createdAt: number;
}

export interface RefundFact {
  readonly id: string;
  readonly chargeId: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly status: RefundStatus;
  readonly createdAt: number;
}

export interface DisputeFact {
  readonly id: string;
  readonly chargeId: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly status: DisputeStatus;
  readonly createdAt: number;
}

export interface PayoutFact {
  readonly id: string;
  readonly accountId: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly status: PayoutStatus;
  readonly createdAt: number;
}

export interface TransferFact {
  readonly id: string;
  readonly amount: number;
  readonly amountReversed: number;
  readonly currency: Currency;
  readonly destination: string;
  /** the charge that funded the transfer; a destination charge's transfer names it */
  readonly sourceCharge: string | null;
  readonly createdAt: number;
}

export type Fact =
  | { readonly kind: "account_updated"; readonly accountId: string }
  | { readonly kind: "charge_succeeded"; readonly charge: ChargeFact }
  | { readonly kind: "refund"; readonly refund: RefundFact }
  | { readonly kind: "dispute"; readonly dispute: DisputeFact }
  | { readonly kind: "payout"; readonly payout: PayoutFact }
  | { readonly kind: "transfer"; readonly transfer: TransferFact }
  | { readonly kind: "ignored" };

export interface ParsedEvent {
  readonly id: string;
  readonly type: string;
  /** seconds since the epoch, as Stripe sends it (an event timestamp, which is NOT an order: Stripe says so) */
  readonly created: number;
  /** the connected account the event is about (Connect events), if any */
  readonly account: string | null;
  readonly fact: Fact;
}

export type EventError = "malformed_event" | "malformed_object" | "unsupported_currency" | "account_missing";

type HandledKind = Exclude<Fact["kind"], "ignored">;

const HANDLED: Readonly<Record<string, HandledKind>> = {
  "account.updated": "account_updated",
  "charge.succeeded": "charge_succeeded",
  "refund.created": "refund",
  "refund.updated": "refund",
  "refund.failed": "refund",
  "charge.dispute.created": "dispute",
  "charge.dispute.updated": "dispute",
  "charge.dispute.closed": "dispute",
  "payout.created": "payout",
  "payout.updated": "payout",
  "payout.paid": "payout",
  "payout.failed": "payout",
  "payout.canceled": "payout",
  "transfer.created": "transfer",
  "transfer.updated": "transfer",
  "transfer.reversed": "transfer",
};

/** Event types this system reads. Anything else a webhook endpoint is subscribed to is recorded as ignored. */
export function handledEventTypes(): readonly string[] {
  return Object.keys(HANDLED);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function oneOf<T extends string>(list: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" ? list.find((x) => x === value) : undefined;
}

/** `created` fields are whole seconds; a fact carries them as milliseconds. */
function seconds(value: unknown): number | undefined {
  return isMinor(value) && value < 253_402_300_799 ? value * 1000 : undefined;
}

/** A string, an expanded object with an id, or null: the shapes Stripe uses for a reference to another object. */
function reference(prefix: "ch" | "acct" | "tr" | "pi", value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  const id = isObj(value) ? value["id"] : value;
  return parseStripeId(prefix, id) ?? undefined;
}

type Parsed<T> = Result<T, EventError>;
const bad = (e: EventError): { ok: false; error: EventError } => err(e);

function parseCharge(o: Obj): Parsed<ChargeFact> {
  const id = parseStripeId("ch", o["id"]);
  const currency = parseCurrency(o["currency"]);
  const createdAt = seconds(o["created"]);
  if (id === undefined || createdAt === undefined || !isMinor(o["amount"]) || o["amount"] < 1) return bad("malformed_object");
  if (currency === undefined) return bad("unsupported_currency");
  if (o["status"] !== "succeeded") return bad("malformed_object");
  const fee = o["application_fee_amount"] ?? null;
  if (fee !== null && !isMinor(fee)) return bad("malformed_object");
  const transferData = o["transfer_data"] ?? null;
  if (transferData !== null && !isObj(transferData)) return bad("malformed_object");
  const destination = reference("acct", transferData === null ? null : transferData["destination"]);
  const transferId = reference("tr", o["transfer"]);
  const metadata = o["metadata"] ?? {};
  if (!isObj(metadata) || destination === undefined || transferId === undefined) return bad("malformed_object");
  const orderId = typeof metadata["order_id"] === "string" && metadata["order_id"].length <= 64 ? metadata["order_id"] : null;
  return ok({ id, amount: o["amount"], currency, applicationFee: fee, destination, orderId, transferId, createdAt });
}

function parseRefund(o: Obj): Parsed<RefundFact> {
  const id = parseStripeId("re", o["id"]);
  const chargeId = reference("ch", o["charge"]);
  const currency = parseCurrency(o["currency"]);
  const status = oneOf(REFUND_STATUSES, o["status"]);
  const createdAt = seconds(o["created"]);
  if (id === undefined || !chargeId || status === undefined || createdAt === undefined || !isMinor(o["amount"]) || o["amount"] < 1) return bad("malformed_object");
  if (currency === undefined) return bad("unsupported_currency");
  return ok({ id, chargeId, amount: o["amount"], currency, status, createdAt });
}

function parseDispute(o: Obj): Parsed<DisputeFact> {
  const id = parseStripeId("du", o["id"]);
  const chargeId = reference("ch", o["charge"]);
  const currency = parseCurrency(o["currency"]);
  const status = oneOf(DISPUTE_STATUSES, o["status"]);
  const createdAt = seconds(o["created"]);
  if (id === undefined || !chargeId || status === undefined || createdAt === undefined || !isMinor(o["amount"]) || o["amount"] < 1) return bad("malformed_object");
  if (currency === undefined) return bad("unsupported_currency");
  return ok({ id, chargeId, amount: o["amount"], currency, status, createdAt });
}

function parsePayout(o: Obj, accountId: string): Parsed<PayoutFact> {
  const id = parseStripeId("po", o["id"]);
  const currency = parseCurrency(o["currency"]);
  const status = oneOf(PAYOUT_STATUSES, o["status"]);
  const createdAt = seconds(o["created"]);
  if (id === undefined || status === undefined || createdAt === undefined || !isMinor(o["amount"]) || o["amount"] < 1) return bad("malformed_object");
  if (currency === undefined) return bad("unsupported_currency");
  return ok({ id, accountId, amount: o["amount"], currency, status, createdAt });
}

function parseTransfer(o: Obj): Parsed<TransferFact> {
  const id = parseStripeId("tr", o["id"]);
  const currency = parseCurrency(o["currency"]);
  const destination = reference("acct", o["destination"]);
  const sourceCharge = reference("ch", o["source_transaction"]);
  const createdAt = seconds(o["created"]);
  const reversed = o["amount_reversed"] ?? 0;
  if (id === undefined || !destination || sourceCharge === undefined || createdAt === undefined) return bad("malformed_object");
  if (!isMinor(o["amount"]) || o["amount"] < 1 || !isMinor(reversed) || reversed > o["amount"]) return bad("malformed_object");
  if (currency === undefined) return bad("unsupported_currency");
  return ok({ id, amount: o["amount"], amountReversed: reversed, currency, destination, sourceCharge, createdAt });
}

/**
 * Reads the JSON body of a webhook request. The envelope is checked first (id, type, timestamp, the connected account); an
 * event type this system does not handle becomes an `ignored` fact without looking inside its object.
 */
export function parseStripeEvent(json: unknown): Result<ParsedEvent, EventError> {
  if (!isObj(json)) return bad("malformed_event");
  const id = parseStripeId("evt", json["id"]);
  const type = json["type"];
  const created = json["created"];
  const account = reference("acct", json["account"]);
  const data = json["data"];
  if (id === undefined || typeof type !== "string" || type.length > 100 || !isMinor(created) || account === undefined || !isObj(data)) return bad("malformed_event");
  const base = { id, type, created, account };
  const kind = HANDLED[type];
  if (kind === undefined) return ok({ ...base, fact: { kind: "ignored" } });
  const object = data["object"];
  if (!isObj(object)) return bad("malformed_object");

  switch (kind) {
    case "account_updated": {
      const accountId = parseStripeId("acct", object["id"]);
      if (accountId === undefined || (account !== null && account !== accountId)) return bad("malformed_object");
      return ok({ ...base, fact: { kind, accountId } });
    }
    case "charge_succeeded": {
      const charge = parseCharge(object);
      return charge.ok ? ok({ ...base, fact: { kind, charge: charge.value } }) : charge;
    }
    case "refund": {
      const refund = parseRefund(object);
      return refund.ok ? ok({ ...base, fact: { kind, refund: refund.value } }) : refund;
    }
    case "dispute": {
      const dispute = parseDispute(object);
      return dispute.ok ? ok({ ...base, fact: { kind, dispute: dispute.value } }) : dispute;
    }
    case "payout": {
      if (account === null) return bad("account_missing");
      const payout = parsePayout(object, account);
      return payout.ok ? ok({ ...base, fact: { kind, payout: payout.value } }) : payout;
    }
    case "transfer": {
      const transfer = parseTransfer(object);
      return transfer.ok ? ok({ ...base, fact: { kind, transfer: transfer.value } }) : transfer;
    }
  }
}
