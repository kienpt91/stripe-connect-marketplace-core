import pg from "pg";
import { expect, it } from "vitest";
import { runDemo } from "../../src/demo/main.js";
import { createDemoDatabase } from "../../src/infrastructure/postgres/demo-database.js";
import { ADMIN_URL, describeDb } from "../support/pg.js";

const catalog = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
};

describeDb("the demonstration database", () => {
  it("creates a scratch database and a login role made for the run, and removes both", async () => {
    const demo = await createDemoDatabase(ADMIN_URL);
    try {
      expect(demo.name).toMatch(/^demo_[0-9a-f]{10}$/);
      expect(demo.serverVersion).toMatch(/^16\./);
      const roles = await catalog<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname LIKE 'marketplace_demo_%'");
      expect(roles).toHaveLength(1);
      const client = new pg.Client({ connectionString: demo.appUrl });
      await client.connect();
      try {
        expect((await client.query("SELECT current_user AS u")).rows[0]?.u).toBe(roles[0]?.rolname);
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE mkt_operator");
        expect((await client.query("SELECT count(*)::int AS n FROM sellers")).rows[0]?.n).toBe(0);
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    } finally {
      await demo.drop();
    }
    expect(await catalog("SELECT datname FROM pg_database WHERE datname = $1", [demo.name])).toEqual([]);
    expect(await catalog("SELECT rolname FROM pg_roles WHERE rolname LIKE 'marketplace_demo_%'")).toEqual([]);
  });

  it("never alters a role that was there before", async () => {
    await catalog("SELECT 1");
    const c = new pg.Client({ connectionString: ADMIN_URL });
    await c.connect();
    try {
      await c.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'marketplace_demo_keep') THEN CREATE ROLE marketplace_demo_keep LOGIN PASSWORD 'keep-this-password-0001'; END IF; END $$");
      const before = (await c.query("SELECT rolpassword FROM pg_authid WHERE rolname = 'marketplace_demo_keep'")).rows[0]?.rolpassword;
      const demo = await createDemoDatabase(ADMIN_URL);
      await demo.drop();
      expect((await c.query("SELECT rolpassword FROM pg_authid WHERE rolname = 'marketplace_demo_keep'")).rows[0]?.rolpassword).toBe(before);
      await c.query("DROP ROLE marketplace_demo_keep");
    } finally {
      await c.end();
    }
  });

  it("refuses a server that is not on this machine", async () => {
    await expect(createDemoDatabase("postgres://postgres@db.internal:5432/postgres")).rejects.toThrow("only runs against a server on loopback");
  });
});

describeDb("the demonstration", () => {
  it("runs end to end, every claim holds, and it leaves no database or role behind", async () => {
    const lines: string[] = [];
    const code = await runDemo(ADMIN_URL, (line) => lines.push(line));
    const text = lines.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("RESULT: every claim held (8 of 8).");
    for (const heading of ["1. a seller's onboarding", "2. checkout", "3. the webhook over HTTP", "4. a sale, a refund and a dispute", "5. a refund after the seller was paid out", "6. the webhook endpoint was down", "7. sellers cannot see each other's money", "8. the books"]) {
      expect(text).toContain(heading);
    }
    expect(text).not.toContain("NOT HELD");
    expect(text).toContain("HTTP 401");
    expect(text).toContain("the ledger is append-only");
    expect(await catalog("SELECT datname FROM pg_database WHERE datname LIKE 'demo_%'")).toEqual([]);
    expect(await catalog("SELECT rolname FROM pg_roles WHERE rolname LIKE 'marketplace_demo_%'")).toEqual([]);
  });
});
