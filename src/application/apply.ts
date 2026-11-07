import { disputeLostEntry, disputeOpenedEntry, disputeWonEntry, payoutEntry, refundEntry, reversalOf, saleEntry, validateEntry, type Entry } from "../domain/ledger.js";
import { allocateReversal } from "../domain/money.js";
import { asId, parseUuid, type OrderId } from "../domain/ids.js";
import { applySnapshot, type AccountSnapshot } from "../domain/seller.js";
import { disputeRank, payoutRank, refundRank, type ChargeFact, type DisputeFact, type Fact, type PayoutFact, type RefundFact, type TransferFact } from "../domain/stripe-events.js";
import type { EventStatus, ObjectRecord, OrderStatus, PaymentRecord, Tx } from "./store.js";

/** What applying one event did. `deferred` carries the charge it is waiting for in `subject`. */
export interface Outcome {
  readonly status: EventStatus;
  readonly reason: string | null;
}

const applied = (reason: string | null = null): Outcome => ({ status: "applied", reason });
const stale = (reason: string): Outcome => ({ status: "stale", reason });
const rejected = (reason: string): Outcome => ({ status: "rejected", reason });
const ignored = (reason: string): Outcome => ({ status: "ignored", reason });
const deferred = (reason: string): Outcome => ({ status: "deferred", reason });

/** What an event needs from the world outside the transaction. Only `account.updated` has any: the account as Stripe has it now. */
export interface Observation {
  readonly snapshot: AccountSnapshot;
  readonly observedAt: number;
}

/** Appends an entry; the entry is checked first, and one that does not balance is a bug that must stop the transaction. */
async function post(tx: Tx, entry: Entry, eventId: string): Promise<void> {
  const checked = validateEntry(entry);
  if (!checked.ok) throw new Error(`ledger entry ${entry.postingKey} is invalid: ${checked.error}`);
  await tx.ledger.post(entry, eventId);
}

function orderStatusFor(payment: PaymentRecord, refundedAfter: number): OrderStatus {
  return refundedAfter <= 0 ? "paid" : refundedAfter >= payment.amount ? "refunded" : "partially_refunded";
}

/**
 * Applies one parsed event to the world inside the transaction `tx`, which already holds the lock of the event's subject. Every
 * handler is idempotent on its own: the posting key of an entry names the business fact, and a stored status only moves up in
 * rank, so applying the same event twice, or two events of one object in the wrong order, ends in the same state.
 */
export async function applyFact(tx: Tx, eventId: string, fact: Fact, observation: Observation | undefined): Promise<Outcome> {
  switch (fact.kind) {
    case "ignored":
      return ignored("unhandled_event_type");
    case "account_updated":
      // no observation: the ingestion found no seller with this account, so there is nothing to read from Stripe for
      return observation === undefined ? ignored("unknown_account") : applyAccount(tx, observation);
    case "charge_succeeded":
      return applyCharge(tx, eventId, fact.charge);
    case "refund":
      return applyRefund(tx, eventId, fact.refund);
    case "dispute":
      return applyDispute(tx, eventId, fact.dispute);
    case "payout":
      return applyPayout(tx, eventId, fact.payout);
    case "transfer":
      return applyTransfer(tx, fact.transfer);
  }
}

/** The seller's state follows the account as Stripe has it now. A move the state machine does not allow is refused and flagged. */
export async function applyAccount(tx: Tx, observation: Observation): Promise<Outcome> {
  const seller = await tx.sellers.getByAccount(observation.snapshot.accountId);
  if (seller === undefined) return ignored("unknown_account");
  const change = applySnapshot(seller.state, observation.snapshot);
  if (change.kind === "refused") return rejected(`illegal_transition:${change.from}->${change.wanted}`);
  if (!(await tx.sellers.applySnapshot(seller.id, change.state, observation.snapshot, observation.observedAt))) return stale("older_than_stored");
  return applied(change.kind === "moved" ? `${change.from}->${change.state}` : null);
}

async function applyCharge(tx: Tx, eventId: string, charge: ChargeFact): Promise<Outcome> {
  const orderId = parseUuid(charge.orderId);
  const order = orderId === undefined ? undefined : await tx.orders.get(asId<"OrderId">(orderId) as OrderId);
  if (order === undefined) return ignored("not_a_marketplace_charge");
  const seller = await tx.sellers.get(order.sellerId);
  if (seller === undefined) return rejected("seller_missing");
  // money that went to some other account is not the seller's: nothing is posted, a person has to look at it
  if (charge.destination !== seller.accountId) return rejected("destination_mismatch");
  const fee = charge.applicationFee ?? 0;
  if (fee >= charge.amount) return rejected("fee_not_below_amount");

  const anomalies: string[] = [];
  if (charge.amount !== order.amount || charge.currency !== order.currency) anomalies.push(`charged ${charge.amount} ${charge.currency}, the order was ${order.amount} ${order.currency}`);
  if (fee !== order.fee) anomalies.push(`application fee ${fee}, the order was ${order.fee}`);
  if (order.status !== "awaiting_payment" && order.chargeId !== charge.id) anomalies.push(`the order was already paid by ${order.chargeId ?? "another charge"}`);
  const anomaly = anomalies.length === 0 ? null : anomalies.join("; ");

  const inserted = await tx.payments.insert({
    chargeId: charge.id, orderId: order.id, sellerId: seller.id, accountId: seller.accountId, currency: charge.currency, amount: charge.amount, fee,
    refunded: 0, reversed: 0, reversedFee: 0, anomaly, createdAt: charge.createdAt,
  });
  if (!inserted) return stale("charge_already_recorded");
  await post(tx, saleEntry({ chargeId: charge.id, sellerId: seller.id, currency: charge.currency, amount: charge.amount, fee, occurredAt: charge.createdAt }), eventId);
  if (order.status === "awaiting_payment") await tx.orders.markPaid(order.id, charge.id);
  return applied(anomaly);
}

async function applyRefund(tx: Tx, eventId: string, refund: RefundFact): Promise<Outcome> {
  const payment = await tx.payments.get(refund.chargeId);
  if (payment === undefined) return deferred(`waiting for ${refund.chargeId}`);
  if (refund.currency !== payment.currency) return rejected("currency_mismatch");
  const known = await tx.objects.get("refund", refund.id);
  if (known !== undefined && (known.amount !== refund.amount || known.currency !== refund.currency || known.chargeId !== refund.chargeId)) return rejected("object_changed");
  const rank = refundRank(refund.status);
  if (known !== undefined && known.rank >= rank) return stale("not_newer_than_stored");

  let feePart = known?.feePart ?? 0;
  if (rank === 2) {
    const split = allocateReversal({ amount: payment.amount, fee: payment.fee }, { amount: payment.reversed, fee: payment.reversedFee }, refund.amount);
    if (!split.ok) return rejected("refund_exceeds_charge");
    feePart = split.value.feePart;
    await post(tx, refundEntry({ refundId: refund.id, sellerId: payment.sellerId, currency: refund.currency, amount: refund.amount, feePart, occurredAt: refund.createdAt }), eventId);
    await tx.payments.addReversal(payment.chargeId, { refunded: refund.amount, reversed: refund.amount, reversedFee: feePart });
    await tx.orders.setStatus(payment.orderId, orderStatusFor(payment, payment.refunded + refund.amount));
  } else if (rank === 3 && known !== undefined && known.rank === 2) {
    // a refund that had succeeded failed after all: the money is back with the platform and the seller
    const original = refundEntry({ refundId: refund.id, sellerId: payment.sellerId, currency: refund.currency, amount: refund.amount, feePart, occurredAt: refund.createdAt });
    await post(tx, reversalOf(original, "refund_reversal", refund.createdAt), eventId);
    await tx.payments.addReversal(payment.chargeId, { refunded: -refund.amount, reversed: -refund.amount, reversedFee: -feePart });
    await tx.orders.setStatus(payment.orderId, orderStatusFor(payment, payment.refunded - refund.amount));
  }
  await upsert(tx, known, {
    kind: "refund", id: refund.id, sellerId: payment.sellerId, accountId: payment.accountId, chargeId: payment.chargeId, currency: refund.currency,
    amount: refund.amount, feePart, secondaryAmount: 0, status: refund.status, rank, createdAt: refund.createdAt,
  });
  return applied();
}

async function applyDispute(tx: Tx, eventId: string, dispute: DisputeFact): Promise<Outcome> {
  const payment = await tx.payments.get(dispute.chargeId);
  if (payment === undefined) return deferred(`waiting for ${dispute.chargeId}`);
  if (dispute.currency !== payment.currency) return rejected("currency_mismatch");
  if (dispute.amount > payment.amount) return rejected("dispute_exceeds_charge");
  const known = await tx.objects.get("dispute", dispute.id);
  if (known !== undefined && (known.amount !== dispute.amount || known.currency !== dispute.currency || known.chargeId !== dispute.chargeId)) return rejected("object_changed");
  const rank = disputeRank(dispute.status);
  if (known !== undefined && known.rank >= rank) return stale(rank === 2 && known.status !== dispute.status ? "conflicting_close" : "not_newer_than_stored");

  const common = { disputeId: dispute.id, sellerId: payment.sellerId, currency: dispute.currency, amount: dispute.amount, occurredAt: dispute.createdAt };
  let feePart = 0;
  if (rank === 2 && dispute.status === "lost") {
    const split = allocateReversal({ amount: payment.amount, fee: payment.fee }, { amount: payment.reversed, fee: payment.reversedFee }, dispute.amount);
    if (!split.ok) return rejected("dispute_exceeds_charge");
    feePart = split.value.feePart;
  }
  if (rank >= 1) await post(tx, disputeOpenedEntry(common), eventId);
  if (rank === 2 && dispute.status === "won") await post(tx, disputeWonEntry(common), eventId);
  if (rank === 2 && dispute.status === "lost") {
    await post(tx, disputeLostEntry({ ...common, feePart }), eventId);
    await tx.payments.addReversal(payment.chargeId, { refunded: 0, reversed: dispute.amount, reversedFee: feePart });
  }
  await upsert(tx, known, {
    kind: "dispute", id: dispute.id, sellerId: payment.sellerId, accountId: payment.accountId, chargeId: payment.chargeId, currency: dispute.currency,
    amount: dispute.amount, feePart, secondaryAmount: 0, status: dispute.status, rank, createdAt: dispute.createdAt,
  });
  return applied();
}

async function applyPayout(tx: Tx, eventId: string, payout: PayoutFact): Promise<Outcome> {
  const seller = await tx.sellers.getByAccount(payout.accountId);
  if (seller === undefined) return ignored("unknown_account");
  const known = await tx.objects.get("payout", payout.id);
  if (known !== undefined && (known.amount !== payout.amount || known.currency !== payout.currency || known.accountId !== payout.accountId)) return rejected("object_changed");
  const rank = payoutRank(payout.status);
  if (known !== undefined && known.rank >= rank) return stale("not_newer_than_stored");

  const entry = payoutEntry({ payoutId: payout.id, sellerId: seller.id, currency: payout.currency, amount: payout.amount, occurredAt: payout.createdAt });
  if (rank <= 3) {
    // the balance of the account goes down when the payout is created, whichever event of the payout arrives first
    await post(tx, entry, eventId);
  } else if (known !== undefined) {
    // a payout that failed or was canceled puts the money back; one never seen before it failed changed nothing
    await post(tx, reversalOf(entry, "payout_reversal", payout.createdAt), eventId);
  }
  await upsert(tx, known, {
    kind: "payout", id: payout.id, sellerId: seller.id, accountId: payout.accountId, chargeId: null, currency: payout.currency,
    amount: payout.amount, feePart: 0, secondaryAmount: 0, status: payout.status, rank, createdAt: payout.createdAt,
  });
  return applied();
}

/** A destination charge's transfer is recorded, not posted: the sale already credited the seller. Reconciliation checks it. */
async function applyTransfer(tx: Tx, transfer: TransferFact): Promise<Outcome> {
  if (transfer.sourceCharge === null) return ignored("not_a_marketplace_transfer");
  const payment = await tx.payments.get(transfer.sourceCharge);
  if (payment === undefined) return deferred(`waiting for ${transfer.sourceCharge}`);
  if (transfer.currency !== payment.currency) return rejected("currency_mismatch");
  const known = await tx.objects.get("transfer", transfer.id);
  if (known !== undefined && (known.amount !== transfer.amount || known.accountId !== transfer.destination)) return rejected("object_changed");
  // the amount reversed only grows, so the largest one seen is the current one
  if (known !== undefined && known.secondaryAmount >= transfer.amountReversed) return stale("not_newer_than_stored");
  await upsert(tx, known, {
    kind: "transfer", id: transfer.id, sellerId: payment.sellerId, accountId: transfer.destination, chargeId: payment.chargeId, currency: transfer.currency,
    amount: transfer.amount, feePart: 0, secondaryAmount: transfer.amountReversed, status: transfer.amountReversed > 0 ? "reversed" : "created",
    rank: transfer.amountReversed > 0 ? 2 : 1, createdAt: transfer.createdAt,
  });
  return applied();
}

async function upsert(tx: Tx, known: ObjectRecord | undefined, next: ObjectRecord): Promise<void> {
  if (known === undefined) await tx.objects.insert(next);
  else await tx.objects.update(next.kind, next.id, { status: next.status, rank: next.rank, feePart: next.feePart, secondaryAmount: next.secondaryAmount });
}
