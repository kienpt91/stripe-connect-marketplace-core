import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { describe } from "vitest";
import { migrate } from "../../src/infrastructure/postgres/migrate.js";

/** The superuser URL of the throwaway server started by scripts/integration.sh. Without it the database suites are skipped. */
export const ADMIN_URL = process.env.MARKETPLACE_TEST_DATABASE_URL ?? "";
export const describeDb = ADMIN_URL === "" ? describe.skip : describe;
export const MIGRATIONS = resolve(import.meta.dirname, "../../migrations");

export interface TestDatabase {
  readonly name: string;
  /** superuser connection string of this database: used to seed rows and to look at what the roles cannot */
  readonly adminUrl: string;
  /** connection string of the unprivileged login role the application uses */
  readonly appUrl: string;
  drop(): Promise<void>;
}

function withDatabase(url: string, database: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user !== undefined) u.username = user;
  if (password !== undefined) u.password = password;
  return u.toString();
}

/** A fresh database with every migration applied and a login role that can only switch into the three application roles. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `mk_${randomBytes(6).toString("hex")}`;
  const server = new pg.Client({ connectionString: ADMIN_URL });
  await server.connect();
  const password = randomBytes(16).toString("hex");
  try {
    await server.query(`CREATE DATABASE ${name}`);
  } finally {
    await server.end();
  }
  const adminUrl = withDatabase(ADMIN_URL, name);
  await migrate(adminUrl, MIGRATIONS);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // roles are cluster-wide: one login role for the whole run, its password rotated per database
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mkt_app') THEN CREATE ROLE mkt_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF; END $$`);
    await admin.query(`ALTER ROLE mkt_app PASSWORD '${password}'`);
    await admin.query("GRANT mkt_seller, mkt_operator, mkt_system TO mkt_app");
  } finally {
    await admin.end();
  }
  return {
    name,
    adminUrl,
    appUrl: withDatabase(ADMIN_URL, name, "mkt_app", password),
    async drop() {
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

export type DbRole = "mkt_seller" | "mkt_operator" | "mkt_system";

export interface Claims {
  readonly role: DbRole;
  readonly sellerId?: string;
}

/**
 * Runs `fn` in a transaction on the application's login role, switched into `claims.role` with the identity claim set, exactly as the
 * adapter does it. The transaction is rolled back unless `commit` is true.
 */
export async function withClaims<T>(db: TestDatabase, claims: Claims, fn: (client: pg.Client) => Promise<T>, commit = false): Promise<T> {
  const client = new pg.Client({ connectionString: db.appUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${claims.role}`);
    if (claims.sellerId !== undefined) await client.query("SELECT set_config('app.seller_id', $1, true)", [claims.sellerId]);
    const result = await fn(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** Runs statements as the superuser of the test database (seeding, and looking at what the roles cannot see). */
export async function asAdmin<T>(db: TestDatabase, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: db.adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The SQLSTATE and message of the error a statement raises, or undefined when it succeeds. */
export async function failure(run: () => Promise<unknown>): Promise<{ code: string; constraint?: string; message: string } | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; constraint?: string; message?: string };
    return { code: e.code ?? "unknown", ...(e.constraint !== undefined ? { constraint: e.constraint } : {}), message: e.message ?? "" };
  }
}
