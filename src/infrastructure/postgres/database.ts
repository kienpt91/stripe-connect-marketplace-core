import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import type { Actor, Database, Tx } from "../../application/store.js";
import { sqlState } from "./errors.js";
import { createRepositories } from "./repositories.js";

/** The database role each kind of actor works as. A fixed map: nothing the caller supplies is ever put into the SET ROLE statement. */
const ROLE: Readonly<Record<Actor["kind"], string>> = { seller: "mkt_seller", operator: "mkt_operator", system: "mkt_system" };

export interface PostgresOptions {
  /** connection string of the application's login role (not the owner of the schema) */
  readonly url: string;
  /** connections in the pool */
  readonly poolMax?: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  /** how many times a transaction that hit a deadlock or a serialization failure is run again */
  readonly maxAttempts?: number;
  /** called with the SQLSTATE of an error on an idle connection; never with a message that might hold data */
  readonly onPoolError?: (code: string) => void;
}

const RETRYABLE = new Set(["40001", "40P01"]);

/**
 * The PostgreSQL implementation of the persistence ports. Every transaction starts by switching into the role of the actor and
 * setting the identity claim that the row level security policies read; a transaction cannot run without them. A deadlock or
 * serialization failure runs the whole transaction again, a bounded number of times.
 */
export class PostgresDatabase implements Database {
  private readonly pool: pg.Pool;
  private readonly maxAttempts: number;
  private readonly onPoolError: (code: string) => void;

  constructor(options: PostgresOptions) {
    this.pool = new pg.Pool({
      connectionString: options.url,
      max: options.poolMax ?? 10,
      application_name: "stripe-connect-marketplace-core",
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: options.statementTimeoutMs ?? 10_000,
      lock_timeout: options.lockTimeoutMs ?? 5_000,
      idle_in_transaction_session_timeout: 30_000,
    });
    this.onPoolError = options.onPoolError ?? (() => undefined);
    // an error on an idle connection must not crash the process; the pool replaces the connection
    this.pool.on("error", (error) => this.onPoolError(sqlState(error) ?? "unknown"));
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async transaction<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      let broken = false;
      // the pool only listens to idle connections: one that dies while a transaction has it (the server restarts, an administrator
      // terminates the session) would otherwise raise an uncaught error and end the process. The connection is thrown away instead.
      const onError = (error: Error): void => {
        broken = true;
        this.onPoolError(sqlState(error) ?? "unknown");
      };
      client.on("error", onError);
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${ROLE[actor.kind]}`);
        await client.query("SELECT set_config('app.seller_id', $1, true)", [actor.kind === "seller" ? actor.sellerId : ""]);
        const result = await work(createRepositories(actor, client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {
          broken = true;
        });
        const code = sqlState(error);
        if (code !== undefined && RETRYABLE.has(code) && attempt < this.maxAttempts) {
          await sleep(10 * attempt + Math.floor(Math.random() * 20));
          continue;
        }
        throw error;
      } finally {
        client.off("error", onError);
        client.release(broken);
      }
    }
  }
}
