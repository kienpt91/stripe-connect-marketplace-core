import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GatewayError, type CheckoutInput, type GatewayErrorCode } from "../../src/application/ports.js";
import { HttpStripeGateway } from "../../src/infrastructure/stripe/http-gateway.js";
import { ACCT, CHARGE, ORDER, T0, accountObject, chargeObject, payoutObject } from "../support/stripe-fixtures.js";

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

type Reply = { readonly status: number; readonly body?: string; readonly headers?: Record<string, string> } | ((res: ServerResponse) => void);

const SECRET = `sk_test_${randomBytes(16).toString("hex")}`;
const IDEM = "idem-0001";
const SELLER = "0b000000-0000-4000-8000-000000000002";

let server: Server;
let port = 0;
let requests: Recorded[] = [];
let replies: Reply[] = [];

const json = (value: unknown, status = 200): Reply => ({ status, body: JSON.stringify(value), headers: { "content-type": "application/json" } });

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const reply = replies.shift();
      if (reply === undefined) {
        res.writeHead(500).end("no reply queued");
      } else if (typeof reply === "function") {
        reply(res);
      } else {
        res.writeHead(reply.status, reply.headers).end(reply.body ?? "");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  replies = [];
});

const baseUrl = (): string => `http://127.0.0.1:${port}`;
const gateway = (extra: Partial<ConstructorParameters<typeof HttpStripeGateway>[0]> = {}): HttpStripeGateway => new HttpStripeGateway({ secretKey: SECRET, baseUrl: baseUrl(), ...extra });

function only(): Recorded {
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (request === undefined) throw new Error("no request recorded");
  return request;
}

const form = (request: Recorded): [string, string][] => [...new URLSearchParams(request.body).entries()];
const query = (request: Recorded): URLSearchParams => new URL(request.url, "http://x").searchParams;
const path = (request: Recorded): string => new URL(request.url, "http://x").pathname;

async function failure(run: Promise<unknown>): Promise<GatewayError> {
  const error: unknown = await run.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(GatewayError);
  return error as GatewayError;
}

const charge = (patch: Record<string, unknown> = {}): Record<string, unknown> => chargeObject({ amount_refunded: 0, ...patch });

const checkout = (patch: Partial<CheckoutInput> = {}): CheckoutInput => ({
  orderId: ORDER, accountId: ACCT, amount: 1000, currency: "usd", applicationFee: 130, description: "Blue mug",
  successUrl: "https://shop.example/ok", cancelUrl: "https://shop.example/no", idempotencyKey: IDEM, ...patch,
});

describe("requests", () => {
  it("createAccount posts the form with the idempotency key", async () => {
    replies.push(json({ id: ACCT }));
    const result = await gateway().createAccount({ sellerId: SELLER, country: "US", idempotencyKey: IDEM });
    expect(result).toEqual({ accountId: ACCT });
    const request = only();
    expect(request.method).toBe("POST");
    expect(path(request)).toBe("/v1/accounts");
    expect(request.headers["authorization"]).toBe(`Bearer ${SECRET}`);
    expect(request.headers["idempotency-key"]).toBe(IDEM);
    expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(request.headers["accept"]).toBe("application/json");
    expect(request.headers["stripe-account"]).toBeUndefined();
    expect(request.headers["stripe-version"]).toBeUndefined();
    expect(form(request)).toEqual([
      ["type", "express"], ["country", "US"], ["capabilities[card_payments][requested]", "true"],
      ["capabilities[transfers][requested]", "true"], ["metadata[seller_id]", SELLER],
    ]);
    expect(request.body).toContain("capabilities%5Bcard_payments%5D%5Brequested%5D=true");
  });

  it("createAccountLink posts the account and urls and converts the expiry to milliseconds", async () => {
    replies.push(json({ url: "https://connect.stripe.example/setup/abc", expires_at: T0 }));
    const result = await gateway().createAccountLink({ accountId: ACCT, returnUrl: "https://shop.example/return", refreshUrl: "https://shop.example/refresh" });
    expect(result).toEqual({ url: "https://connect.stripe.example/setup/abc", expiresAt: T0 * 1000 });
    const request = only();
    expect(request.method).toBe("POST");
    expect(path(request)).toBe("/v1/account_links");
    expect(request.headers["idempotency-key"]).toBeUndefined();
    expect(form(request)).toEqual([
      ["account", ACCT], ["refresh_url", "https://shop.example/refresh"], ["return_url", "https://shop.example/return"], ["type", "account_onboarding"],
    ]);
  });

  it("retrieveAccount reads the account and returns a snapshot", async () => {
    replies.push(json(accountObject()));
    const snapshot = await gateway().retrieveAccount(ACCT);
    expect(snapshot.accountId).toBe(ACCT);
    const request = only();
    expect(request.method).toBe("GET");
    expect(path(request)).toBe(`/v1/accounts/${ACCT}`);
    expect(request.body).toBe("");
    expect(request.headers["content-type"]).toBeUndefined();
  });

  it("createCheckoutSession sends the destination charge fields and encodes special characters", async () => {
    replies.push(json({ id: "cs_1SessionAaaa", url: "https://checkout.stripe.example/c/pay/cs_1SessionAaaa" }));
    const description = "Mug & saucer: 100% «café» + ümlaut=1&x[y]=z";
    const result = await gateway().createCheckoutSession(checkout({ description }));
    expect(result).toEqual({ sessionId: "cs_1SessionAaaa", url: "https://checkout.stripe.example/c/pay/cs_1SessionAaaa" });
    const request = only();
    expect(request.method).toBe("POST");
    expect(path(request)).toBe("/v1/checkout/sessions");
    expect(request.headers["idempotency-key"]).toBe(IDEM);
    expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(form(request))).toEqual({
      mode: "payment", client_reference_id: ORDER, success_url: "https://shop.example/ok", cancel_url: "https://shop.example/no",
      "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": "1000",
      "line_items[0][price_data][product_data][name]": description, "payment_intent_data[application_fee_amount]": "130",
      "payment_intent_data[transfer_data][destination]": ACCT, "payment_intent_data[metadata][order_id]": ORDER, "metadata[order_id]": ORDER,
    });
    // the raw body has no unescaped separator characters inside the description
    expect(request.body).toContain("Mug%20%26%20saucer%3A%20100%25");
    expect(request.body.match(/&/g)?.length).toBe(11);
  });

  it("createCheckoutSession omits the fee field when the fee is zero", async () => {
    replies.push(json({ id: "cs_1SessionAaaa", url: "https://checkout.stripe.example/x" }));
    await gateway().createCheckoutSession(checkout({ applicationFee: 0 }));
    const fields = Object.fromEntries(form(only()));
    expect(fields).not.toHaveProperty("payment_intent_data[application_fee_amount]");
    expect(fields["line_items[0][price_data][unit_amount]"]).toBe("1000");
  });

  it("createRefund reverses the transfer and refunds the fee", async () => {
    replies.push(json({ id: "re_1RefundAaaaa", status: "pending" }));
    const result = await gateway().createRefund({ chargeId: CHARGE, amount: 500, orderId: ORDER, idempotencyKey: IDEM });
    expect(result).toEqual({ refundId: "re_1RefundAaaaa", status: "pending" });
    const request = only();
    expect(request.method).toBe("POST");
    expect(path(request)).toBe("/v1/refunds");
    expect(request.headers["idempotency-key"]).toBe(IDEM);
    expect(form(request)).toEqual([
      ["charge", CHARGE], ["amount", "500"], ["reverse_transfer", "true"], ["refund_application_fee", "true"], ["metadata[order_id]", ORDER],
    ]);
  });

  it("refuses ids and amounts that would not be valid before sending anything", async () => {
    const g = gateway();
    expect((await failure(g.retrieveAccount("../v1/balance"))).code).toBe("invalid_request");
    expect((await failure(g.retrieveBalance("nope"))).code).toBe("invalid_request");
    expect((await failure(g.createRefund({ chargeId: CHARGE, amount: 1.5, orderId: ORDER, idempotencyKey: IDEM }))).code).toBe("invalid_request");
    expect((await failure(g.listCharges(-1))).code).toBe("invalid_request");
    expect(requests).toHaveLength(0);
  });

  it("retrieveBalance acts as the connected account and sums entries per currency", async () => {
    replies.push(json({
      available: [{ amount: 1000, currency: "usd" }, { amount: 250, currency: "usd", source_types: { card: 250 } }, { amount: 70, currency: "eur" }, { amount: 5, currency: "xyz" }],
      pending: [{ amount: -300, currency: "usd" }, { amount: 40, currency: "gbp" }],
    }));
    const balances = await gateway().retrieveBalance(ACCT);
    expect(balances).toEqual([
      { currency: "usd", available: 1250, pending: -300 },
      { currency: "eur", available: 70, pending: 0 },
      { currency: "gbp", available: 0, pending: 40 },
    ]);
    const request = only();
    expect(request.method).toBe("GET");
    expect(path(request)).toBe("/v1/balance");
    expect(request.headers["stripe-account"]).toBe(ACCT);
    expect(request.headers["idempotency-key"]).toBeUndefined();
  });

  it("listPayouts follows has_more over three pages with starting_after", async () => {
    replies.push(
      json({ data: [payoutObject({ id: "po_1PayoutPage1a", created: T0 })], has_more: true }),
      json({ data: [payoutObject({ id: "po_1PayoutPage2a", status: "paid", amount: 90 }), payoutObject({ id: "po_1PayoutPage2b", currency: "xyz" })], has_more: true }),
      json({ data: [payoutObject({ id: "po_1PayoutPage3a", status: "in_transit", currency: "eur" })], has_more: false }),
    );
    const payouts = await gateway().listPayouts(ACCT, T0 * 1000 + 999);
    expect(payouts.map((p) => [p.id, p.amount, p.currency, p.status, p.createdAt])).toEqual([
      ["po_1PayoutPage1a", 700, "usd", "pending", T0 * 1000],
      ["po_1PayoutPage2a", 90, "usd", "paid", (T0 + 180) * 1000],
      ["po_1PayoutPage3a", 700, "eur", "in_transit", (T0 + 180) * 1000],
    ]);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.method).toBe("GET");
      expect(path(request)).toBe("/v1/payouts");
      expect(request.headers["stripe-account"]).toBe(ACCT);
      expect(query(request).get("created[gte]")).toBe(String(T0));
      expect(query(request).get("limit")).toBe("100");
    }
    expect(requests.map((r) => query(r).get("starting_after"))).toEqual([null, "po_1PayoutPage1a", "po_1PayoutPage2b"]);
  });

  it("listPayouts fails on a payout that does not parse", async () => {
    replies.push(json({ data: [payoutObject({ status: "exploded" })], has_more: false }));
    expect((await failure(gateway().listPayouts(ACCT, 0))).code).toBe("unknown");
  });

  it("listCharges maps charges, skips the ones that did not succeed and paginates", async () => {
    replies.push(
      json({ data: [charge({ id: "ch_1ChargePage1a" })], has_more: true }),
      json({
        data: [
          charge({ id: "ch_1ChargePage2a", status: "failed" }),
          charge({ id: "ch_1ChargePage2b", status: "pending" }),
          charge({ id: "ch_1ChargePage2c", metadata: {}, application_fee_amount: null, amount_refunded: 200 }),
        ],
        has_more: true,
      }),
      json({ data: [charge({ id: "ch_1ChargePage3a", transfer_data: { destination: { id: ACCT, object: "account" } }, metadata: { order_id: "x".repeat(65) } })], has_more: false }),
    );
    const charges = await gateway().listCharges(T0 * 1000);
    expect(charges).toEqual([
      { id: "ch_1ChargePage1a", amount: 1000, currency: "usd", applicationFee: 130, amountRefunded: 0, destination: ACCT, orderId: ORDER, createdAt: T0 * 1000 },
      { id: "ch_1ChargePage2c", amount: 1000, currency: "usd", applicationFee: null, amountRefunded: 200, destination: ACCT, orderId: null, createdAt: T0 * 1000 },
      { id: "ch_1ChargePage3a", amount: 1000, currency: "usd", applicationFee: 130, amountRefunded: 0, destination: ACCT, orderId: null, createdAt: T0 * 1000 },
    ]);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(path(request)).toBe("/v1/charges");
      expect(request.headers["stripe-account"]).toBeUndefined();
      expect(query(request).get("created[gte]")).toBe(String(T0));
      expect(query(request).get("limit")).toBe("100");
    }
    expect(requests.map((r) => query(r).get("starting_after"))).toEqual([null, "ch_1ChargePage1a", "ch_1ChargePage2c"]);
  });

  it("listCharges maps a charge without a destination to null", async () => {
    replies.push(json({ data: [charge({ transfer_data: null })], has_more: false }));
    const [mapped] = await gateway().listCharges(0);
    expect(mapped?.destination).toBeNull();
  });

  it("gives up after 50 pages instead of looping forever", async () => {
    for (let i = 0; i < 51; i += 1) replies.push(json({ data: [charge({ id: `ch_1Endless${String(i).padStart(4, "0")}` })], has_more: true }));
    const error = await failure(gateway().listCharges(0));
    expect(error.code).toBe("unknown");
    expect(requests).toHaveLength(50);
  });

  it("accepts a listing that ends exactly on page 50", async () => {
    for (let i = 0; i < 50; i += 1) replies.push(json({ data: [charge({ id: `ch_1Exact${String(i).padStart(5, "0")}` })], has_more: i < 49 }));
    expect(await gateway().listCharges(0)).toHaveLength(50);
    expect(requests).toHaveLength(50);
  });
});

describe("errors", () => {
  const cases: readonly (readonly [number, GatewayErrorCode, boolean])[] = [
    [400, "invalid_request", false], [422, "invalid_request", false], [401, "authentication", false], [403, "authentication", false],
    [404, "not_found", false], [402, "declined", false], [429, "rate_limited", true], [408, "unavailable", true],
    [500, "unavailable", true], [503, "unavailable", true], [302, "unavailable", true], [418, "unknown", false],
  ];

  it.each(cases)("maps HTTP %i to %s (retryable: %s) without leaking anything", async (status, code, retryable) => {
    const secretBody = JSON.stringify({ error: { message: "leaky-detail-from-stripe", param: "email" } });
    replies.push({ status, body: secretBody, headers: status === 302 ? { location: `http://127.0.0.1:${port}/elsewhere` } : {} });
    const error = await failure(gateway().retrieveAccount(ACCT));
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    for (const text of [error.message, error.name, String(error)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("leaky-detail");
      expect(text).not.toContain(ACCT);
      expect(text).not.toContain("127.0.0.1");
      expect(text).not.toContain("/v1/");
    }
    // a redirect is never followed
    expect(requests).toHaveLength(1);
  });

  it("does not follow a redirect with the credentials", async () => {
    replies.push({ status: 307, headers: { location: `${baseUrl()}/other` } }, json({}));
    expect((await failure(gateway().createRefund({ chargeId: CHARGE, amount: 1, orderId: ORDER, idempotencyKey: IDEM }))).code).toBe("unavailable");
    expect(requests).toHaveLength(1);
  });

  it("does not retry a failing request", async () => {
    replies.push({ status: 503 }, json({ id: ACCT }));
    expect((await failure(gateway().createAccount({ sellerId: SELLER, country: "US", idempotencyKey: IDEM }))).code).toBe("unavailable");
    expect(requests).toHaveLength(1);
  });

  it("rejects a body that is not JSON", async () => {
    replies.push({ status: 200, body: "<html>gateway</html>" });
    const error = await failure(gateway().retrieveAccount(ACCT));
    expect(error.code).toBe("unknown");
    expect(error.message).not.toContain("html");
  });

  it("rejects an empty body, a JSON array and a JSON null where an object is expected", async () => {
    replies.push({ status: 200, body: "" }, json([accountObject()]), json(null));
    for (let i = 0; i < 3; i += 1) expect((await failure(gateway().retrieveAccount(ACCT))).code).toBe("unknown");
  });

  it("rejects an answer larger than 1 MiB while it is streamed", async () => {
    let written = 0;
    replies.push((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"data":"');
      const chunk = "a".repeat(64 * 1024);
      const timer = setInterval(() => {
        if (res.destroyed || written > 4 * 1024 * 1024) {
          clearInterval(timer);
          res.end();
          return;
        }
        written += chunk.length;
        res.write(chunk);
      }, 1);
      res.on("close", () => clearInterval(timer));
    });
    const error = await failure(gateway().retrieveAccount(ACCT));
    expect(error.code).toBe("unknown");
    expect(written).toBeLessThan(4 * 1024 * 1024);
  });

  it("rejects an oversized answer announced by its content length", async () => {
    replies.push({ status: 200, body: JSON.stringify({ pad: "a".repeat(1024 * 1024 + 10) }), headers: { "content-type": "application/json" } });
    expect((await failure(gateway().retrieveAccount(ACCT))).code).toBe("unknown");
  });

  it("maps a connection closed without an answer to unavailable", async () => {
    replies.push((res) => res.socket?.destroy());
    const error = await failure(gateway().retrieveAccount(ACCT));
    expect(error.code).toBe("unavailable");
    expect(error.retryable).toBe(true);
  });

  it("maps a connection that dies in the middle of the body to unavailable", async () => {
    replies.push((res) => {
      res.writeHead(200, { "content-length": "500" });
      res.write("{");
      setTimeout(() => res.socket?.destroy(), 10);
    });
    expect((await failure(gateway().retrieveAccount(ACCT))).code).toBe("unavailable");
  });

  it("times out when the server never answers", async () => {
    const open: ServerResponse[] = [];
    replies.push((res) => { open.push(res); });
    const error = await failure(gateway({ timeoutMs: 50 }).retrieveAccount(ACCT));
    expect(error.code).toBe("unavailable");
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(SECRET);
    for (const res of open) res.socket?.destroy();
  });
});

describe("responses that must not be trusted", () => {
  it("rejects an account id that is not acct_...", async () => {
    replies.push(json({ id: "user_123456789" }));
    expect((await failure(gateway().createAccount({ sellerId: SELLER, country: "US", idempotencyKey: IDEM }))).code).toBe("unknown");
  });

  it("rejects an account object that does not parse", async () => {
    replies.push(json(accountObject({ charges_enabled: "yes" })));
    expect((await failure(gateway().retrieveAccount(ACCT))).code).toBe("unknown");
  });

  it("rejects an unknown refund status and a bad refund id", async () => {
    replies.push(json({ id: "re_1RefundAaaaa", status: "vanished" }), json({ id: "refund_1", status: "succeeded" }));
    const input = { chargeId: CHARGE, amount: 5, orderId: ORDER, idempotencyKey: IDEM };
    expect((await failure(gateway().createRefund(input))).code).toBe("unknown");
    expect((await failure(gateway().createRefund(input))).code).toBe("unknown");
  });

  it("rejects a checkout url that is not https and a session id that is not cs_...", async () => {
    replies.push(json({ id: "cs_1SessionAaaa", url: "http://evil.example/x" }), json({ id: "pi_1Intent0000", url: "https://checkout.stripe.example/x" }), json({ id: "cs_1SessionAaaa" }));
    for (let i = 0; i < 3; i += 1) expect((await failure(gateway().createCheckoutSession(checkout()))).code).toBe("unknown");
  });

  it("rejects an account link url that is not https, and a missing or bad expiry", async () => {
    replies.push(
      json({ url: "http://evil.example/x", expires_at: T0 }),
      json({ url: "javascript:alert(1)", expires_at: T0 }),
      json({ url: "https://connect.stripe.example/x", expires_at: "soon" }),
    );
    const input = { accountId: ACCT, returnUrl: "https://shop.example/r", refreshUrl: "https://shop.example/f" };
    for (let i = 0; i < 3; i += 1) expect((await failure(gateway().createAccountLink(input))).code).toBe("unknown");
  });

  it("rejects malformed balance entries and a listing without data", async () => {
    replies.push(json({ available: [{ amount: "10", currency: "usd" }], pending: [] }), json({ available: [], pending: "none" }), json({ has_more: false }));
    expect((await failure(gateway().retrieveBalance(ACCT))).code).toBe("unknown");
    expect((await failure(gateway().retrieveBalance(ACCT))).code).toBe("unknown");
    expect((await failure(gateway().listCharges(0))).code).toBe("unknown");
  });

  it("rejects has_more with an empty page", async () => {
    replies.push(json({ data: [], has_more: true }));
    expect((await failure(gateway().listCharges(0))).code).toBe("unknown");
    expect(requests).toHaveLength(1);
  });
});

describe("construction", () => {
  const refusal = /^The Stripe/;

  it("refuses an empty key and keys with whitespace or control characters, without echoing them", () => {
    for (const secretKey of ["", "sk key", `${SECRET}\n`, `${SECRET}\t`, `\u0000${SECRET}`, ` ${SECRET}`]) {
      let message = "";
      try {
        new HttpStripeGateway({ secretKey });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(refusal);
      expect(message).not.toContain("sk key");
      expect(message).not.toContain(SECRET);
    }
  });

  it("refuses base urls that are plain http to a remote host, or carry a path, credentials, query or fragment", () => {
    const bad = [
      "http://api.example", "http://api.stripe.com", "ftp://api.stripe.com", "not a url", "",
      "https://api.stripe.com/v1", "https://user:pass@api.stripe.com", "https://api.stripe.com?x=1", "https://api.stripe.com/#frag",
      "http://127.0.0.1:1/v1", "http://127.0.0.1.example",
    ];
    for (const url of bad) expect(() => new HttpStripeGateway({ secretKey: SECRET, baseUrl: url }), url).toThrow(refusal);
  });

  it("accepts the Stripe origin and loopback http", () => {
    expect(() => new HttpStripeGateway({ secretKey: SECRET })).not.toThrow();
    expect(() => new HttpStripeGateway({ secretKey: SECRET, baseUrl: "https://api.stripe.com" })).not.toThrow();
    expect(() => new HttpStripeGateway({ secretKey: SECRET, baseUrl: "https://api.stripe.com/" })).not.toThrow();
    for (const url of ["http://localhost:8080", "http://127.0.0.1:12111", "http://[::1]:3000"]) {
      expect(() => new HttpStripeGateway({ secretKey: SECRET, baseUrl: url }), url).not.toThrow();
    }
  });

  it("sends Stripe-Version only when an api version is configured", async () => {
    replies.push(json(accountObject()), json(accountObject()));
    await gateway().retrieveAccount(ACCT);
    await gateway({ apiVersion: "2025-01-27.acacia" }).retrieveAccount(ACCT);
    expect(requests[0]?.headers["stripe-version"]).toBeUndefined();
    expect(requests[1]?.headers["stripe-version"]).toBe("2025-01-27.acacia");
  });

  it("uses the injected fetch and the configured origin", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      return Promise.resolve(new Response(JSON.stringify({ id: ACCT }), { status: 200 }));
    }) as typeof fetch;
    const result = await new HttpStripeGateway({ secretKey: SECRET, fetchImpl }).createAccount({ sellerId: SELLER, country: "DE", idempotencyKey: IDEM });
    expect(result).toEqual({ accountId: ACCT });
    expect(requests).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/accounts");
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
  });

  it("maps an error thrown by the injected fetch to unavailable without its text", async () => {
    const fetchImpl = ((): Promise<Response> => Promise.reject(new Error(`connect failed for ${SECRET}`))) as typeof fetch;
    const error = await failure(new HttpStripeGateway({ secretKey: SECRET, fetchImpl }).retrieveAccount(ACCT));
    expect(error.code).toBe("unavailable");
    expect(error.message).not.toContain(SECRET);
  });
});
