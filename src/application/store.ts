import type { Entry } from "../domain/ledger.js";
import type { Currency } from "../domain/money.js";
import type { OrderId, SellerId } from "../domain/ids.js";
import type { FlaggedEvent } from "../domain/reconciliation.js";
import type { AccountSnapshot, SellerState } from "../domain/seller.js";

/**
 * Who a transaction runs as. The adapter switches the database role and sets the identity claim before the first statement, so a
 * seller's transaction can only see that seller's rows, whatever the query says. A seller and an operator only read; the system
 * (the webhook handler and the checkout) writes, and even it cannot change or delete a ledger row.
 */
export type Actor =
  | { readonly kind: "seller"; readonly sellerId: SellerId }
  | { readonly kind: "operator" }
  | { readonly kind: "system" };

export interface Database {
  /**
   * Runs `work` in one transaction as `actor`. A transient failure (serialization, deadlock) runs `work` again, a bounded number of
   * times: `work` must not call anything outside the transaction (the payment provider, a mailer).
   */
  transaction<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
}

export interface Tx {
  readonly actor: Actor;
  readonly sellers: SellerRepository;
  readonly orders: OrderRepository;
  readonly payments: PaymentRepository;
  readonly objects: ObjectRepository;
  readonly events: EventRepository;
  readonly ledger: LedgerRepository;
  /**
   * Waits for the lock named `key`, which is released when the transaction ends. Everything that touches the same charge, payout or
   * account takes the same lock first, so two events about one object are applied one after the other.
   */
  lock(key: string): Promise<void>;
}

export interface SellerRecord {
  readonly id: SellerId;
  readonly displayName: string;
  readonly accountId: string;
  readonly state: SellerState;
  readonly snapshot: AccountSnapshot | null;
  /** when (ms, our clock) the snapshot was read from Stripe: an older read never replaces a newer one */
  readonly observedAt: number;
  readonly createdAt: number;
}

export interface SellerRepository {
  insert(seller: SellerRecord): Promise<boolean>;
  get(id: SellerId): Promise<SellerRecord | undefined>;
  getByAccount(accountId: string): Promise<SellerRecord | undefined>;
  /** replaces the state and the snapshot unless the stored snapshot was observed later; false when it was */
  applySnapshot(id: SellerId, state: SellerState, snapshot: AccountSnapshot, observedAt: number): Promise<boolean>;
  list(): Promise<SellerRecord[]>;
}

export type OrderStatus = "awaiting_payment" | "paid" | "partially_refunded" | "refunded";

export interface OrderRecord {
  readonly id: OrderId;
  readonly sellerId: SellerId;
  /** the buyer as the application knows them (an opaque reference, never a name or an e-mail address) */
  readonly buyerRef: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly fee: number;
  readonly description: string;
  readonly status: OrderStatus;
  readonly idempotencyKey: string;
  readonly sessionId: string | null;
  readonly chargeId: string | null;
  readonly createdAt: number;
}

export interface OrderRepository {
  /** false when the seller already has an order with this idempotency key */
  insert(order: OrderRecord): Promise<boolean>;
  get(id: OrderId): Promise<OrderRecord | undefined>;
  findByKey(sellerId: SellerId, idempotencyKey: string): Promise<OrderRecord | undefined>;
  attachSession(id: OrderId, sessionId: string): Promise<void>;
  markPaid(id: OrderId, chargeId: string): Promise<void>;
  setStatus(id: OrderId, status: OrderStatus): Promise<void>;
  listForSeller(sellerId: SellerId): Promise<OrderRecord[]>;
}

export interface PaymentRecord {
  readonly chargeId: string;
  readonly orderId: OrderId;
  readonly sellerId: SellerId;
  readonly accountId: string;
  readonly currency: Currency;
  readonly amount: number;
  readonly fee: number;
  /** refunds that succeeded: what Stripe reports as `amount_refunded` */
  readonly refunded: number;
  /** everything taken back from the sale (refunds and lost disputes), and the platform's part of it: what the allocation rule reads */
  readonly reversed: number;
  readonly reversedFee: number;
  readonly anomaly: string | null;
  readonly createdAt: number;
}

export interface ReversalDelta {
  readonly refunded: number;
  readonly reversed: number;
  readonly reversedFee: number;
}

export interface PaymentRepository {
  /** false when a payment for the charge exists */
  insert(payment: PaymentRecord): Promise<boolean>;
  get(chargeId: string): Promise<PaymentRecord | undefined>;
  /** adds a signed delta to the totals taken back from the sale */
  addReversal(chargeId: string, delta: ReversalDelta): Promise<void>;
  list(): Promise<PaymentRecord[]>;
}

export type ObjectKind = "refund" | "dispute" | "payout" | "transfer";

/** A refund, a dispute, a payout or a transfer as last seen. The status only ever moves up in rank. */
export interface ObjectRecord {
  readonly kind: ObjectKind;
  readonly id: string;
  readonly sellerId: SellerId;
  /** the connected account: the payout's account, the transfer's destination; for refunds and disputes the seller's account */
  readonly accountId: string;
  readonly chargeId: string | null;
  readonly currency: Currency;
  readonly amount: number;
  /** the platform's part of the amount, for a refund and a lost dispute; 0 otherwise */
  readonly feePart: number;
  /** a transfer's amount reversed so far; 0 otherwise */
  readonly secondaryAmount: number;
  readonly status: string;
  readonly rank: number;
  readonly createdAt: number;
}

export interface ObjectRepository {
  get(kind: ObjectKind, id: string): Promise<ObjectRecord | undefined>;
  insert(record: ObjectRecord): Promise<void>;
  update(kind: ObjectKind, id: string, patch: { status: string; rank: number; feePart: number; secondaryAmount: number }): Promise<void>;
  list(kind: ObjectKind): Promise<ObjectRecord[]>;
}

export type EventStatus = "applied" | "stale" | "deferred" | "rejected" | "ignored";

export interface EventRecord {
  readonly id: string;
  readonly type: string;
  readonly account: string | null;
  /** the lock key of the object the event is about: a charge id for everything that waits for a charge */
  readonly subject: string;
  readonly receivedAt: number;
  readonly status: EventStatus;
  readonly reason: string | null;
  /** kept only while it is needed: deferred events (to apply later) and rejected ones (to look at) */
  readonly payload: unknown;
}

export interface EventRepository {
  exists(id: string): Promise<boolean>;
  /** false when the event id was recorded before */
  insert(event: EventRecord): Promise<boolean>;
  /** sets the outcome; the payload is dropped unless the outcome is `deferred` or `rejected` */
  setOutcome(id: string, status: EventStatus, reason: string | null): Promise<void>;
  /** deferred events waiting for this subject, oldest first */
  deferredFor(subject: string): Promise<EventRecord[]>;
  listDeferred(): Promise<EventRecord[]>;
  flagged(): Promise<FlaggedEvent[]>;
  count(): Promise<number>;
}

export interface StoredLine {
  readonly seq: number;
  readonly postingKey: string;
  readonly kind: Entry["kind"];
  readonly subject: string;
  readonly currency: Currency;
  readonly account: string;
  readonly side: "debit" | "credit";
  readonly amount: number;
  readonly occurredAt: number;
}

export interface LedgerTotals {
  readonly currency: Currency;
  readonly account: string;
  readonly debits: number;
  readonly credits: number;
}

export interface LedgerRepository {
  /** appends the entry; false (and nothing written) when its posting key exists. The entry is validated first. */
  post(entry: Entry, eventId: string | null): Promise<boolean>;
  has(postingKey: string): Promise<boolean>;
  /** the lines of the seller's own accounts, oldest first, `limit` at a time after `afterSeq` */
  linesFor(sellerId: SellerId, page: { afterSeq: number; limit: number }): Promise<StoredLine[]>;
  /** what the platform owes the seller, per currency */
  balanceOf(sellerId: SellerId): Promise<Record<string, number>>;
  /** debits and credits per currency and account over everything the actor can see */
  totals(): Promise<LedgerTotals[]>;
  /** every entry the actor can see, oldest first (an export, and the proof that two runs gave the same ledger) */
  entries(): Promise<Entry[]>;
}
