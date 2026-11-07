import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, createTestDatabase, describeDb, failure, withClaims, type Claims, type TestDatabase } from "../support/pg.js";
import { seedWorld, W } from "../support/seed.js";

const sellerA: Claims = { role: "mkt_seller", sellerId: W.sellerA };
const sellerB: Claims = { role: "mkt_seller", sellerId: W.sellerB };
const operator: Claims = { role: "mkt_operator" };
const system: Claims = { role: "mkt_system" };

const TABLES = ["ledger_entries", "ledger_lines", "orders", "payments", "sellers", "stripe_events", "stripe_objects"];
/** the tables a seller may read, and the column that carries the seller's id */
const SELLER_READS: Record<string, string> = { sellers: "id", orders: "seller_id", payments: "seller_id", stripe_objects: "seller_id", ledger_entries: "seller_id", ledger_lines: "seller_id" };

describeDb("row level security: who can see and change what", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await asAdmin(db, seedWorld);
  });
  afterAll(async () => {
    await db.drop();
  });

  const rows = async (claims: Claims, sql: string, params: unknown[] = []) => withClaims(db, claims, async (c) => (await c.query(sql, params)).rows);
  const count = async (claims: Claims, table: string, where = "true") => Number((await rows(claims, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0]?.n);

  describe("the roles", () => {
    it("are not superusers, cannot bypass row level security, own nothing, and only the login role logs in", async () => {
      const r = await asAdmin(db, (c) => c.query("SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname IN ('mkt_app', 'mkt_seller', 'mkt_operator', 'mkt_system')"));
      expect(r.rows).toHaveLength(4);
      for (const role of r.rows) expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
      expect(r.rows.filter((x) => x.rolcanlogin).map((x) => x.rolname)).toEqual(["mkt_app"]);
      const owned = await asAdmin(db, (c) => c.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname LIKE 'mkt_%'"));
      expect(owned.rows[0]?.n).toBe(0);
    });

    it("force row level security on every table, the owner included", async () => {
      const r = await asAdmin(db, (c) => c.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> 'schema_migrations' ORDER BY relname"));
      expect(r.rows.map((x) => x.relname)).toEqual(TABLES);
      for (const t of r.rows) expect(t, t.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it("cannot be left for a role the login role is not a member of, and the login role alone can read nothing", async () => {
      expect((await failure(() => withClaims(db, sellerA, (c) => c.query("SET ROLE postgres"))))?.code).toBe("42501");
      for (const table of TABLES) {
        const f = await failure(async () => {
          const c = new pg.Client({ connectionString: db.appUrl });
          await c.connect();
          try {
            await c.query(`SELECT 1 FROM ${table} LIMIT 1`);
          } finally {
            await c.end();
          }
        });
        expect(f?.code, table).toBe("42501");
      }
    });

    it("cannot read the migrations table", async () => {
      expect((await failure(() => rows(system, "SELECT * FROM schema_migrations")))?.code).toBe("42501");
      expect((await failure(() => rows(sellerA, "SELECT * FROM schema_migrations")))?.code).toBe("42501");
    });
  });

  describe("without an identity", () => {
    it.each(Object.keys(SELLER_READS))("%s returns nothing to a seller who has no seller id", async (table) => {
      expect(await count({ role: "mkt_seller" }, table)).toBe(0);
      expect(await count({ role: "mkt_seller", sellerId: "" }, table)).toBe(0);
    });

    it("fails a statement with a claim that is not a UUID instead of guessing", async () => {
      for (const bad of ["not-a-uuid", "' OR 1=1 --", "5e11e700-0000-4000-8000-00000000000a OR true"]) {
        const f = await failure(() => rows({ role: "mkt_seller", sellerId: bad }, "SELECT * FROM orders"));
        expect(f?.code, bad).toBe("22P02");
      }
    });
  });

  describe("a seller", () => {
    it.each(Object.entries(SELLER_READS))("sees only their own rows of %s", async (table, column) => {
      const own = await rows(sellerA, `SELECT ${column} AS who FROM ${table}`);
      // only the second seller was paid out, so the first has no payout object
      if (table !== "stripe_objects") expect(own.length).toBeGreaterThan(0);
      for (const r of own) expect(r.who).toBe(W.sellerA);
      // asking for the other seller's rows by id returns nothing, not an error
      expect(await count(sellerA, table, `${column} = '${W.sellerB}'`)).toBe(0);
      expect(await count(sellerA, table, `${column} <> '${W.sellerA}'`)).toBe(0);
      const theirs = await rows(sellerB, `SELECT ${column} AS who FROM ${table}`);
      expect(theirs.length).toBeGreaterThan(0);
      expect(theirs.every((r) => r.who === W.sellerB)).toBe(true);
    });

    it("cannot read another seller's ledger by any query: join, subquery, union, aggregate, by id", async () => {
      expect(await rows(sellerA, `SELECT l.amount FROM ledger_lines l JOIN ledger_entries e ON e.seq = l.entry_seq WHERE e.posting_key = $1`, [`sale:${W.chargeB}`])).toEqual([]);
      expect(await rows(sellerA, `SELECT * FROM ledger_lines WHERE entry_seq IN (SELECT seq FROM ledger_entries WHERE seller_id = $1)`, [W.sellerB])).toEqual([]);
      expect(await rows(sellerA, `SELECT seller_id FROM ledger_lines UNION ALL SELECT seller_id FROM ledger_entries WHERE seller_id = $1`, [W.sellerB])).toEqual(
        (await rows(sellerA, `SELECT seller_id FROM ledger_lines`)),
      );
      expect((await rows(sellerA, `SELECT coalesce(sum(amount), 0)::int AS total FROM ledger_lines WHERE seller_id = $1`, [W.sellerB]))[0]?.total).toBe(0);
      expect((await rows(sellerA, `SELECT count(*)::int AS n FROM ledger_lines`))[0]?.n).toBe(1);
      expect((await rows(sellerB, `SELECT count(*)::int AS n FROM ledger_lines`))[0]?.n).toBe(2);
    });

    it("sees the lines of their own account only: the platform's side of an entry is hidden", async () => {
      const visible = await rows(sellerA, `SELECT account, side, amount FROM ledger_lines`);
      expect(visible).toEqual([{ account: "seller_balance", side: "credit", amount: "8970" }]);
      const all = await asAdmin(db, (c) => c.query(`SELECT account FROM ledger_lines l JOIN ledger_entries e ON e.seq = l.entry_seq WHERE e.seller_id = $1 ORDER BY line_no`, [W.sellerA]));
      expect(all.rows.map((r) => r.account)).toEqual(["stripe_funds", "seller_balance", "platform_fees"]);
    });

    it("cannot read the event log", async () => {
      expect((await failure(() => rows(sellerA, "SELECT * FROM stripe_events")))?.code).toBe("42501");
    });

    const SOME_COLUMN: Record<string, string> = {
      sellers: "created_at", orders: "created_at", payments: "created_at", stripe_objects: "created_at", stripe_events: "received_at", ledger_entries: "occurred_at", ledger_lines: "amount",
    };
    it.each(TABLES)("cannot insert, update or delete in %s", async (table) => {
      for (const statement of [`DELETE FROM ${table}`, `UPDATE ${table} SET ${SOME_COLUMN[table]} = 0`, `INSERT INTO ${table} DEFAULT VALUES`]) {
        const f = await failure(() => rows(sellerA, statement));
        expect(f?.code, `${table}: ${statement}`).toBe("42501");
      }
    });
  });

  describe("an operator", () => {
    it("reads every row of every table and writes none", async () => {
      for (const table of TABLES) expect(await count(operator, table), table).toBeGreaterThan(0);
      expect(await count(operator, "ledger_lines")).toBe(8);
      for (const table of TABLES) {
        expect((await failure(() => rows(operator, `DELETE FROM ${table}`)))?.code, table).toBe("42501");
        expect((await failure(() => rows(operator, `INSERT INTO ${table} DEFAULT VALUES`)))?.code, table).toBe("42501");
      }
      expect((await failure(() => rows(operator, "UPDATE sellers SET state = 'rejected'")))?.code).toBe("42501");
    });
  });

  describe("the system", () => {
    it("reads and inserts, and updates only the columns the flows change", async () => {
      expect(await count(system, "sellers")).toBe(2);
      for (const [table, column] of [
        ["sellers", "stripe_account_id"], ["sellers", "display_name"], ["sellers", "created_at"],
        ["orders", "amount"], ["orders", "fee"], ["orders", "seller_id"], ["orders", "idempotency_key"],
        ["payments", "amount"], ["payments", "fee"], ["payments", "seller_id"], ["payments", "order_id"],
        ["stripe_objects", "amount"], ["stripe_objects", "seller_id"], ["stripe_events", "id"], ["stripe_events", "subject"],
      ] as const) {
        const f = await failure(() => rows(system, `UPDATE ${table} SET ${column} = ${column}`));
        expect(f?.code, `${table}.${column}`).toBe("42501");
      }
      for (const statement of [
        "UPDATE sellers SET observed_at = observed_at", "UPDATE orders SET status = status", "UPDATE payments SET refunded = refunded",
        "UPDATE stripe_objects SET status = status", "UPDATE stripe_events SET reason = reason",
      ]) expect(await failure(() => rows(system, statement)), statement).toBeUndefined();
    });

    it("cannot delete anything, anywhere", async () => {
      for (const table of TABLES) expect((await failure(() => rows(system, `DELETE FROM ${table}`)))?.code, table).toBe("42501");
    });

    it("can append to the ledger and never change or remove a line of it", async () => {
      expect((await failure(() => rows(system, "UPDATE ledger_entries SET subject = 'x'")))?.code).toBe("42501");
      expect((await failure(() => rows(system, "UPDATE ledger_lines SET amount = 1")))?.code).toBe("42501");
      expect((await failure(() => rows(system, "TRUNCATE ledger_lines")))?.code).toBe("42501");
      const before = await asAdmin(db, (c) => c.query("SELECT count(*)::int AS n FROM ledger_lines"));
      expect((await failure(() => withClaims(db, system, (c) => c.query("INSERT INTO ledger_entries (posting_key, kind, seller_id, currency, subject, occurred_at, line_count, total_minor) VALUES ('payout:po_1RlsAppend01', 'payout', $1, 'usd', 'x', 1, 2, 5)", [W.sellerA]), false)))?.code).toBe(undefined);
      const after = await asAdmin(db, (c) => c.query("SELECT count(*)::int AS n FROM ledger_lines"));
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    });

    it("cannot read the identity claim of a seller it is not acting as, because it has none: it is the whole platform", async () => {
      expect(await count(system, "orders")).toBe(2);
      expect(await count({ role: "mkt_system", sellerId: W.sellerA }, "orders")).toBe(2);
    });
  });
});
