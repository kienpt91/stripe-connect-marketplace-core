import { validateEntry, isSellerAccount, accountBalance, totalsOf, type Entry, type Line } from "../../src/domain/ledger.js";
import type { SellerId } from "../../src/domain/ids.js";
import type { FlaggedEvent } from "../../src/domain/reconciliation.js";
import type { AccountSnapshot, SellerState } from "../../src/domain/seller.js";
import type {
  Actor, Database, EventRecord, EventRepository, EventStatus, LedgerRepository, LedgerTotals, ObjectKind, ObjectRecord, ObjectRepository, OrderRecord, OrderRepository,
  PaymentRecord, PaymentRepository, ReversalDelta, SellerRecord, SellerRepository, StoredLine, Tx,
} from "../../src/application/store.js";

/**
 * An in-memory implementation of the persistence ports, for the offline test run. It behaves like the PostgreSQL adapter in the ways the
 * application depends on: transactions are serialised and roll back when the work throws, unique keys refuse a second row, a seller
 * only sees their own rows, and only the system writes. The scenario suites (test/contract) run on this double AND on PostgreSQL, so the
 * double is only trusted where both agree.
 */

interface StoredEntry {
  readonly seq: number;
  readonly entry: Entry;
  readonly eventId: string | null;
}

interface State {
  sellers: Map<string, SellerRecord>;
  orders: Map<string, OrderRecord>;
  payments: Map<string, PaymentRecord>;
  objects: Map<string, ObjectRecord>;
  events: Map<string, EventRecord>;
  entries: StoredEntry[];
  keys: Set<string>;
}

function fresh(): State {
  return { sellers: new Map(), orders: new Map(), payments: new Map(), objects: new Map(), events: new Map(), entries: [], keys: new Set() };
}

export class PermissionDenied extends Error {
  readonly code = "42501";
  constructor(what: string) {
    super(`permission denied: ${what}`);
  }
}

export class MemoryDatabase implements Database {
  private state: State = fresh();
  private tail: Promise<unknown> = Promise.resolve();
  /** how many transactions ran (committed or not), for tests that count round trips */
  transactions = 0;

  async ping(): Promise<void> {}

  transaction<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.transactions += 1;
      const before = structuredClone(this.state);
      try {
        return await work(new MemoryTx(actor, this.state));
      } catch (error) {
        this.state = before;
        throw error;
      }
    };
    // one transaction at a time, in arrival order
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Everything in the ledger, as the system sees it (for assertions). */
  async allEntries(): Promise<Entry[]> {
    return this.transaction({ kind: "operator" }, (tx) => tx.ledger.entries());
  }
}

class MemoryTx implements Tx {
  readonly actor: Actor;
  readonly sellers: SellerRepository;
  readonly orders: OrderRepository;
  readonly payments: PaymentRepository;
  readonly objects: ObjectRepository;
  readonly events: EventRepository;
  readonly ledger: LedgerRepository;

  constructor(actor: Actor, state: State) {
    this.actor = actor;
    const own = (sellerId: string): boolean => actor.kind !== "seller" || actor.sellerId === sellerId;
    const write = (what: string): void => {
      if (actor.kind !== "system") throw new PermissionDenied(what);
    };
    const staff = (what: string): void => {
      if (actor.kind === "seller") throw new PermissionDenied(what);
    };

    this.sellers = {
      async insert(seller) {
        write("sellers");
        if (state.sellers.has(seller.id) || [...state.sellers.values()].some((s) => s.accountId === seller.accountId)) return false;
        state.sellers.set(seller.id, seller);
        return true;
      },
      async get(id) {
        const s = state.sellers.get(id);
        return s !== undefined && own(s.id) ? s : undefined;
      },
      async getByAccount(accountId) {
        return [...state.sellers.values()].find((s) => s.accountId === accountId && own(s.id));
      },
      async applySnapshot(id: SellerId, status: SellerState, snapshot: AccountSnapshot, observedAt: number) {
        write("sellers");
        const s = state.sellers.get(id);
        if (s === undefined || s.observedAt > observedAt) return false;
        state.sellers.set(id, { ...s, state: status, snapshot, observedAt });
        return true;
      },
      async list() {
        return [...state.sellers.values()].filter((s) => own(s.id));
      },
    };

    this.orders = {
      async insert(order) {
        write("orders");
        if (state.orders.has(order.id) || [...state.orders.values()].some((o) => o.sellerId === order.sellerId && o.idempotencyKey === order.idempotencyKey)) return false;
        state.orders.set(order.id, order);
        return true;
      },
      async get(id) {
        const o = state.orders.get(id);
        return o !== undefined && own(o.sellerId) ? o : undefined;
      },
      async findByKey(sellerId, key) {
        return [...state.orders.values()].find((o) => o.sellerId === sellerId && o.idempotencyKey === key && own(o.sellerId));
      },
      async attachSession(id, sessionId) {
        write("orders");
        const o = state.orders.get(id);
        if (o !== undefined) state.orders.set(id, { ...o, sessionId });
      },
      async markPaid(id, chargeId) {
        write("orders");
        const o = state.orders.get(id);
        if (o !== undefined) state.orders.set(id, { ...o, status: "paid", chargeId });
      },
      async setStatus(id, status) {
        write("orders");
        const o = state.orders.get(id);
        if (o !== undefined) state.orders.set(id, { ...o, status });
      },
      async listForSeller(sellerId) {
        return [...state.orders.values()].filter((o) => o.sellerId === sellerId && own(o.sellerId)).sort((a, b) => b.createdAt - a.createdAt);
      },
    };

    this.payments = {
      async insert(payment) {
        write("payments");
        if (state.payments.has(payment.chargeId)) return false;
        state.payments.set(payment.chargeId, payment);
        return true;
      },
      async get(chargeId) {
        const p = state.payments.get(chargeId);
        return p !== undefined && own(p.sellerId) ? p : undefined;
      },
      async addReversal(chargeId: string, delta: ReversalDelta) {
        write("payments");
        const p = state.payments.get(chargeId);
        if (p === undefined) return;
        const next = { ...p, refunded: p.refunded + delta.refunded, reversed: p.reversed + delta.reversed, reversedFee: p.reversedFee + delta.reversedFee };
        if (next.refunded < 0 || next.reversed < next.refunded || next.reversed > p.amount || next.reversedFee < 0 || next.reversedFee > p.fee) throw new Error("payment totals out of range");
        state.payments.set(chargeId, next);
      },
      async list() {
        return [...state.payments.values()].filter((p) => own(p.sellerId));
      },
    };

    const key = (kind: ObjectKind, id: string): string => `${kind}:${id}`;
    this.objects = {
      async get(kind, id) {
        const o = state.objects.get(key(kind, id));
        return o !== undefined && own(o.sellerId) ? o : undefined;
      },
      async insert(record) {
        write("stripe_objects");
        if (state.objects.has(key(record.kind, record.id))) throw new Error("duplicate key value violates unique constraint");
        state.objects.set(key(record.kind, record.id), record);
      },
      async update(kind, id, patch) {
        write("stripe_objects");
        const o = state.objects.get(key(kind, id));
        if (o !== undefined) state.objects.set(key(kind, id), { ...o, ...patch });
      },
      async list(kind) {
        return [...state.objects.values()].filter((o) => o.kind === kind && own(o.sellerId));
      },
    };

    const keep = (status: EventStatus): boolean => status === "deferred" || status === "rejected";
    this.events = {
      async exists(id) {
        staff("stripe_events");
        return state.events.has(id);
      },
      async insert(event) {
        write("stripe_events");
        if (state.events.has(event.id)) return false;
        state.events.set(event.id, { ...event, payload: keep(event.status) ? event.payload : null });
        return true;
      },
      async setOutcome(id, status, reason) {
        write("stripe_events");
        const e = state.events.get(id);
        if (e !== undefined) state.events.set(id, { ...e, status, reason, payload: keep(status) ? e.payload : null });
      },
      async deferredFor(subject) {
        staff("stripe_events");
        return [...state.events.values()].filter((e) => e.status === "deferred" && e.subject === subject);
      },
      async listDeferred() {
        staff("stripe_events");
        return [...state.events.values()].filter((e) => e.status === "deferred");
      },
      async flagged(): Promise<FlaggedEvent[]> {
        staff("stripe_events");
        return [...state.events.values()]
          .filter((e) => e.status === "deferred" || e.status === "rejected")
          .map((e) => ({ id: e.id, type: e.type, status: e.status as "deferred" | "rejected", reason: e.reason, receivedAt: e.receivedAt }));
      },
      async count() {
        staff("stripe_events");
        return state.events.size;
      },
    };

    // the lines an actor can see: a seller sees only the lines of their own seller account
    const visible = (stored: StoredEntry): Line[] =>
      actor.kind === "seller" ? (actor.sellerId === stored.entry.sellerId ? stored.entry.lines.filter((l) => isSellerAccount(l.account)) : []) : [...stored.entry.lines];
    this.ledger = {
      async post(entry, eventId) {
        write("ledger_entries");
        const checked = validateEntry(entry);
        if (!checked.ok) throw new Error(`ledger entry is not valid: ${checked.error}`);
        if (state.keys.has(entry.postingKey)) return false;
        state.keys.add(entry.postingKey);
        state.entries.push({ seq: state.entries.length + 1, entry, eventId });
        return true;
      },
      async has(postingKey) {
        return state.keys.has(postingKey);
      },
      async linesFor(sellerId, page) {
        const out: StoredLine[] = [];
        for (const stored of state.entries) {
          if (stored.entry.sellerId !== sellerId || stored.seq <= page.afterSeq) continue;
          for (const line of visible(stored).filter((l) => isSellerAccount(l.account))) {
            out.push({
              seq: stored.seq, postingKey: stored.entry.postingKey, kind: stored.entry.kind, subject: stored.entry.subject, currency: stored.entry.currency,
              account: line.account, side: line.side, amount: line.amount, occurredAt: stored.entry.occurredAt,
            });
          }
          if (out.length >= page.limit) break;
        }
        return out.slice(0, page.limit);
      },
      async balanceOf(sellerId) {
        const out: Record<string, number> = {};
        for (const stored of state.entries) {
          if (stored.entry.sellerId !== sellerId) continue;
          const lines = visible(stored).filter((l) => l.account === "seller_balance");
          if (lines.length === 0) continue;
          out[stored.entry.currency] = (out[stored.entry.currency] ?? 0) + accountBalance("seller_balance", totalsOf(lines, "seller_balance"));
        }
        return out;
      },
      async totals() {
        const sums = new Map<string, LedgerTotals>();
        for (const stored of state.entries) {
          for (const line of visible(stored)) {
            const k = `${stored.entry.currency}/${line.account}`;
            const t = sums.get(k) ?? { currency: stored.entry.currency, account: line.account, debits: 0, credits: 0 };
            sums.set(k, { ...t, debits: t.debits + (line.side === "debit" ? line.amount : 0), credits: t.credits + (line.side === "credit" ? line.amount : 0) });
          }
        }
        return [...sums.values()];
      },
      async entries() {
        return state.entries.filter((s) => visible(s).length > 0).map((s) => ({ ...s.entry, lines: visible(s) }));
      },
    };
  }

  async lock(): Promise<void> {}
}

