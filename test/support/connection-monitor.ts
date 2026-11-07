import pg from "pg";
import { CONNECTION_BUDGET } from "./connection-budget.js";

/**
 * vitest globalSetup for the PostgreSQL run. Before the first test it asks the server how many connections it allows and refuses
 * to start when that is less than the budget (a clear message instead of "remaining connection slots are reserved" half way through).
 * While the tests run it samples the number of client connections; after the last test it prints the peak and fails the run when the
 * peak is over the budget.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const url = process.env.MARKETPLACE_TEST_DATABASE_URL;
  if (!url) return async () => undefined;
  const monitor = new pg.Client({ connectionString: url, application_name: "connection-monitor" });
  await monitor.connect();
  const limits = (await monitor.query("SELECT current_setting('max_connections')::int AS max, current_setting('superuser_reserved_connections')::int AS reserved")).rows[0] as { max: number; reserved: number };
  const usable = limits.max - limits.reserved;
  if (usable < CONNECTION_BUDGET) {
    await monitor.end();
    const message = `the test server allows ${usable} connections (max_connections ${limits.max}, ${limits.reserved} reserved); the suite budget is ${CONNECTION_BUDGET}. Raise max_connections or lower CONNECTION_BUDGET in test/support/connection-budget.ts.`;
    console.error(`\nCONNECTION BUDGET: ${message}\n`);
    throw new Error(message);
  }
  let peak = 0;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    monitor
      .query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend'")
      .then((r) => {
        peak = Math.max(peak, Number(r.rows[0]?.n));
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, 20);
  return async () => {
    clearInterval(timer);
    await monitor.end();
    console.log(`postgres connections: peak ${peak} of ${usable} usable (max_connections ${limits.max}, suite budget ${CONNECTION_BUDGET})`);
    if (peak > CONNECTION_BUDGET) {
      const message = `the suite used ${peak} connections at once; the budget is ${CONNECTION_BUDGET} (the CI service has ${usable})`;
      console.error(`\nCONNECTION BUDGET: ${message}\n`);
      throw new Error(message);
    }
  };
}
