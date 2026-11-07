import { parseFeePolicy, type FeePolicy } from "../domain/money.js";
import { parseOrigin } from "../domain/url.js";

/** Configuration of `serve` and `reconcile`, read from the environment. */
export interface ServeConfig {
  readonly databaseUrl: string;
  /** the secret API key of the platform's Stripe account (a restricted key is better: docs/deployment.md) */
  readonly stripeSecretKey: string;
  /** the signing secrets of the webhook endpoints, newest first (one per endpoint: Stripe gives the Connect endpoint a secret of its own) */
  readonly webhookSecrets: readonly string[];
  /** the one origin people are sent back to after onboarding and checkout */
  readonly appOrigin: string;
  readonly fees: FeePolicy;
  readonly stripeApiVersion: string | undefined;
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly toleranceMs: number;
  /** reverse proxies in front of the server that append to X-Forwarded-For; 0 ignores the header */
  readonly trustedProxyHops: number;
}

const REQUIRED = ["DATABASE_URL", "STRIPE_SECRET_KEY", "WEBHOOK_SECRETS", "APP_ORIGIN"] as const;

function integer(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/** Reads the configuration from the environment. A missing variable is named; no value is ever printed. */
export function readServeConfig(env: Readonly<Record<string, string | undefined>>): ServeConfig {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  const get = (name: (typeof REQUIRED)[number]): string => env[name] as string;
  const secrets = get("WEBHOOK_SECRETS").split(",").map((s) => s.trim()).filter(Boolean);
  if (secrets.length === 0 || secrets.some((s) => s.length < 24 || /\s/.test(s))) throw new Error("every webhook secret must be at least 24 characters without spaces");
  const key = get("STRIPE_SECRET_KEY");
  if (key.length < 16 || /\s/.test(key)) throw new Error("STRIPE_SECRET_KEY does not look like a Stripe key");
  const origin = parseOrigin(get("APP_ORIGIN"));
  if (origin === undefined) throw new Error("APP_ORIGIN must be an https origin without a path (plain http is accepted for localhost only)");
  const port = Number(env["PORT"] ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a port number");
  const fees = parseFeePolicy({
    percentBps: integer(env, "FEE_PERCENT_BPS", 1000, 0, 10_000),
    fixedMinor: integer(env, "FEE_FIXED_MINOR", 30, 0, 99_999_999),
    minimumChargeMinor: integer(env, "MIN_CHARGE_MINOR", 100, 1, 99_999_999),
  });
  if (!fees.ok) throw new Error("the fee settings are not valid");
  return {
    databaseUrl: get("DATABASE_URL"),
    stripeSecretKey: key,
    webhookSecrets: secrets,
    appOrigin: origin,
    fees: fees.value,
    stripeApiVersion: env["STRIPE_API_VERSION"] === "" ? undefined : env["STRIPE_API_VERSION"],
    host: env["HOST"] ?? "127.0.0.1",
    port,
    maxBodyBytes: integer(env, "WEBHOOK_MAX_BODY_BYTES", 65_536, 1_024, 1_048_576),
    toleranceMs: integer(env, "WEBHOOK_TOLERANCE_SECONDS", 300, 5, 3_600) * 1000,
    trustedProxyHops: integer(env, "TRUSTED_PROXY_HOPS", 0, 0, 3),
  };
}
