import { ingestEvent } from "../application/ingest.js";
import type { Deps, StripeGateway } from "../application/ports.js";
import type { FeePolicy } from "../domain/money.js";
import { createWebhookServer } from "../infrastructure/http/server.js";
import { PostgresDatabase } from "../infrastructure/postgres/database.js";
import { HttpStripeGateway } from "../infrastructure/stripe/http-gateway.js";
import { JsonLogger, systemClock, uuidGenerator } from "../infrastructure/system.js";

export { migrate, MIGRATIONS_DIR } from "../infrastructure/postgres/migrate.js";
export { createDemoDatabase, type DemoDatabase } from "../infrastructure/postgres/demo-database.js";
export { createWebhookServer } from "../infrastructure/http/server.js";
export { signBody, verifySignature } from "../infrastructure/http/signature.js";
export { FakeStripe } from "../infrastructure/stripe/fake-stripe.js";
export { HttpStripeGateway } from "../infrastructure/stripe/http-gateway.js";
export { ManualClock, SequentialIds } from "../infrastructure/system.js";
export { readServeConfig, type ServeConfig } from "./config.js";

export interface CompositionConfig {
  /** connection string of the application's login role (a member of the three roles, not the schema owner) */
  readonly databaseUrl: string;
  readonly fees: FeePolicy;
  readonly appOrigin: string;
  /** the Stripe adapter: the real one when `stripeSecretKey` is given, or whatever the caller supplies (the fake, in tests and the demo) */
  readonly stripe: StripeGateway | { readonly secretKey: string; readonly apiVersion?: string | undefined };
  readonly poolMax?: number;
  readonly write: (line: string) => void;
  /** replaces the system clock and the id generator (the demo and the tests) */
  readonly clock?: Deps["clock"];
  readonly ids?: Deps["ids"];
}

export interface Composed {
  readonly deps: Deps;
  readonly database: PostgresDatabase;
  close(): Promise<void>;
}

const isGateway = (x: CompositionConfig["stripe"]): x is StripeGateway => "createAccount" in x;

/** Wires the adapters into the dependencies every use case takes. The only place that knows which adapter is which. */
export function compose(config: CompositionConfig): Composed {
  const clock = config.clock ?? systemClock;
  const logger = new JsonLogger(config.write, clock);
  const database = new PostgresDatabase({
    url: config.databaseUrl,
    poolMax: config.poolMax ?? 10,
    onPoolError: (code) => logger.error("database.pool_error", { code }),
  });
  const stripe = isGateway(config.stripe)
    ? config.stripe
    : new HttpStripeGateway({ secretKey: config.stripe.secretKey, ...(config.stripe.apiVersion === undefined ? {} : { apiVersion: config.stripe.apiVersion }) });
  const deps: Deps = { db: database, clock, ids: config.ids ?? uuidGenerator, stripe, logger, fees: config.fees, appOrigin: config.appOrigin };
  return { deps, database, close: () => database.close() };
}

export interface WebhookOptions {
  readonly secrets: readonly string[];
  readonly maxBodyBytes?: number;
  readonly toleranceMs?: number;
  readonly failuresPerMinute?: number;
  readonly trustedProxyHops?: number;
}

/** The webhook server over the composed dependencies. Not listening yet. */
export function webhookServer(deps: Deps, options: WebhookOptions) {
  return createWebhookServer({
    secrets: options.secrets,
    handler: { receive: (event) => ingestEvent(deps, event), ready: () => deps.db.ping() },
    clock: deps.clock,
    logger: deps.logger,
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.toleranceMs === undefined ? {} : { toleranceMs: options.toleranceMs }),
    ...(options.failuresPerMinute === undefined ? {} : { failuresPerMinute: options.failuresPerMinute }),
    ...(options.trustedProxyHops === undefined ? {} : { trustedProxyHops: options.trustedProxyHops }),
  });
}

