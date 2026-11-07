import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compose, FakeStripe, ManualClock, webhookServer, type Composed } from "../../src/composition/compose.js";
import { startServer, type Running } from "../../src/composition/serve.js";
import { signBody } from "../../src/infrastructure/http/signature.js";
import { asAdmin, createTestDatabase, describeDb, type TestDatabase } from "../support/pg.js";
import { seedWorld, W } from "../support/seed.js";
import { handCharge, START } from "../support/world.js";
import type { SellerRecord } from "../../src/application/store.js";

const FEES = { percentBps: 1000, fixedMinor: 30, minimumChargeMinor: 100 };
const operator = { kind: "operator" } as const;

describeDb("the real server on PostgreSQL", () => {
  let database: TestDatabase;
  const secret = randomBytes(24).toString("hex");
  const seller = { id: W.sellerA, accountId: W.accountA } as SellerRecord;
  const order = (n: number) => `0a000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asAdmin(database, async (c) => {
      await seedWorld(c);
      for (let n = 1; n <= 4; n++) {
        await c.query(
          "INSERT INTO orders (id, seller_id, buyer_ref, amount, currency, fee, description, status, idempotency_key, created_at) VALUES ($1, $2, 'buyer-1', 10000, 'usd', 1030, 'Mug', 'awaiting_payment', $3, 1)",
          [order(n), W.sellerA, `purchase-server${n}`],
        );
      }
    });
  });
  afterAll(async () => {
    await database.drop();
  });

  const orderDetails = (n: number) => ({ id: order(n), amount: 10_000, fee: 1_030 });

  describe("composed with the fake Stripe", () => {
    let app: Composed;
    let base: string;
    let closeServer: () => Promise<void>;
    beforeAll(async () => {
      const clock = new ManualClock(START);
      app = compose({ databaseUrl: database.appUrl, fees: FEES, appOrigin: "https://market.example", stripe: new FakeStripe(clock), write: () => undefined, clock, poolMax: 10 });
      const server = webhookServer(app.deps, { secrets: [secret] });
      server.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
    });
    afterAll(async () => {
      await closeServer();
      await app.close();
    });

    const post = async (payload: unknown, header?: string) => {
      const text = JSON.stringify(payload);
      const r = await fetch(`${base}/webhooks/stripe`, { method: "POST", body: text, headers: { "content-type": "application/json", "stripe-signature": header ?? signBody(secret, START, text) } });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const balance = async () => (await app.deps.db.transaction(operator, (tx) => tx.ledger.balanceOf(W.sellerA)))["usd"] ?? 0;

    it("applies a signed charge, answers a replay with duplicate, and refuses a forged or altered request", async () => {
      const before = await balance();
      const charge = handCharge(seller, orderDetails(1));
      expect(await post(charge)).toEqual({ status: 200, body: { received: true, status: "applied" } });
      expect(await balance()).toBe(before + 8_970);
      expect(await post(charge)).toEqual({ status: 200, body: { received: true, status: "duplicate" } });
      expect(await post(handCharge(seller, orderDetails(2)), signBody(randomBytes(24).toString("hex"), START, "x"))).toMatchObject({ status: 401 });
      expect(await post(charge, signBody(secret, START, JSON.stringify({ ...charge, type: "charge.refunded" })))).toMatchObject({ status: 401 });
      expect(await balance()).toBe(before + 8_970);
    });

    it("applies a charge once when the same signed request arrives 20 times at the same moment", async () => {
      const before = await balance();
      const charge = handCharge(seller, orderDetails(3));
      const answers = await Promise.all(Array.from({ length: 20 }, () => post(charge)));
      expect(answers.filter((a) => a.body["status"] === "applied")).toHaveLength(1);
      expect(answers.filter((a) => a.body["status"] === "duplicate")).toHaveLength(19);
      expect(await balance()).toBe(before + 8_970);
    });

    it("answers 500 when the database fails under it, so that Stripe sends the event again, and applies it once the database is back", async () => {
      const charge = handCharge(seller, orderDetails(4));
      await asAdmin(database, (c) => c.query("REVOKE INSERT ON stripe_events FROM mkt_system"));
      try {
        expect(await post(charge)).toEqual({ status: 500, body: { error: "internal_error" } });
      } finally {
        await asAdmin(database, (c) => c.query("GRANT INSERT ON stripe_events TO mkt_system"));
      }
      expect(await app.deps.db.transaction(operator, async (tx) => (await tx.orders.get(order(4) as never))?.status)).toBe("awaiting_payment");
      expect(await post(charge)).toEqual({ status: 200, body: { received: true, status: "applied" } });
      expect(await app.deps.db.transaction(operator, async (tx) => (await tx.orders.get(order(4) as never))?.status)).toBe("paid");
    });

    it("reports ready while the database answers", async () => {
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
    });
  });

  describe("started the way `serve` starts it", () => {
    let running: Running;
    let base: string;
    beforeAll(async () => {
      const lines: string[] = [];
      running = await startServer(
        {
          databaseUrl: database.appUrl, stripeSecretKey: `key-${randomBytes(12).toString("hex")}`, webhookSecrets: [secret], appOrigin: "https://market.example", fees: FEES, stripeApiVersion: undefined,
          host: "127.0.0.1", port: 0, maxBodyBytes: 65_536, toleranceMs: 300_000, trustedProxyHops: 0,
        },
        (line) => lines.push(line),
      );
      base = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
    });

    it("listens, answers its health checks and takes a signed event for the real system clock", async () => {
      expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: "ok" });
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
      const text = JSON.stringify({ id: "evt_1ServeUnknown1", object: "event", type: "customer.created", created: 1, data: { object: { id: "cus_1Whatever001" } } });
      const r = await fetch(`${base}/webhooks/stripe`, { method: "POST", body: text, headers: { "content-type": "application/json", "stripe-signature": signBody(secret, Date.now(), text) } });
      expect(await r.json()).toEqual({ received: true, status: "ignored" });
    });

    it("stops listening when stopped", async () => {
      await running.stop();
      await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    });
  });
});
