import { GatewayError, type CheckoutInput, type CreateAccountInput, type GatewayErrorCode, type RefundInput, type StripeGateway } from "../../application/ports.js";
import { parseStripeId, type StripePrefix } from "../../domain/ids.js";
import { isMinor, parseCurrency, type Currency } from "../../domain/money.js";
import type { StripeBalance, StripeCharge, StripePayout } from "../../domain/reconciliation.js";
import { parseAccountSnapshot, type AccountSnapshot } from "../../domain/seller.js";
import { PAYOUT_STATUSES, REFUND_STATUSES, type PayoutStatus, type RefundStatus } from "../../domain/stripe-events.js";

export interface HttpStripeGatewayOptions {
  readonly secretKey: string;
  /** an origin only; plain http is accepted for loopback so tests can run a local server */
  readonly baseUrl?: string;
  /** sent as `Stripe-Version` when given; otherwise the version pinned on the Stripe account applies */
  readonly apiVersion?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

type Field = readonly [name: string, value: string | number | boolean];
type Json = Record<string, unknown>;

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PAGES = 50;
const PAGE_SIZE = 100;
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/** One fixed sentence per code: a message never carries the response body, the key, a URL or a header. */
const MESSAGES: Readonly<Record<GatewayErrorCode, string>> = {
  invalid_request: "Stripe rejected the request as invalid.",
  authentication: "Stripe refused the credentials.",
  not_found: "Stripe does not know the requested object.",
  declined: "Stripe declined the request.",
  rate_limited: "Stripe is limiting the request rate.",
  unavailable: "Stripe could not be reached or did not answer in time.",
  unknown: "Stripe sent an answer that could not be used.",
};

const fail = (code: GatewayErrorCode): GatewayError => new GatewayError(code, MESSAGES[code]);

function codeForStatus(status: number): GatewayErrorCode {
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "not_found";
  if (status === 402) return "declined";
  if (status === 429) return "rate_limited";
  if (status === 408 || status >= 300 && status < 400 || status >= 500) return "unavailable";
  return "unknown";
}

/** Stripe reads nested keys written as `a[b][c]`; both names and values are percent-encoded. */
function encodeFields(fields: readonly Field[]): string {
  return fields.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`).join("&");
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname);
}

/** An https URL, or plain http to this machine; the only URLs the adapter hands back to callers. */
function parseSafeUrl(value: unknown): URL | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" || isLoopbackHttp(url) ? url : undefined;
}

function parseBaseUrl(value: string): string {
  const url = parseSafeUrl(value);
  const bare = url !== undefined && url.pathname === "/" && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  if (url === undefined || !bare) throw new Error("The Stripe base URL must be an https origin (http only for localhost) without path, credentials, query or fragment.");
  return url.origin;
}

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function stripeId(prefix: StripePrefix, value: unknown): string {
  const id = parseStripeId(prefix, value);
  if (id === undefined) throw fail("unknown");
  return id;
}

/** Ids and amounts we send are checked first, so a bad value is refused here and never reaches a URL or a form. */
function requestId(prefix: StripePrefix, value: string): string {
  const id = parseStripeId(prefix, value);
  if (id === undefined) throw fail("invalid_request");
  return id;
}

function requestMinor(value: number): number {
  if (!isMinor(value)) throw fail("invalid_request");
  return value;
}

function toSeconds(sinceMs: number): number {
  if (!Number.isFinite(sinceMs) || sinceMs < 0) throw fail("invalid_request");
  return Math.floor(sinceMs / 1000);
}

/** A Stripe timestamp in seconds, as milliseconds. */
function fromSeconds(value: unknown): number {
  if (!isInteger(value) || value < 0) throw fail("unknown");
  return value * 1000;
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T {
  const found = list.find((item) => item === value);
  if (found === undefined) throw fail("unknown");
  return found;
}

/** Reads at most `MAX_BODY_BYTES` from the stream; a larger answer is dropped without being buffered whole. */
async function readCapped(response: Response): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw fail("unknown");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw fail("unknown");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function parseJsonObject(bytes: Uint8Array): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw fail("unknown");
  }
  if (!isObject(parsed)) throw fail("unknown");
  return parsed;
}

function parseBalanceEntries(value: unknown): Map<Currency, number> {
  if (!Array.isArray(value)) throw fail("unknown");
  const sums = new Map<Currency, number>();
  for (const entry of value as unknown[]) {
    if (!isObject(entry) || !isInteger(entry["amount"])) throw fail("unknown");
    const currency = parseCurrency(entry["currency"]);
    if (currency === undefined) continue;
    const sum = (sums.get(currency) ?? 0) + entry["amount"];
    if (!Number.isSafeInteger(sum)) throw fail("unknown");
    sums.set(currency, sum);
  }
  return sums;
}

function parsePayout(value: unknown): StripePayout | undefined {
  if (!isObject(value)) throw fail("unknown");
  const currency = parseCurrency(value["currency"]);
  if (currency === undefined) return undefined;
  if (!isMinor(value["amount"])) throw fail("unknown");
  const status: PayoutStatus = oneOf(PAYOUT_STATUSES, value["status"]);
  return { id: stripeId("po", value["id"]), amount: value["amount"], currency, status, createdAt: fromSeconds(value["created"]) };
}

function parseDestination(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return stripeId("acct", isObject(value) ? value["id"] : value);
}

function parseCharge(value: unknown): StripeCharge | undefined {
  if (!isObject(value)) throw fail("unknown");
  if (value["status"] !== "succeeded") return undefined;
  const currency = parseCurrency(value["currency"]);
  if (currency === undefined) return undefined;
  const fee = value["application_fee_amount"] ?? null;
  if (!isMinor(value["amount"]) || !isMinor(value["amount_refunded"]) || (fee !== null && !isMinor(fee))) throw fail("unknown");
  const transferData = value["transfer_data"];
  const metadata = value["metadata"];
  const orderId = isObject(metadata) ? metadata["order_id"] : undefined;
  return {
    id: stripeId("ch", value["id"]),
    amount: value["amount"],
    currency,
    applicationFee: fee,
    amountRefunded: value["amount_refunded"],
    destination: parseDestination(isObject(transferData) ? transferData["destination"] : undefined),
    orderId: typeof orderId === "string" && orderId.length <= 64 ? orderId : null,
    createdAt: fromSeconds(value["created"]),
  };
}

/**
 * The adapter for the real Stripe API, written against `fetch` so it needs no SDK. It never retries: the caller owns retries and
 * repeats a request with the same idempotency key. It never follows a redirect, never logs, and never puts anything the server
 * said into an error message. Not exercised against the live API by this repository (see SECURITY.md).
 */
export class HttpStripeGateway implements StripeGateway {
  readonly #secretKey: string;
  readonly #baseUrl: string;
  readonly #apiVersion: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpStripeGatewayOptions) {
    if (options.secretKey === "" || /[\s\p{Cc}]/u.test(options.secretKey)) throw new Error("The Stripe secret key must be a non-empty string without whitespace or control characters.");
    this.#secretKey = options.secretKey;
    this.#baseUrl = parseBaseUrl(options.baseUrl ?? "https://api.stripe.com");
    this.#apiVersion = options.apiVersion;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async createAccount(input: CreateAccountInput): Promise<{ accountId: string }> {
    const body = await this.#post("/v1/accounts", input.idempotencyKey, [
      ["type", "express"],
      ["country", input.country],
      ["capabilities[card_payments][requested]", true],
      ["capabilities[transfers][requested]", true],
      ["metadata[seller_id]", input.sellerId],
    ]);
    return { accountId: stripeId("acct", body["id"]) };
  }

  async createAccountLink(input: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<{ url: string; expiresAt: number }> {
    const body = await this.#post("/v1/account_links", undefined, [
      ["account", requestId("acct", input.accountId)],
      ["refresh_url", input.refreshUrl],
      ["return_url", input.returnUrl],
      ["type", "account_onboarding"],
    ]);
    const url = parseSafeUrl(body["url"]);
    if (url === undefined) throw fail("unknown");
    return { url: url.href, expiresAt: fromSeconds(body["expires_at"]) };
  }

  async retrieveAccount(accountId: string): Promise<AccountSnapshot> {
    const body = await this.#get(`/v1/accounts/${requestId("acct", accountId)}`, [], undefined);
    const snapshot = parseAccountSnapshot(body);
    if (!snapshot.ok) throw fail("unknown");
    return snapshot.value;
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ sessionId: string; url: string }> {
    const fields: Field[] = [
      ["mode", "payment"],
      ["client_reference_id", input.orderId],
      ["success_url", input.successUrl],
      ["cancel_url", input.cancelUrl],
      ["line_items[0][quantity]", 1],
      ["line_items[0][price_data][currency]", input.currency],
      ["line_items[0][price_data][unit_amount]", requestMinor(input.amount)],
      ["line_items[0][price_data][product_data][name]", input.description],
    ];
    // Stripe refuses a zero fee on some account types, so a free sale simply carries no fee field.
    if (requestMinor(input.applicationFee) > 0) fields.push(["payment_intent_data[application_fee_amount]", input.applicationFee]);
    fields.push(
      ["payment_intent_data[transfer_data][destination]", requestId("acct", input.accountId)],
      ["payment_intent_data[metadata][order_id]", input.orderId],
      ["metadata[order_id]", input.orderId],
    );
    const body = await this.#post("/v1/checkout/sessions", input.idempotencyKey, fields);
    const url = body["url"];
    if (typeof url !== "string" || !url.startsWith("https://") || parseSafeUrl(url) === undefined) throw fail("unknown");
    return { sessionId: stripeId("cs", body["id"]), url };
  }

  async createRefund(input: RefundInput): Promise<{ refundId: string; status: RefundStatus }> {
    const body = await this.#post("/v1/refunds", input.idempotencyKey, [
      ["charge", requestId("ch", input.chargeId)],
      ["amount", requestMinor(input.amount)],
      ["reverse_transfer", true],
      ["refund_application_fee", true],
      ["metadata[order_id]", input.orderId],
    ]);
    return { refundId: stripeId("re", body["id"]), status: oneOf(REFUND_STATUSES, body["status"]) };
  }

  async retrieveBalance(accountId: string): Promise<StripeBalance[]> {
    const body = await this.#get("/v1/balance", [], requestId("acct", accountId));
    const available = parseBalanceEntries(body["available"]);
    const pending = parseBalanceEntries(body["pending"]);
    const currencies = new Set<Currency>([...available.keys(), ...pending.keys()]);
    return [...currencies].map((currency) => ({ currency, available: available.get(currency) ?? 0, pending: pending.get(currency) ?? 0 }));
  }

  async listPayouts(accountId: string, sinceMs: number): Promise<StripePayout[]> {
    return this.#list("/v1/payouts", toSeconds(sinceMs), requestId("acct", accountId), parsePayout);
  }

  async listCharges(sinceMs: number): Promise<StripeCharge[]> {
    return this.#list("/v1/charges", toSeconds(sinceMs), undefined, parseCharge);
  }

  /** Follows `has_more` for at most `MAX_PAGES` pages; a listing that never ends is an error and not an endless loop. */
  async #list<T>(path: string, sinceSeconds: number, account: string | undefined, parse: (item: unknown) => T | undefined): Promise<T[]> {
    const items: T[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query: Field[] = [["created[gte]", sinceSeconds], ["limit", PAGE_SIZE]];
      if (startingAfter !== undefined) query.push(["starting_after", startingAfter]);
      const body = await this.#get(path, query, account);
      const data = body["data"];
      if (!Array.isArray(data)) throw fail("unknown");
      for (const raw of data as unknown[]) {
        const item = parse(raw);
        if (item !== undefined) items.push(item);
      }
      if (body["has_more"] !== true) return items;
      const last: unknown = data[data.length - 1];
      const lastId = isObject(last) ? last["id"] : undefined;
      if (typeof lastId !== "string" || lastId === "") throw fail("unknown");
      startingAfter = lastId;
    }
    throw fail("unknown");
  }

  #get(path: string, query: readonly Field[], account: string | undefined): Promise<Json> {
    const suffix = query.length === 0 ? "" : `?${encodeFields(query)}`;
    return this.#send("GET", `${path}${suffix}`, this.#headers(account), undefined);
  }

  #post(path: string, idempotencyKey: string | undefined, fields: readonly Field[]): Promise<Json> {
    const headers = this.#headers(undefined);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
    return this.#send("POST", path, headers, encodeFields(fields));
  }

  #headers(account: string | undefined): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#secretKey}`, Accept: "application/json" };
    if (this.#apiVersion !== undefined) headers["Stripe-Version"] = this.#apiVersion;
    if (account !== undefined) headers["Stripe-Account"] = account;
    return headers;
  }

  async #send(method: "GET" | "POST", pathAndQuery: string, headers: Record<string, string>, body: string | undefined): Promise<Json> {
    let status: number;
    let bytes: Uint8Array | undefined;
    try {
      // "manual" hands back a 3xx as it is instead of following it with the credentials attached.
      const response = await this.#fetch(`${this.#baseUrl}${pathAndQuery}`, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(this.#timeoutMs) });
      status = response.status;
      if (status >= 200 && status < 300) bytes = await readCapped(response);
      else await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      throw error instanceof GatewayError ? error : fail("unavailable");
    }
    if (bytes === undefined) throw fail(codeForStatus(status));
    return parseJsonObject(bytes);
  }
}
