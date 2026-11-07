import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { IngestResult } from "../../src/application/ingest.js";
import { SlidingWindowLimiter } from "../../src/infrastructure/http/limiter.js";
import { createWebhookServer, senderAddress, type WebhookServerOptions } from "../../src/infrastructure/http/server.js";
import { signBody, verifySignature } from "../../src/infrastructure/http/signature.js";
import { ManualClock } from "../../src/infrastructure/system.js";

const SECRET = "endpoint-secret-".padEnd(40, "s");
const OLD_SECRET = "previous-secret-".padEnd(40, "p");
const NOW = Date.UTC(2026, 10, 9, 9, 0);
const body = Buffer.from('{"id":"evt_1Example0001","type":"charge.succeeded"}');

describe("the webhook signature", () => {
  const header = signBody(SECRET, NOW, body);
  const hex = header.split("v1=")[1] as string;
  const verdict = (h: string | undefined, b: Buffer = body, secrets: readonly string[] = [SECRET], at = NOW + 1_000) => verifySignature(h, b, secrets, at, 300_000);

  it("accepts a fresh signature made with the endpoint secret", () => {
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verdict(header)).toBe("ok");
  });

  it("is Stripe's scheme: an HMAC-SHA256 of `<t>.<body>`, v1 only, any other scheme ignored", () => {
    expect(verdict(`${header},v0=${"0".repeat(64)}`)).toBe("ok");
    expect(verdict(`t=${Math.floor(NOW / 1000)},v0=${hex}`)).toBe("malformed"); // v0 alone is not a signature
    expect(verdict(`v1=${hex},v0=${"1".repeat(64)},t=${Math.floor(NOW / 1000)}`)).toBe("ok"); // order of the parts does not matter
  });

  it("accepts either of two signatures while a secret is rolled, and either of two secrets on our side", () => {
    const rolled = `t=${Math.floor(NOW / 1000)},v1=${"a".repeat(64)},v1=${hex}`;
    expect(verdict(rolled)).toBe("ok");
    expect(verdict(signBody(OLD_SECRET, NOW, body), body, [SECRET, OLD_SECRET])).toBe("ok");
    expect(verdict(signBody(OLD_SECRET, NOW, body), body, [SECRET])).toBe("mismatch");
  });

  it("refuses a wrong secret, a changed body and a changed timestamp", () => {
    expect(verdict(signBody("another-secret".padEnd(40, "a"), NOW, body))).toBe("mismatch");
    expect(verdict(header, Buffer.from('{"id":"evt_1Example0001","type":"charge.refunded"}'))).toBe("mismatch");
    expect(verdict(header.replace(/t=\d+/, `t=${Math.floor(NOW / 1000) + 1}`))).toBe("mismatch");
    expect(verdict(header, Buffer.alloc(0))).toBe("mismatch");
  });

  it("refuses a malformed or missing header without throwing", () => {
    const t = Math.floor(NOW / 1000);
    for (const h of [undefined, "", "garbage", "t=,v1=", `t=${t}`, `v1=${hex}`, `t=${t},v1=${hex.slice(1)}`, `t=${t},v1=${"z".repeat(64)}`, `t=${t},t=${t},v1=${hex}`, `t=abc,v1=${hex}`, `t=${t},v1`, `=${t},v1=${hex}`,
      `t=${t},${Array.from({ length: 5 }, () => `v1=${hex}`).join(",")}`, `t=${t},v1=${hex},${"x".repeat(1100)}`, `t=1234567890123,v1=${hex}`]) {
      expect(verdict(h), String(h).slice(0, 60)).toBe("malformed");
    }
  });

  it("refuses a signature older or newer than the tolerance, and accepts the boundary", () => {
    expect(verifySignature(header, body, [SECRET], NOW + 300_000, 300_000)).toBe("ok");
    expect(verifySignature(header, body, [SECRET], NOW + 301_000, 300_000)).toBe("stale");
    expect(verifySignature(header, body, [SECRET], NOW - 301_000, 300_000)).toBe("stale");
    expect(verifySignature(header, body, [SECRET], NOW + 10 * 60_000, 300_000)).toBe("stale");
  });

  it("checks the signature before the age, so an old forgery is a mismatch", () => {
    expect(verifySignature(signBody("another-secret".padEnd(40, "a"), NOW - 3_600_000, body), body, [SECRET], NOW, 300_000)).toBe("mismatch");
  });
});

describe("the sliding window limiter", () => {
  it("allows `max` hits per window and forgets them afterwards", () => {
    const l = new SlidingWindowLimiter(1_000, 2);
    expect([l.hit("a", 0), l.hit("a", 10), l.hit("a", 20)]).toEqual([true, true, false]);
    expect(l.hit("b", 20)).toBe(true);
    expect(l.hit("a", 1_005)).toBe(true);
  });

  it("does not count a refused hit, and forgets the least recently used key past its bound", () => {
    const l = new SlidingWindowLimiter(1_000, 1, 3);
    expect(l.hit("a", 0)).toBe(true);
    for (let i = 0; i < 5; i++) expect(l.hit("a", 100 + i)).toBe(false);
    expect(l.hit("a", 1_001)).toBe(true); // only the first hit counted
    for (const key of ["b", "c", "d", "e"]) l.hit(key, 2_000);
    expect(l.size).toBe(3);
    expect(l.hit("a", 2_001)).toBe(true); // forgotten
  });
});

describe("the webhook server", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
  });

  interface Started {
    readonly base: string;
    readonly received: unknown[];
    readonly logs: { level: string; event: string; fields?: Record<string, unknown> | undefined }[];
    readonly clock: ManualClock;
    post(payload: string, headers?: Record<string, string | undefined>): Promise<{ status: number; body: unknown; headers: Headers }>;
  }

  async function start(options: Partial<WebhookServerOptions> = {}, result: () => Promise<IngestResult> = async () => ({ status: "applied", eventId: "evt_1Example0001", reason: null })): Promise<Started> {
    const clock = new ManualClock(NOW);
    const received: unknown[] = [];
    const logs: Started["logs"] = [];
    const server = createWebhookServer({
      secrets: [SECRET],
      handler: { receive: async (event) => (received.push(event), result()), ready: async () => undefined },
      clock,
      logger: {
        info: (event, fields) => void logs.push({ level: "info", event, fields }),
        warn: (event, fields) => void logs.push({ level: "warn", event, fields }),
        error: (event, fields) => void logs.push({ level: "error", event, fields }),
      },
      ...options,
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (payload: string, headers: Record<string, string | undefined> = {}) => {
      const merged: Record<string, string> = { "content-type": "application/json", "stripe-signature": signBody(SECRET, clock.now(), payload) };
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined) delete merged[k];
        else merged[k] = v;
      }
      const r = await fetch(`${base}/webhooks/stripe`, { method: "POST", body: payload, headers: merged });
      return { status: r.status, body: await r.json(), headers: r.headers };
    };
    return { base, received, logs, clock, post };
  }

  const event = JSON.stringify({ id: "evt_1Example0001", type: "charge.succeeded", data: { object: {} } });

  it("hands a signed event to the handler and answers with what happened to it", async () => {
    const s = await start();
    const r = await s.post(event);
    expect(r).toMatchObject({ status: 200, body: { received: true, status: "applied" } });
    expect(s.received).toEqual([JSON.parse(event)]);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 200 for every outcome of the ingestion, a rejected event included: sending it again could not change the answer", async () => {
    for (const status of ["applied", "stale", "deferred", "rejected", "ignored", "duplicate"] as const) {
      const s = await start({}, async () => ({ status, eventId: "evt_1Example0001", reason: null }));
      expect(await s.post(event), status).toMatchObject({ status: 200, body: { received: true, status } });
    }
  });

  it("refuses a forged, altered, stale or missing signature without reading the body as JSON or calling the handler", async () => {
    const s = await start();
    const forged = signBody("another-secret".padEnd(40, "a"), NOW, event);
    for (const [name, headers, payload] of [
      ["forged", { "stripe-signature": forged }, event],
      ["altered body", { "stripe-signature": signBody(SECRET, NOW, event) }, event.replace("charge", "refund")],
      ["stale", { "stripe-signature": signBody(SECRET, NOW - 600_000, event) }, event],
      ["missing", { "stripe-signature": undefined }, event],
      ["malformed", { "stripe-signature": "t=1" }, event],
      ["not even JSON, unsigned", { "stripe-signature": "t=1,v1=" + "0".repeat(64) }, "not json"],
    ] as const) {
      const r = await s.post(payload, headers);
      expect(r, name).toMatchObject({ status: 401, body: { error: "invalid_signature" } });
    }
    expect(s.received).toEqual([]);
    expect(s.logs.filter((l) => l.event === "http.signature_refused").map((l) => l.fields?.["reason"])).toEqual(["mismatch", "mismatch", "stale", "malformed", "malformed", "mismatch"]);
  });

  it("answers a signed body that is not JSON with 400", async () => {
    const s = await start();
    expect(await s.post("not json")).toMatchObject({ status: 400, body: { error: "invalid_json" } });
    expect(s.received).toEqual([]);
  });

  it("answers 500 without detail when processing fails, so that Stripe sends the event again, and logs the error class only", async () => {
    const s = await start({}, async () => {
      throw new RangeError("a secret detail: acct_1Private");
    });
    const r = await s.post(event);
    expect(r).toMatchObject({ status: 500, body: { error: "internal_error" } });
    expect(JSON.stringify(r.body)).not.toContain("secret detail");
    expect(s.logs).toEqual([{ level: "error", event: "http.processing_failed", fields: { error: "RangeError" } }]);
  });

  it("limits the size of the body, declared or streamed, before reading it all", async () => {
    const s = await start({ maxBodyBytes: 2_048 });
    expect(await s.post(JSON.stringify({ filler: "x".repeat(3_000) }))).toMatchObject({ status: 413, body: { error: "payload_too_large" } });
    // no content-length: a chunked body that goes over the limit
    const answer = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${s.base}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", () => resolve(413));
      req.write("x".repeat(1_500));
      req.write("x".repeat(1_500));
      req.end();
      void reject;
    });
    expect(answer).toBe(413);
    expect(s.received).toEqual([]);
  });

  it("accepts only POST with a JSON content type on the one path, and answers the platform's health checks", async () => {
    const s = await start();
    expect((await fetch(`${s.base}/webhooks/stripe`, { method: "GET" })).status).toBe(405);
    expect((await fetch(`${s.base}/webhooks/stripe`, { method: "GET" })).headers.get("allow")).toBe("POST");
    expect((await fetch(`${s.base}/webhooks/other`, { method: "POST", body: event })).status).toBe(404);
    expect((await fetch(`${s.base}/`)).status).toBe(404);
    expect((await s.post(event, { "content-type": "text/plain" })).status).toBe(415);
    expect(await (await fetch(`${s.base}/healthz`)).json()).toEqual({ status: "ok" });
    expect(await (await fetch(`${s.base}/readyz`)).json()).toEqual({ status: "ready" });
    expect((await s.post(event, { "content-type": "application/json; charset=utf-8" })).status).toBe(200);
  });

  it("answers 503 on /readyz when the service cannot do its work", async () => {
    const clock = new ManualClock(NOW);
    const server = createWebhookServer({
      secrets: [SECRET],
      handler: { receive: async () => ({ status: "applied", eventId: null, reason: null }), ready: async () => Promise.reject(new Error("the database is down")) },
      clock,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/readyz`);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ status: "not_ready" });
  });
});

describe("what unauthenticated traffic can and cannot do", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
  });

  async function start(options: Partial<WebhookServerOptions> = {}) {
    const clock = new ManualClock(NOW);
    const logs: string[] = [];
    const server = createWebhookServer({
      secrets: [SECRET],
      handler: { receive: async () => ({ status: "applied", eventId: null, reason: null }), ready: async () => undefined },
      clock,
      logger: { info: () => undefined, warn: (e: string) => void logs.push(e), error: () => undefined },
      ...options,
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (headers: Record<string, string> = {}, payload = "{}") =>
      fetch(`${base}/webhooks/stripe`, { method: "POST", body: payload, headers: { "content-type": "application/json", "stripe-signature": signBody(SECRET, clock.now(), payload), ...headers } });
    return { post, clock, logs };
  }

  it("a flood of unsigned requests from one address is answered 429 and logged a bounded number of times, and never stops a signed request", async () => {
    const s = await start();
    let last = 0;
    for (let i = 0; i < 200; i++) last = (await s.post({ "stripe-signature": `t=1,v1=${"0".repeat(64)}` })).status;
    expect(last).toBe(429);
    expect((await s.post()).status).toBe(200);
    expect(s.logs.filter((l) => l === "http.signature_refused").length).toBeLessThanOrEqual(30);
  });

  it("counts failures only for a minute", async () => {
    const s = await start({ failuresPerMinute: 2 });
    const bad = () => s.post({ "stripe-signature": `t=1,v1=${"0".repeat(64)}` });
    expect([(await bad()).status, (await bad()).status, (await bad()).status]).toEqual([401, 401, 429]);
    s.clock.advance(61_000);
    expect((await bad()).status).toBe(401);
  });

  it("ignores X-Forwarded-For unless a trusted proxy is configured, and uses the entry the nearest proxy added when one is", async () => {
    const plain = await start({ failuresPerMinute: 1 });
    const bad = (s: typeof plain, forwarded: string) => s.post({ "stripe-signature": "t=1", "x-forwarded-for": forwarded });
    expect([(await bad(plain, "1.1.1.1")).status, (await bad(plain, "2.2.2.2")).status]).toEqual([401, 429]); // the header did not buy a new bucket
    const proxied = await start({ failuresPerMinute: 1, trustedProxyHops: 1 });
    expect([(await bad(proxied, "9.9.9.9, 1.1.1.1")).status, (await bad(proxied, "9.9.9.9, 2.2.2.2")).status, (await bad(proxied, "8.8.8.8, 1.1.1.1")).status]).toEqual([401, 401, 429]);
  });

  it("takes the socket address when the header is missing, shorter than the proxy depth, or absurd", () => {
    const req = (header: string | string[] | undefined, address = "10.0.0.1") => ({ headers: { "x-forwarded-for": header }, socket: { remoteAddress: address } }) as unknown as http.IncomingMessage;
    expect(senderAddress(req(undefined), 1)).toBe("10.0.0.1");
    expect(senderAddress(req("1.1.1.1"), 2)).toBe("10.0.0.1");
    expect(senderAddress(req("x".repeat(100)), 1)).toBe("10.0.0.1");
    expect(senderAddress(req(["1.1.1.1", "2.2.2.2"]), 1)).toBe("2.2.2.2");
    expect(senderAddress(req("1.1.1.1"), 0)).toBe("10.0.0.1");
    expect(senderAddress({ headers: {}, socket: {} } as unknown as http.IncomingMessage, 0)).toBe("unknown");
  });
});
