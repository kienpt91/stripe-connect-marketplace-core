import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate, MIGRATIONS_DIR } from "./migrate.js";

export interface DemoDatabase {
  readonly name: string;
  /** connection string of a login role made for this run alone: what `compose` takes as `databaseUrl` */
  readonly appUrl: string;
  readonly serverVersion: string;
  /** runs statements as the superuser of the scratch database: what the demo's attacks use to show that even the owner is refused */
  asAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T>;
  drop(): Promise<void>;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The demo creates databases and roles and runs the migrations (which create the cluster-wide application roles) with a superuser
 * connection. It therefore only talks to a server on this machine: a loopback address or a unix socket directory. The scripts
 * start a throwaway container whose network is the demo's own; there is no switch to point it elsewhere.
 */
export function assertThrowawayServer(serverAdminUrl: string): void {
  let url: URL;
  try {
    url = new URL(serverAdminUrl);
  } catch {
    throw new Error("the demo server URL is not a valid URL");
  }
  const socket = url.searchParams.get("host");
  const local = LOOPBACK.has(url.hostname) || (url.hostname === "" && socket !== null && socket.startsWith("/"));
  if (!local) throw new Error("the demo only runs against a server on loopback or a unix socket: it creates roles and databases as a superuser");
}

function withUser(url: string, database: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user !== undefined) u.username = user;
  if (password !== undefined) u.password = password;
  return u.toString();
}

/**
 * Creates a scratch database on a throwaway server, applies the migrations and creates a login role with a name made for this run
 * (never an existing role: nothing here alters a role that was there before). `drop` removes the database and the role.
 */
export async function createDemoDatabase(serverAdminUrl: string): Promise<DemoDatabase> {
  assertThrowawayServer(serverAdminUrl);
  const suffix = randomBytes(5).toString("hex");
  const name = `demo_${suffix}`;
  const role = `marketplace_demo_${suffix}`;
  const password = randomBytes(16).toString("hex");
  const server = new pg.Client({ connectionString: serverAdminUrl });
  await server.connect();
  let serverVersion = "unknown";
  try {
    await server.query(`CREATE DATABASE ${name}`);
    serverVersion = String((await server.query("SHOW server_version")).rows[0]?.server_version ?? "unknown");
  } finally {
    await server.end();
  }
  const adminUrl = withUser(serverAdminUrl, name);
  await migrate(adminUrl, MIGRATIONS_DIR);
  const asAdmin = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  await asAdmin(async (c) => {
    await c.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${password}'`);
    await c.query(`GRANT mkt_seller, mkt_operator, mkt_system TO ${role}`);
  });
  return {
    name,
    appUrl: withUser(serverAdminUrl, name, role, password),
    serverVersion,
    asAdmin,
    async drop() {
      const s = new pg.Client({ connectionString: serverAdminUrl });
      await s.connect();
      try {
        await s.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await s.query(`DROP ROLE IF EXISTS ${role}`);
      } finally {
        await s.end();
      }
    },
  };
}
