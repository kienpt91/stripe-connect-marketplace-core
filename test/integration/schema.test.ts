import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/infrastructure/postgres/migrate.js";
import { ADMIN_URL, asAdmin, createTestDatabase, describeDb, failure, MIGRATIONS, type TestDatabase } from "../support/pg.js";
import { insertEntry, seedWorld, W } from "../support/seed.js";
import { payoutEntry, saleEntry } from "../../src/domain/ledger.js";

const TABLES = ["ledger_entries", "ledger_lines", "orders", "payments", "sellers", "stripe_events", "stripe_objects"];

describeDb("the schema: what the database refuses on its own", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await asAdmin(db, seedWorld);
  });
  afterAll(async () => {
    await db.drop();
  });

  const sql = (text: string, params: unknown[] = []) => asAdmin(db, (c) => c.query(text, params));
  const refused = async (text: string, params: unknown[] = []) => failure(() => sql(text, params));

  it("has the seven tables and the migrations table, nothing else", async () => {
    const r = await sql("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname");
    expect(r.rows.map((x) => x.relname)).toEqual([...TABLES, "schema_migrations"].sort());
  });

  describe("orders", () => {
    const insert = (patch: Record<string, unknown>) => {
      const o = { id: "0a000000-0000-4000-8000-0000000000f1", seller: W.sellerA, buyer: "buyer-9", amount: 5000, currency: "usd", fee: 530, description: "Mug", status: "awaiting_payment", key: "purchase-schema01", ...patch };
      return refused(
        "INSERT INTO orders (id, seller_id, buyer_ref, amount, currency, fee, description, status, idempotency_key, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)",
        [o.id, o.seller, o.buyer, o.amount, o.currency, o.fee, o.description, o.status, o.key],
      );
    };

    it("accepts a sane order", async () => {
      expect(await insert({})).toBeUndefined();
      await sql("DELETE FROM orders WHERE id = '0a000000-0000-4000-8000-0000000000f1'");
    });

    it.each([
      ["a zero amount", { amount: 0 }], ["a negative amount", { amount: -1 }], ["an amount over what Stripe takes", { amount: 100_000_000 }],
      ["a fee equal to the amount", { fee: 5000 }], ["a negative fee", { fee: -1 }],
      ["an upper case currency", { currency: "USD" }], ["a currency of two letters", { currency: "us" }],
      ["an unknown status", { status: "shipped" }], ["an empty description", { description: "" }], ["a buyer reference with a space", { buyer: "a b" }],
      ["a short idempotency key", { key: "short" }], ["an idempotency key with a space", { key: "has space in it" }],
      ["an unknown seller", { seller: "5e11e700-0000-4000-8000-0000000000ee" }],
    ])("refuses %s", async (_name, patch) => {
      expect(await insert(patch)).toBeDefined();
    });

    it("refuses a second order with the same key for the same seller, and allows it for another", async () => {
      expect((await insert({ key: "purchase-aaaa0001" }))?.code).toBe("23505");
      expect(await insert({ key: "purchase-aaaa0001", seller: W.sellerB, id: "0a000000-0000-4000-8000-0000000000f2" })).toBeUndefined();
      await sql("DELETE FROM orders WHERE id = '0a000000-0000-4000-8000-0000000000f2'");
    });
  });

  describe("payments", () => {
    it("refuses a payment that names another seller's order", async () => {
      const f = await refused("INSERT INTO payments (charge_id, order_id, seller_id, account_id, currency, amount, fee, created_at) VALUES ('ch_1Mismatched01', $1, $2, $3, 'usd', 10000, 1030, 1)", [W.orderA, W.sellerB, W.accountB]);
      expect(f?.code).toBe("23503");
    });

    it("refuses totals that do not add up: more refunded than reversed, more reversed than the sale, a fee part over the fee", async () => {
      for (const set of ["refunded = 5, reversed = 4", "reversed = 10001", "reversed = 100, reversed_fee = 101", "reversed = 2000, reversed_fee = 1031", "refunded = -1"]) {
        const f = await refused(`UPDATE payments SET ${set} WHERE charge_id = $1`, [W.chargeA]);
        expect(f?.code, set).toBe("23514");
      }
    });

    it("refuses a fee that leaves nothing for the seller", async () => {
      const f = await refused("INSERT INTO payments (charge_id, order_id, seller_id, account_id, currency, amount, fee, created_at) VALUES ('ch_1NothingLeft1', $1, $2, $3, 'usd', 10000, 10000, 1)", [W.orderA, W.sellerA, W.accountA]);
      expect(f?.code).toBe("23514");
    });
  });

  describe("the state of a seller", () => {
    it("never leaves rejected, and never goes back to new", async () => {
      await sql("UPDATE sellers SET state = 'rejected' WHERE id = $1", [W.sellerA]);
      const back = await refused("UPDATE sellers SET state = 'enabled' WHERE id = $1", [W.sellerA]);
      expect(back?.code).toBe("23001");
      expect(back?.message).toContain("rejected");
      expect(await refused("UPDATE sellers SET state = 'rejected' WHERE id = $1", [W.sellerA])).toBeUndefined();
      const again = await refused("UPDATE sellers SET state = 'new' WHERE id = $1", [W.sellerB]);
      expect(again?.code).toBe("23001");
      await sql("UPDATE sellers SET state = 'enabled' WHERE id = $1", [W.sellerB]);
      await sql("ALTER TABLE sellers DISABLE TRIGGER sellers_state_guard");
      await sql("UPDATE sellers SET state = 'enabled' WHERE id = $1", [W.sellerA]); // what a superuser can do on purpose, and what an audit looks for
      await sql("ALTER TABLE sellers ENABLE TRIGGER sellers_state_guard");
    });

    it("refuses a malformed Stripe account id and a second seller on the same account", async () => {
      expect((await refused("UPDATE sellers SET stripe_account_id = 'cus_1NotAnAccount' WHERE id = $1", [W.sellerA]))?.code).toBe("23514");
      expect((await refused("UPDATE sellers SET stripe_account_id = $1 WHERE id = $2", [W.accountB, W.sellerA]))?.code).toBe("23505");
    });
  });

  describe("Stripe objects and events", () => {
    it("never lets a status move down in rank", async () => {
      expect((await refused("UPDATE stripe_objects SET rank = 2, status = 'in_transit' WHERE id = $1", [W.payoutB]))?.code).toBe("23001");
      expect(await refused("UPDATE stripe_objects SET rank = 4, status = 'failed' WHERE id = $1", [W.payoutB])).toBeUndefined();
      await sql("UPDATE stripe_objects SET rank = 3, status = 'paid' WHERE id = $1", [W.payoutB]).catch(() => undefined);
    });

    it("ties every object but a payout to a charge", async () => {
      expect((await refused("INSERT INTO stripe_objects (kind, id, seller_id, account_id, currency, amount, status, rank, created_at) VALUES ('refund', 're_1NoCharge0001', $1, $2, 'usd', 5, 'succeeded', 2, 1)", [W.sellerA, W.accountA]))?.code).toBe("23514");
      expect((await refused("INSERT INTO stripe_objects (kind, id, charge_id, seller_id, account_id, currency, amount, status, rank, created_at) VALUES ('payout', 'po_1HasCharge001', $1, $2, $3, 'usd', 5, 'paid', 3, 1)", [W.chargeA, W.sellerA, W.accountA]))?.code).toBe("23514");
      expect((await refused("INSERT INTO stripe_objects (kind, id, charge_id, seller_id, account_id, currency, amount, status, rank, created_at) VALUES ('refund', 're_1Unknown00001', 'ch_1DoesNotExist', $1, $2, 'usd', 5, 'succeeded', 2, 1)", [W.sellerA, W.accountA]))?.code).toBe("23503");
      expect((await refused("INSERT INTO stripe_objects (kind, id, seller_id, account_id, currency, amount, fee_part, status, rank, created_at) VALUES ('payout', 'po_1FeeTooBig001', $1, $2, 'usd', 5, 6, 'paid', 3, 1)", [W.sellerA, W.accountA]))?.code).toBe("23514");
    });

    it("keeps a payload only for the events that need one", async () => {
      const insert = (status: string, payload: string | null) =>
        refused("INSERT INTO stripe_events (id, type, subject, received_at, status, payload) VALUES ($1, 'x', 'y', 1, $2, $3)", [`evt_1Payload${status.padEnd(6, "0")}`, status, payload]);
      expect((await insert("applied", "{}"))?.code).toBe("23514");
      expect((await insert("ignored", "{}"))?.code).toBe("23514");
      expect(await insert("deferred", "{}")).toBeUndefined();
      expect(await insert("rejected", "{}")).toBeUndefined();
      expect(await insert("stale", null)).toBeUndefined();
    });

    it("refuses an event id of another shape and the same id twice", async () => {
      expect((await refused("INSERT INTO stripe_events (id, type, subject, received_at, status) VALUES ('cus_1NotAnEvent', 'x', 'y', 1, 'applied')"))?.code).toBe("23514");
      expect((await refused("INSERT INTO stripe_events (id, type, subject, received_at, status) VALUES ($1, 'x', 'y', 1, 'applied')", [W.eventA]))?.code).toBe("23505");
    });
  });

  describe("the ledger is append-only and every entry balances", () => {
    it("takes a balanced entry (the control for everything below)", async () => {
      await asAdmin(db, (c) => insertEntry(c, saleEntry({ chargeId: "ch_1ControlSale1", sellerId: W.sellerA, currency: "usd", amount: 500, fee: 80, occurredAt: 3 })));
      expect((await sql("SELECT count(*)::int AS n FROM ledger_lines l JOIN ledger_entries e ON e.seq = l.entry_seq WHERE e.posting_key = 'sale:ch_1ControlSale1'")).rows[0]?.n).toBe(3);
    });

    it.each(["ledger_entries", "ledger_lines"])("refuses UPDATE, DELETE and TRUNCATE on %s, even for the superuser", async (table) => {
      for (const statement of [`UPDATE ${table} SET amount = 1`, `DELETE FROM ${table}`, `TRUNCATE ${table} CASCADE`]) {
        if (table === "ledger_entries" && statement.startsWith("UPDATE")) continue; // entries have no amount column; covered below
        const f = await refused(statement);
        expect(f?.code, statement).toBe("23001");
        expect(f?.message, statement).toContain("append-only");
      }
      expect((await refused("UPDATE ledger_entries SET subject = 'x'"))?.code).toBe("23001");
      expect((await sql("SELECT count(*)::int AS n FROM ledger_entries")).rows[0]?.n).toBeGreaterThanOrEqual(4);
    });

    it("refuses an entry whose debits and credits differ, at COMMIT", async () => {
      const f = await failure(() =>
        asAdmin(db, async (c) => {
          await c.query("BEGIN");
          try {
            const head = await c.query("INSERT INTO ledger_entries (posting_key, kind, seller_id, currency, subject, occurred_at, line_count, total_minor) VALUES ('payout:po_1Unbalanced01', 'payout', $1, 'usd', 'po_1Unbalanced01', 1, 2, 700) RETURNING seq", [W.sellerA]);
            const seq = head.rows[0].seq as string;
            await c.query("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency, seller_id) VALUES ($1, 1, 'seller_balance', 'debit', 700, 'usd', $2)", [seq, W.sellerA]);
            await c.query("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency) VALUES ($1, 2, 'stripe_funds', 'credit', 699, 'usd')", [seq]);
            await c.query("COMMIT");
          } catch (error) {
            await c.query("ROLLBACK");
            throw error;
          }
        }),
      );
      expect(f?.code).toBe("23000");
      expect(f?.message).toContain("does not balance");
      expect((await sql("SELECT count(*)::int AS n FROM ledger_entries WHERE posting_key = 'payout:po_1Unbalanced01'")).rows[0]?.n).toBe(0);
    });

    it("refuses an entry without its lines, and a line added to an entry in a later transaction", async () => {
      const bare = await failure(() => sql("INSERT INTO ledger_entries (posting_key, kind, seller_id, currency, subject, occurred_at, line_count, total_minor) VALUES ('payout:po_1NoLines00001', 'payout', $1, 'usd', 'x', 1, 2, 5)", [W.sellerA]));
      expect(bare?.code).toBe("23000");
      const seq = (await sql("SELECT seq FROM ledger_entries WHERE posting_key = $1", [`payout:${W.payoutB}`])).rows[0]?.seq as string;
      const smuggled = await failure(() => sql("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency) VALUES ($1, 3, 'stripe_funds', 'debit', 1, 'usd')", [seq]));
      expect(smuggled?.code).toBe("23000");
      expect(smuggled?.message).toContain("does not balance");
    });

    it("refuses an entry whose declared total is not what its lines add up to", async () => {
      const f = await failure(() =>
        asAdmin(db, async (c) => {
          await c.query("BEGIN");
          try {
            const head = await c.query("INSERT INTO ledger_entries (posting_key, kind, seller_id, currency, subject, occurred_at, line_count, total_minor) VALUES ('payout:po_1WrongTotal01', 'payout', $1, 'usd', 'x', 1, 2, 800) RETURNING seq", [W.sellerA]);
            const seq = head.rows[0].seq as string;
            await c.query("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency, seller_id) VALUES ($1, 1, 'seller_balance', 'debit', 700, 'usd', $2), ($1, 2, 'stripe_funds', 'credit', 700, 'usd', NULL)", [seq, W.sellerA]);
            await c.query("COMMIT");
          } catch (error) {
            await c.query("ROLLBACK");
            throw error;
          }
        }),
      );
      expect(f?.code).toBe("23000");
    });

    it("refuses the same posting key twice, which is what makes a replay a no-op", async () => {
      const f = await failure(() => asAdmin(db, (c) => insertEntry(c, saleEntry({ chargeId: W.chargeA, sellerId: W.sellerA, currency: "usd", amount: 10_000, fee: 1_030, occurredAt: 1 }))));
      expect(f?.code).toBe("23505");
    });

    it("refuses a line that contradicts its entry or the chart of accounts", async () => {
      const lines = async (setup: string, params: unknown[], key: string) =>
        failure(() =>
          asAdmin(db, async (c) => {
            await c.query("BEGIN");
            try {
              const head = await c.query(`INSERT INTO ledger_entries (posting_key, kind, seller_id, currency, subject, occurred_at, line_count, total_minor) VALUES ('${key}', 'payout', $1, 'usd', 'x', 1, 2, 5) RETURNING seq`, [W.sellerA]);
              await c.query(setup, [head.rows[0].seq, ...params]);
              await c.query("COMMIT");
            } catch (error) {
              await c.query("ROLLBACK");
              throw error;
            }
          }),
        );
      // another currency than the entry's
      expect((await lines("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency) VALUES ($1, 1, 'stripe_funds', 'credit', 5, 'eur')", [], "payout:po_1OtherCurrency"))?.code).toBe("23503");
      // another seller than the entry's
      expect((await lines("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency, seller_id) VALUES ($1, 1, 'seller_balance', 'debit', 5, 'usd', $2)", [W.sellerB], "payout:po_1OtherSeller0"))?.code).toBe("23503");
      // a seller's account without a seller, a platform account with one, an unknown account, a zero amount, a bad side
      expect((await lines("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency) VALUES ($1, 1, 'seller_balance', 'debit', 5, 'usd')", [], "payout:po_1NoSeller0001"))?.code).toBe("23514");
      expect((await lines("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency, seller_id) VALUES ($1, 1, 'stripe_funds', 'debit', 5, 'usd', $2)", [W.sellerA], "payout:po_1PlatformSell"))?.code).toBe("23514");
      expect((await lines("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency) VALUES ($1, 1, 'cash', 'debit', 5, 'usd')", [], "payout:po_1UnknownAcct0"))?.code).toBe("23514");
      expect((await lines("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency) VALUES ($1, 1, 'stripe_funds', 'debit', 0, 'usd')", [], "payout:po_1ZeroAmount00"))?.code).toBe("23514");
      expect((await lines("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency) VALUES ($1, 1, 'stripe_funds', 'left', 5, 'usd')", [], "payout:po_1BadSide00000"))?.code).toBe("23514");
    });

    it("refuses an entry with a posting key, a kind or an amount that is not in the vocabulary", async () => {
      const head = (key: string, kind: string, total: number, count: number) =>
        refused("INSERT INTO ledger_entries (posting_key, kind, seller_id, currency, subject, occurred_at, line_count, total_minor) VALUES ($1, $2, $3, 'usd', 'x', 1, $4, $5)", [key, kind, W.sellerA, count, total]);
      expect((await head("has space:x", "payout", 5, 2))?.code).toBe("23514");
      expect((await head("payout:po_x", "bonus", 5, 2))?.code).toBe("23514");
      expect((await head("payout:po_y", "payout", 0, 2))?.code).toBe("23514");
      expect((await head("payout:po_z", "payout", 5, 1))?.code).toBe("23514");
    });

    it("sums seller balances exactly with bigint, to the minor unit", async () => {
      await asAdmin(db, (c) => insertEntry(c, payoutEntry({ payoutId: "po_1BigPayout001", sellerId: W.sellerB, currency: "usd", amount: 99_999_999, occurredAt: 9 })));
      const r = await sql("SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)::text AS balance FROM ledger_lines WHERE seller_id = $1 AND account = 'seller_balance'", [W.sellerB]);
      expect(r.rows[0]?.balance).toBe(String(8_970 - 5_000 - 99_999_999));
    });
  });

  describe("migrations", () => {
    it("applies once, recording a checksum, and reports the files already applied", async () => {
      const again = await migrate(db.adminUrl, MIGRATIONS);
      expect(again.applied).toEqual([]);
      expect(again.alreadyApplied).toHaveLength((await readdir(MIGRATIONS)).filter((n) => n.endsWith(".sql")).length);
      const rows = await sql("SELECT version, checksum FROM schema_migrations ORDER BY version");
      expect(rows.rows.map((r) => r.version)).toEqual(["0001_roles.sql", "0002_sellers_and_orders.sql", "0003_payments_objects_and_events.sql", "0004_ledger.sql", "0005_row_level_security.sql"]);
      for (const r of rows.rows) expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it("refuses a file that was edited after it was applied", async () => {
      const dir = await mkdtemp(join(tmpdir(), "migrations-"));
      try {
        await cp(MIGRATIONS, dir, { recursive: true });
        const file = join(dir, "0001_roles.sql");
        await writeFile(file, `${await readFile(file, "utf8")}\n-- edited later\n`);
        await expect(migrate(db.adminUrl, dir)).rejects.toThrow("0001_roles.sql was changed after it was applied");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("lets two deployments migrate a new database at the same time: one applies, the other waits and finds nothing to do", async () => {
      const name = `mk_mig_${Math.random().toString(16).slice(2, 10)}`;
      const server = new pg.Client({ connectionString: ADMIN_URL });
      await server.connect();
      try {
        await server.query(`CREATE DATABASE ${name}`);
        const u = new URL(ADMIN_URL);
        u.pathname = `/${name}`;
        const [one, two] = await Promise.all([migrate(u.toString(), MIGRATIONS), migrate(u.toString(), MIGRATIONS)]);
        expect([one.applied.length, two.applied.length].sort()).toEqual([0, 5]);
      } finally {
        await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await server.end();
      }
    });

    it("rolls a failing file back as a whole and records nothing", async () => {
      const dir = await mkdtemp(join(tmpdir(), "migrations-"));
      const name = `mk_bad_${Math.random().toString(16).slice(2, 10)}`;
      const server = new pg.Client({ connectionString: ADMIN_URL });
      await server.connect();
      try {
        await server.query(`CREATE DATABASE ${name}`);
        await writeFile(join(dir, "0001_one.sql"), "CREATE TABLE one (id int); CREATE TABLE one (id int);");
        const u = new URL(ADMIN_URL);
        u.pathname = `/${name}`;
        await expect(migrate(u.toString(), dir)).rejects.toThrow();
        const c = new pg.Client({ connectionString: u.toString() });
        await c.connect();
        try {
          expect((await c.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0]?.n).toBe(0);
          expect((await c.query("SELECT to_regclass('one') AS t")).rows[0]?.t).toBeNull();
        } finally {
          await c.end();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
        await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await server.end();
      }
    });
  });
});
