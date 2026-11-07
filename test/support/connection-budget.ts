import { PostgresDatabase, type PostgresOptions } from "../../src/infrastructure/postgres/database.js";

/**
 * The connection budget of the PostgreSQL tests. PostgreSQL allows 100 connections by default and keeps 3 for superusers; the
 * service container of the CI job runs with that default, so the whole suite has to fit in it. The rules:
 *   - test files run one at a time (vitest.config.ts: no file parallelism, one worker), so the budget is per file;
 *   - a file opens its pools through `openPool`, which counts the largest number of connections each pool may open and refuses a
 *     pool that would take the file past the budget;
 *   - the biggest need is the concurrent deliveries of the same event (8 at once, 6 per group in the shuffled runs), which hold one
 *     connection each through one bounded pool of 10; the other tests of the file use the same pool.
 * test/support/connection-monitor.ts checks the server's limit before the run and the measured peak after it.
 */
export const CONNECTION_BUDGET = 40;
/** connections kept for what is not a pool: the superuser client of the harness (seeding, scans), the server client that creates a database */
export const TRANSIENT_ALLOWANCE = 5;

let declared = 0;

/** Counts a pool of `max` connections; throws when the pools that are open together could exceed the budget. Returns the function that gives them back. */
export function declarePool(label: string, max: number): () => void {
  if (declared + max + TRANSIENT_ALLOWANCE > CONNECTION_BUDGET) {
    throw new Error(`connection budget exceeded: ${label} wants ${max} connections, ${declared} are already declared, the budget is ${CONNECTION_BUDGET} (${TRANSIENT_ALLOWANCE} are kept for the harness)`);
  }
  declared += max;
  let released = false;
  return () => {
    if (!released) declared -= max;
    released = true;
  };
}

export function declaredConnections(): number {
  return declared;
}

/** A PostgreSQL database for a test, with its pool counted in the budget; `close` gives the connections back. */
export function openPool(options: PostgresOptions): PostgresDatabase {
  const release = declarePool("a test pool", options.poolMax ?? 10);
  const db = new PostgresDatabase(options);
  const close = db.close.bind(db);
  db.close = async () => {
    release();
    await close();
  };
  return db;
}
