#!/usr/bin/env node
import { compose, migrate, MIGRATIONS_DIR, readServeConfig } from "./composition/compose.js";
import { startServer } from "./composition/serve.js";
import { reconcile } from "./application/reconcile.js";
import { formatFindings } from "./domain/reconciliation.js";
import { runDemo } from "./demo/main.js";

const USAGE = `usage: stripe-connect-marketplace-core <command>

  migrate     apply the SQL migrations. DATABASE_ADMIN_URL: the schema owner's connection string.
  serve       start the webhook server. See docs/deployment.md for the environment variables.
  reconcile   compare the ledger with Stripe and print every difference (exit 1 when there is an error). SINCE_DAYS: how far back (default 30).
  demo        run the demonstration against a throwaway server. DEMO_ADMIN_URL: its superuser connection string.
`;

async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number> {
  const command = argv[0];
  if (command === "migrate") {
    const url = env["DATABASE_ADMIN_URL"];
    if (!url) return fail("DATABASE_ADMIN_URL is not set");
    const report = await migrate(url, MIGRATIONS_DIR);
    console.log(`applied ${report.applied.length} migration(s), ${report.alreadyApplied.length} already applied`);
    return 0;
  }
  if (command === "serve") {
    const config = readServeConfig(env);
    const running = await startServer(config, (line) => console.log(line));
    const stop = (): void => void running.stop().then(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return -1;
  }
  if (command === "reconcile") {
    const config = readServeConfig(env);
    const days = Number(env["SINCE_DAYS"] ?? "30");
    if (!Number.isInteger(days) || days < 1 || days > 400) return fail("SINCE_DAYS must be a whole number of days from 1 to 400");
    const app = compose({ databaseUrl: config.databaseUrl, fees: config.fees, appOrigin: config.appOrigin, stripe: { secretKey: config.stripeSecretKey, apiVersion: config.stripeApiVersion }, write: () => undefined });
    try {
      const result = await reconcile(app.deps, { since: app.deps.clock.now() - days * 86_400_000 });
      if (!result.ok) return fail("Stripe could not be read; nothing was compared");
      console.log(`compared ${result.value.sellers} sellers, ${result.value.payments} sales and ${result.value.payouts} payouts since ${new Date(result.value.since).toISOString()}`);
      for (const line of formatFindings(result.value.findings)) console.log(line);
      return result.value.findings.some((f) => f.severity === "error") ? 1 : 0;
    } finally {
      await app.close();
    }
  }
  if (command === "demo") {
    const url = env["DEMO_ADMIN_URL"];
    if (!url) return fail("DEMO_ADMIN_URL is not set (it must be the superuser URL of a throwaway server; see scripts/demo.sh)");
    return runDemo(url, (line) => console.log(line));
  }
  console.error(USAGE);
  return command === undefined || command === "help" || command === "--help" ? 0 : 2;
}

function fail(message: string): number {
  console.error(message);
  return 2;
}

main(process.argv.slice(2), process.env).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exitCode = 1;
  },
);
