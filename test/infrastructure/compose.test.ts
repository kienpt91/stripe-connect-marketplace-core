import { readdirSync } from "node:fs";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { compose, FakeStripe, HttpStripeGateway, ManualClock, MIGRATIONS_DIR, readServeConfig, webhookServer } from "../../src/composition/compose.js";
import { assertThrowawayServer } from "../../src/infrastructure/postgres/demo-database.js";

const ENV = {
  DATABASE_URL: "postgres://marketplace_app@db.internal:5432/marketplace",
  STRIPE_SECRET_KEY: "key-from-the-secret-store-0001",
  WEBHOOK_SECRETS: "first-endpoint-secret-0000000001, second-endpoint-secret-000000002",
  APP_ORIGIN: "https://market.example",
};

describe("the configuration", () => {
  it("reads the required variables and defaults the rest", () => {
    const c = readServeConfig(ENV);
    expect(c).toMatchObject({
      databaseUrl: ENV.DATABASE_URL, stripeSecretKey: ENV.STRIPE_SECRET_KEY, appOrigin: "https://market.example", host: "127.0.0.1", port: 8080, maxBodyBytes: 65_536, toleranceMs: 300_000,
      trustedProxyHops: 0, stripeApiVersion: undefined, fees: { percentBps: 1000, fixedMinor: 30, minimumChargeMinor: 100 },
    });
    expect(c.webhookSecrets).toEqual(["first-endpoint-secret-0000000001", "second-endpoint-secret-000000002"]);
  });

  it("reads every optional variable", () => {
    const c = readServeConfig({
      ...ENV, APP_ORIGIN: "http://localhost:3000", HOST: "0.0.0.0", PORT: "9090", FEE_PERCENT_BPS: "850", FEE_FIXED_MINOR: "25", MIN_CHARGE_MINOR: "200", WEBHOOK_MAX_BODY_BYTES: "4096",
      WEBHOOK_TOLERANCE_SECONDS: "60", TRUSTED_PROXY_HOPS: "2", STRIPE_API_VERSION: "2025-01-01",
    });
    expect(c).toMatchObject({ appOrigin: "http://localhost:3000", host: "0.0.0.0", port: 9090, fees: { percentBps: 850, fixedMinor: 25, minimumChargeMinor: 200 }, maxBodyBytes: 4096, toleranceMs: 60_000, trustedProxyHops: 2, stripeApiVersion: "2025-01-01" });
    expect(readServeConfig({ ...ENV, STRIPE_API_VERSION: "" }).stripeApiVersion).toBeUndefined();
  });

  it("names every missing variable and never prints a value", () => {
    expect(() => readServeConfig({})).toThrow("missing environment variables: DATABASE_URL, STRIPE_SECRET_KEY, WEBHOOK_SECRETS, APP_ORIGIN");
    expect(() => readServeConfig({ ...ENV, STRIPE_SECRET_KEY: "" })).toThrow("STRIPE_SECRET_KEY");
    for (const bad of [{ STRIPE_SECRET_KEY: "short" }, { WEBHOOK_SECRETS: "short-secret" }, { WEBHOOK_SECRETS: " , " }, { WEBHOOK_SECRETS: "has a space in the middle of it000" }, { APP_ORIGIN: "http://market.example" }, { APP_ORIGIN: "https://market.example/path" }]) {
      let message = "";
      try {
        readServeConfig({ ...ENV, ...bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(bad)).not.toBe("");
      for (const value of Object.values(ENV)) expect(message).not.toContain(value);
    }
  });

  it("refuses numbers out of range", () => {
    for (const bad of [{ PORT: "0" }, { PORT: "70000" }, { PORT: "x" }, { FEE_PERCENT_BPS: "10001" }, { FEE_PERCENT_BPS: "1.5" }, { FEE_FIXED_MINOR: "-1" }, { MIN_CHARGE_MINOR: "0" }, { WEBHOOK_MAX_BODY_BYTES: "10" }, { WEBHOOK_TOLERANCE_SECONDS: "1" }, { TRUSTED_PROXY_HOPS: "9" }]) {
      expect(() => readServeConfig({ ...ENV, ...bad }), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("the composition", () => {
  it("wires the given gateway, the clock and the logger into the dependencies, without connecting until it is used", async () => {
    const lines: string[] = [];
    const clock = new ManualClock(Date.UTC(2026, 10, 9));
    const stripe = new FakeStripe(clock);
    const app = compose({ databaseUrl: "postgres://nobody@127.0.0.1:1/none", fees: { percentBps: 500, fixedMinor: 0, minimumChargeMinor: 100 }, appOrigin: "https://market.example", stripe, write: (l) => void lines.push(l), clock });
    try {
      expect(app.deps.stripe).toBe(stripe);
      expect(app.deps.clock).toBe(clock);
      expect(app.deps.fees.percentBps).toBe(500);
      app.deps.logger.info("probe", { token: "must-not-appear", email: "a@b.example", fine: 1 });
      expect(JSON.parse(lines[0] as string)).toMatchObject({ event: "probe", token: "[redacted]", email: "[redacted]", fine: 1, ts: "2026-11-09T00:00:00.000Z", level: "info" });
    } finally {
      await app.close();
    }
  });

  it("builds the adapter for the real API from a key", async () => {
    const app = compose({ databaseUrl: "postgres://nobody@127.0.0.1:1/none", fees: { percentBps: 500, fixedMinor: 0, minimumChargeMinor: 100 }, appOrigin: "https://market.example", stripe: { secretKey: ENV.STRIPE_SECRET_KEY, apiVersion: "2025-01-01" }, write: () => undefined });
    try {
      expect(app.deps.stripe).toBeInstanceOf(HttpStripeGateway);
    } finally {
      await app.close();
    }
    const plain = compose({ databaseUrl: "postgres://nobody@127.0.0.1:1/none", fees: { percentBps: 500, fixedMinor: 0, minimumChargeMinor: 100 }, appOrigin: "https://market.example", stripe: { secretKey: ENV.STRIPE_SECRET_KEY }, write: () => undefined });
    expect(plain.deps.stripe).toBeInstanceOf(HttpStripeGateway);
    await plain.close();
  });

  it("builds a webhook server over the dependencies with the options it is given", async () => {
    const app = compose({ databaseUrl: "postgres://nobody@127.0.0.1:1/none", fees: { percentBps: 500, fixedMinor: 0, minimumChargeMinor: 100 }, appOrigin: "https://market.example", stripe: new FakeStripe(new ManualClock(0)), write: () => undefined });
    try {
      const server = webhookServer(app.deps, { secrets: ["s".repeat(32)], maxBodyBytes: 2_048, toleranceMs: 60_000, failuresPerMinute: 3, trustedProxyHops: 1 });
      expect(server).toBeInstanceOf(http.Server);
      expect(webhookServer(app.deps, { secrets: ["s".repeat(32)] })).toBeInstanceOf(http.Server);
    } finally {
      await app.close();
    }
  });

  it("ships the migrations in the package", () => {
    expect(readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql"))).toHaveLength(5);
  });
});

describe("the demonstration only runs against a server on this machine", () => {
  it("accepts loopback addresses and unix sockets", () => {
    for (const url of ["postgres://postgres@127.0.0.1:5432/postgres", "postgres://postgres@localhost/postgres", "postgres://postgres@[::1]:5432/postgres", "postgres:///postgres?host=/var/run/postgresql"]) {
      expect(() => assertThrowawayServer(url), url).not.toThrow();
    }
  });

  it("refuses everything else, and anything that is not a URL", () => {
    for (const url of ["postgres://postgres@db.internal:5432/postgres", "postgres://postgres@10.0.0.5/postgres", "postgres://postgres@127.0.0.1.evil.example/postgres", "postgres:///postgres?host=db.internal", "postgres:///postgres"]) {
      expect(() => assertThrowawayServer(url), url).toThrow("only runs against a server on loopback");
    }
    expect(() => assertThrowawayServer("not a url")).toThrow("not a valid URL");
  });
});
