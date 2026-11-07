import type pg from "pg";
import { saleEntry, payoutEntry, type Entry } from "../../src/domain/ledger.js";
import type { SellerId } from "../../src/domain/ids.js";

/** Two sellers with an order, a paid charge, a payout and the ledger entries for them, written as the superuser (which skips row level security). */
export const W = {
  sellerA: "5e11e700-0000-4000-8000-00000000000a" as SellerId,
  sellerB: "5e11e700-0000-4000-8000-00000000000b" as SellerId,
  accountA: "acct_1SellerAaaaa",
  accountB: "acct_1SellerBbbbb",
  orderA: "0a000000-0000-4000-8000-00000000000a",
  orderB: "0a000000-0000-4000-8000-00000000000b",
  chargeA: "ch_1ChargeAaaaaa",
  chargeB: "ch_1ChargeBbbbbb",
  payoutB: "po_1PayoutBbbbbb",
  eventA: "evt_1EventAaaaaa",
  eventB: "evt_1EventBbbbbb",
} as const;

export const uid = (n: number): string => `0a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Writes an entry and its lines in one transaction, as the application does: the balance check runs at COMMIT. */
export async function insertEntry(c: pg.Client, entry: Entry, eventId: string | null = null): Promise<void> {
  await c.query("BEGIN");
  try {
    const total = entry.lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0);
    const head = await c.query(
      `INSERT INTO ledger_entries (posting_key, kind, seller_id, currency, subject, occurred_at, event_id, line_count, total_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING seq`,
      [entry.postingKey, entry.kind, entry.sellerId, entry.currency, entry.subject, entry.occurredAt, eventId, entry.lines.length, total],
    );
    const seq = head.rows[0].seq as string;
    let n = 0;
    for (const l of entry.lines) {
      n += 1;
      await c.query("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency, seller_id) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
        seq, n, l.account, l.side, l.amount, entry.currency, l.account === "seller_balance" ? entry.sellerId : null,
      ]);
    }
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  }
}

export async function seedWorld(c: pg.Client): Promise<void> {
  for (const [id, account, name] of [[W.sellerA, W.accountA, "Alba Ceramics"], [W.sellerB, W.accountB, "Bruno Leather"]] as const) {
    await c.query("INSERT INTO sellers (id, display_name, stripe_account_id, state, observed_at, created_at) VALUES ($1, $2, $3, 'enabled', 1, 1)", [id, name, account]);
  }
  for (const [order, seller, key] of [[W.orderA, W.sellerA, "purchase-aaaa0001"], [W.orderB, W.sellerB, "purchase-bbbb0001"]] as const) {
    await c.query(
      "INSERT INTO orders (id, seller_id, buyer_ref, amount, currency, fee, description, status, idempotency_key, created_at) VALUES ($1, $2, 'buyer-1', 10000, 'usd', 1030, 'Mug', 'paid', $3, 1)",
      [order, seller, key],
    );
  }
  for (const [charge, order, seller, account] of [[W.chargeA, W.orderA, W.sellerA, W.accountA], [W.chargeB, W.orderB, W.sellerB, W.accountB]] as const) {
    await c.query("INSERT INTO payments (charge_id, order_id, seller_id, account_id, currency, amount, fee, created_at) VALUES ($1, $2, $3, $4, 'usd', 10000, 1030, 1)", [charge, order, seller, account]);
    await insertEntry(c, saleEntry({ chargeId: charge, sellerId: seller, currency: "usd", amount: 10_000, fee: 1_030, occurredAt: 1 }));
  }
  await c.query("INSERT INTO stripe_objects (kind, id, seller_id, account_id, currency, amount, status, rank, created_at) VALUES ('payout', $1, $2, $3, 'usd', 5000, 'paid', 3, 1)", [W.payoutB, W.sellerB, W.accountB]);
  await insertEntry(c, payoutEntry({ payoutId: W.payoutB, sellerId: W.sellerB, currency: "usd", amount: 5_000, occurredAt: 2 }));
  await c.query("INSERT INTO stripe_events (id, type, account, subject, received_at, status) VALUES ($1, 'charge.succeeded', NULL, $2, 1, 'applied'), ($3, 'charge.succeeded', NULL, $4, 1, 'applied')", [W.eventA, W.chargeA, W.eventB, W.chargeB]);
}
