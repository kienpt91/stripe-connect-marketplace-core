import type pg from "pg";
import type { Entry, Line } from "../../domain/ledger.js";
import { validateEntry } from "../../domain/ledger.js";
import { parseCurrency, type Currency } from "../../domain/money.js";
import type { SellerId } from "../../domain/ids.js";
import type { FlaggedEvent } from "../../domain/reconciliation.js";
import type { AccountSnapshot, SellerState } from "../../domain/seller.js";
import type {
  Actor, EventRecord, EventRepository, EventStatus, LedgerRepository, LedgerTotals, ObjectKind, ObjectRecord, ObjectRepository, OrderRecord, OrderRepository, OrderStatus,
  PaymentRecord, PaymentRepository, SellerRecord, SellerRepository, StoredLine, Tx,
} from "../../application/store.js";

/** pg returns bigint columns as strings; a value that a number cannot hold exactly is an error, never a rounded number. */
function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError("a stored amount does not fit a number");
  return n;
}

function currencyOf(value: unknown): Currency {
  const c = parseCurrency(value);
  if (c === undefined) throw new RangeError("a stored currency is not one this system knows");
  return c;
}

type Row = Record<string, unknown>;
const rows = async (client: pg.ClientBase, sql: string, params: readonly unknown[] = []): Promise<Row[]> => (await client.query(sql, params as unknown[])).rows as Row[];
const affected = async (client: pg.ClientBase, sql: string, params: readonly unknown[] = []): Promise<number> => (await client.query(sql, params as unknown[])).rowCount ?? 0;

const toSeller = (r: Row): SellerRecord => ({
  id: r["id"] as SellerId, displayName: r["display_name"] as string, accountId: r["stripe_account_id"] as string, state: r["state"] as SellerState,
  snapshot: (r["account_snapshot"] ?? null) as AccountSnapshot | null, observedAt: num(r["observed_at"]), createdAt: num(r["created_at"]),
});

const toOrder = (r: Row): OrderRecord => ({
  id: r["id"] as OrderRecord["id"], sellerId: r["seller_id"] as SellerId, buyerRef: r["buyer_ref"] as string, amount: num(r["amount"]), currency: currencyOf(r["currency"]),
  fee: num(r["fee"]), description: r["description"] as string, status: r["status"] as OrderStatus, idempotencyKey: r["idempotency_key"] as string,
  sessionId: (r["session_id"] ?? null) as string | null, chargeId: (r["charge_id"] ?? null) as string | null, createdAt: num(r["created_at"]),
});

const toPayment = (r: Row): PaymentRecord => ({
  chargeId: r["charge_id"] as string, orderId: r["order_id"] as PaymentRecord["orderId"], sellerId: r["seller_id"] as SellerId, accountId: r["account_id"] as string,
  currency: currencyOf(r["currency"]), amount: num(r["amount"]), fee: num(r["fee"]), refunded: num(r["refunded"]), reversed: num(r["reversed"]), reversedFee: num(r["reversed_fee"]),
  anomaly: (r["anomaly"] ?? null) as string | null, createdAt: num(r["created_at"]),
});

const toObject = (r: Row): ObjectRecord => ({
  kind: r["kind"] as ObjectKind, id: r["id"] as string, sellerId: r["seller_id"] as SellerId, accountId: r["account_id"] as string, chargeId: (r["charge_id"] ?? null) as string | null,
  currency: currencyOf(r["currency"]), amount: num(r["amount"]), feePart: num(r["fee_part"]), secondaryAmount: num(r["secondary_amount"]), status: r["status"] as string,
  rank: num(r["rank"]), createdAt: num(r["created_at"]),
});

const toEvent = (r: Row): EventRecord => ({
  id: r["id"] as string, type: r["type"] as string, account: (r["account"] ?? null) as string | null, subject: r["subject"] as string, receivedAt: num(r["received_at"]),
  status: r["status"] as EventStatus, reason: (r["reason"] ?? null) as string | null, payload: r["payload"] ?? null,
});

/** The repositories of one transaction, over one connection. Every statement uses bind parameters; no value is ever put into SQL text. */
export function createRepositories(actor: Actor, client: pg.ClientBase): Tx {
  const sellers: SellerRepository = {
    async insert(s) {
      return (
        (await affected(
          client,
          "INSERT INTO sellers (id, display_name, stripe_account_id, state, account_snapshot, observed_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING",
          [s.id, s.displayName, s.accountId, s.state, s.snapshot === null ? null : JSON.stringify(s.snapshot), s.observedAt, s.createdAt],
        )) === 1
      );
    },
    async get(id) {
      const r = (await rows(client, "SELECT * FROM sellers WHERE id = $1", [id]))[0];
      return r === undefined ? undefined : toSeller(r);
    },
    async getByAccount(accountId) {
      const r = (await rows(client, "SELECT * FROM sellers WHERE stripe_account_id = $1", [accountId]))[0];
      return r === undefined ? undefined : toSeller(r);
    },
    async applySnapshot(id, state, snapshot, observedAt) {
      return (await affected(client, "UPDATE sellers SET state = $2, account_snapshot = $3, observed_at = $4 WHERE id = $1 AND observed_at <= $4", [id, state, JSON.stringify(snapshot), observedAt])) === 1;
    },
    async list() {
      return (await rows(client, "SELECT * FROM sellers ORDER BY created_at, id")).map(toSeller);
    },
  };

  const orders: OrderRepository = {
    async insert(o) {
      return (
        (await affected(
          client,
          `INSERT INTO orders (id, seller_id, buyer_ref, amount, currency, fee, description, status, idempotency_key, session_id, charge_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING`,
          [o.id, o.sellerId, o.buyerRef, o.amount, o.currency, o.fee, o.description, o.status, o.idempotencyKey, o.sessionId, o.chargeId, o.createdAt],
        )) === 1
      );
    },
    async get(id) {
      const r = (await rows(client, "SELECT * FROM orders WHERE id = $1", [id]))[0];
      return r === undefined ? undefined : toOrder(r);
    },
    async findByKey(sellerId, key) {
      const r = (await rows(client, "SELECT * FROM orders WHERE seller_id = $1 AND idempotency_key = $2", [sellerId, key]))[0];
      return r === undefined ? undefined : toOrder(r);
    },
    async attachSession(id, sessionId) {
      await client.query("UPDATE orders SET session_id = $2 WHERE id = $1", [id, sessionId]);
    },
    async markPaid(id, chargeId) {
      await client.query("UPDATE orders SET status = 'paid', charge_id = $2 WHERE id = $1", [id, chargeId]);
    },
    async setStatus(id, status) {
      await client.query("UPDATE orders SET status = $2 WHERE id = $1", [id, status]);
    },
    async listForSeller(sellerId) {
      return (await rows(client, "SELECT * FROM orders WHERE seller_id = $1 ORDER BY created_at DESC, id", [sellerId])).map(toOrder);
    },
  };

  const payments: PaymentRepository = {
    async insert(p) {
      return (
        (await affected(
          client,
          `INSERT INTO payments (charge_id, order_id, seller_id, account_id, currency, amount, fee, refunded, reversed, reversed_fee, anomaly, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING`,
          [p.chargeId, p.orderId, p.sellerId, p.accountId, p.currency, p.amount, p.fee, p.refunded, p.reversed, p.reversedFee, p.anomaly, p.createdAt],
        )) === 1
      );
    },
    async get(chargeId) {
      const r = (await rows(client, "SELECT * FROM payments WHERE charge_id = $1", [chargeId]))[0];
      return r === undefined ? undefined : toPayment(r);
    },
    async addReversal(chargeId, d) {
      await client.query("UPDATE payments SET refunded = refunded + $2, reversed = reversed + $3, reversed_fee = reversed_fee + $4 WHERE charge_id = $1", [chargeId, d.refunded, d.reversed, d.reversedFee]);
    },
    async list() {
      return (await rows(client, "SELECT * FROM payments ORDER BY created_at, charge_id")).map(toPayment);
    },
  };

  const objects: ObjectRepository = {
    async get(kind, id) {
      const r = (await rows(client, "SELECT * FROM stripe_objects WHERE kind = $1 AND id = $2", [kind, id]))[0];
      return r === undefined ? undefined : toObject(r);
    },
    async insert(o) {
      await client.query(
        `INSERT INTO stripe_objects (kind, id, seller_id, account_id, charge_id, currency, amount, fee_part, secondary_amount, status, rank, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [o.kind, o.id, o.sellerId, o.accountId, o.chargeId, o.currency, o.amount, o.feePart, o.secondaryAmount, o.status, o.rank, o.createdAt],
      );
    },
    async update(kind, id, patch) {
      await client.query("UPDATE stripe_objects SET status = $3, rank = $4, fee_part = $5, secondary_amount = $6 WHERE kind = $1 AND id = $2", [kind, id, patch.status, patch.rank, patch.feePart, patch.secondaryAmount]);
    },
    async list(kind) {
      return (await rows(client, "SELECT * FROM stripe_objects WHERE kind = $1 ORDER BY created_at, id", [kind])).map(toObject);
    },
  };

  // the payload is kept only for the statuses that need it (the table's CHECK says the same)
  const keeps = (status: EventStatus): boolean => status === "deferred" || status === "rejected";
  const events: EventRepository = {
    async exists(id) {
      return (await rows(client, "SELECT 1 FROM stripe_events WHERE id = $1", [id])).length === 1;
    },
    async insert(e) {
      return (
        (await affected(
          client,
          "INSERT INTO stripe_events (id, type, account, subject, received_at, status, reason, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING",
          [e.id, e.type, e.account, e.subject, e.receivedAt, e.status, e.reason, keeps(e.status) && e.payload !== null && e.payload !== undefined ? JSON.stringify(e.payload) : null],
        )) === 1
      );
    },
    async setOutcome(id, status, reason) {
      await client.query("UPDATE stripe_events SET status = $2, reason = $3, payload = CASE WHEN $2 IN ('deferred', 'rejected') THEN payload ELSE NULL END WHERE id = $1", [id, status, reason]);
    },
    async deferredFor(subject) {
      return (await rows(client, "SELECT * FROM stripe_events WHERE status = 'deferred' AND subject = $1 ORDER BY received_at, id", [subject])).map(toEvent);
    },
    async listDeferred() {
      return (await rows(client, "SELECT * FROM stripe_events WHERE status = 'deferred' ORDER BY received_at, id")).map(toEvent);
    },
    async flagged(): Promise<FlaggedEvent[]> {
      return (await rows(client, "SELECT id, type, status, reason, received_at FROM stripe_events WHERE status IN ('deferred', 'rejected') ORDER BY received_at, id")).map((r) => ({
        id: r["id"] as string, type: r["type"] as string, status: r["status"] as "deferred" | "rejected", reason: (r["reason"] ?? null) as string | null, receivedAt: num(r["received_at"]),
      }));
    },
    async count() {
      return num((await rows(client, "SELECT count(*) AS n FROM stripe_events"))[0]?.["n"]);
    },
  };

  const ledger: LedgerRepository = {
    async post(entry, eventId) {
      const checked = validateEntry(entry);
      if (!checked.ok) throw new Error(`ledger entry is not valid: ${checked.error}`);
      const total = entry.lines.filter((l) => l.side === "debit").reduce((sum, l) => sum + l.amount, 0);
      const head = (
        await rows(
          client,
          `INSERT INTO ledger_entries (posting_key, kind, seller_id, currency, subject, occurred_at, event_id, line_count, total_minor)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (posting_key) DO NOTHING RETURNING seq`,
          [entry.postingKey, entry.kind, entry.sellerId, entry.currency, entry.subject, entry.occurredAt, eventId, entry.lines.length, total],
        )
      )[0];
      if (head === undefined) return false;
      const seq = num(head["seq"]);
      const values: unknown[] = [];
      const tuples = entry.lines.map((line, i) => {
        const at = values.length;
        values.push(seq, i + 1, line.account, line.side, line.amount, entry.currency, line.account === "seller_balance" ? entry.sellerId : null);
        return `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}, $${at + 6}, $${at + 7})`;
      });
      await client.query(`INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency, seller_id) VALUES ${tuples.join(", ")}`, values);
      return true;
    },
    async has(postingKey) {
      return (await rows(client, "SELECT 1 FROM ledger_entries WHERE posting_key = $1", [postingKey])).length === 1;
    },
    async linesFor(sellerId, page) {
      const out = await rows(
        client,
        `SELECT e.seq, e.posting_key, e.kind, e.subject, e.currency, e.occurred_at, l.account, l.side, l.amount
           FROM ledger_lines l JOIN ledger_entries e ON e.seq = l.entry_seq
          WHERE l.seller_id = $1 AND l.account = 'seller_balance' AND e.seq > $2
          ORDER BY e.seq, l.line_no LIMIT $3`,
        [sellerId, page.afterSeq, page.limit],
      );
      return out.map((r): StoredLine => ({
        seq: num(r["seq"]), postingKey: r["posting_key"] as string, kind: r["kind"] as Entry["kind"], subject: r["subject"] as string, currency: currencyOf(r["currency"]),
        account: r["account"] as string, side: r["side"] as "debit" | "credit", amount: num(r["amount"]), occurredAt: num(r["occurred_at"]),
      }));
    },
    async balanceOf(sellerId) {
      const out: Record<string, number> = {};
      for (const r of await rows(
        client,
        `SELECT e.currency, sum(CASE l.side WHEN 'credit' THEN l.amount ELSE -l.amount END) AS balance
           FROM ledger_lines l JOIN ledger_entries e ON e.seq = l.entry_seq
          WHERE l.seller_id = $1 AND l.account = 'seller_balance' GROUP BY e.currency ORDER BY e.currency`,
        [sellerId],
      )) out[r["currency"] as string] = num(r["balance"]);
      return out;
    },
    async totals() {
      return (
        await rows(
          client,
          `SELECT e.currency, l.account,
                  coalesce(sum(l.amount) FILTER (WHERE l.side = 'debit'), 0) AS debits, coalesce(sum(l.amount) FILTER (WHERE l.side = 'credit'), 0) AS credits
             FROM ledger_lines l JOIN ledger_entries e ON e.seq = l.entry_seq GROUP BY e.currency, l.account ORDER BY e.currency, l.account`,
        )
      ).map((r): LedgerTotals => ({ currency: currencyOf(r["currency"]), account: r["account"] as string, debits: num(r["debits"]), credits: num(r["credits"]) }));
    },
    async entries() {
      const out = await rows(
        client,
        `SELECT e.seq, e.posting_key, e.kind, e.seller_id, e.currency, e.subject, e.occurred_at, l.account, l.side, l.amount
           FROM ledger_entries e JOIN ledger_lines l ON l.entry_seq = e.seq ORDER BY e.seq, l.line_no`,
      );
      const bySeq = new Map<number, { head: Row; lines: Line[] }>();
      for (const r of out) {
        const seq = num(r["seq"]);
        const entry = bySeq.get(seq) ?? { head: r, lines: [] };
        entry.lines.push({ account: r["account"] as Line["account"], side: r["side"] as Line["side"], amount: num(r["amount"]) });
        bySeq.set(seq, entry);
      }
      return [...bySeq.values()].map(({ head, lines }): Entry => ({
        postingKey: head["posting_key"] as string, kind: head["kind"] as Entry["kind"], sellerId: head["seller_id"] as SellerId, currency: currencyOf(head["currency"]),
        subject: head["subject"] as string, occurredAt: num(head["occurred_at"]), lines,
      }));
    },
  };

  return {
    actor, sellers, orders, payments, objects, events, ledger,
    async lock(key) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    },
  };
}
