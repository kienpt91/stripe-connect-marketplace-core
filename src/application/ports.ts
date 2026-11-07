import type { AccountSnapshot } from "../domain/seller.js";
import type { Currency, FeePolicy } from "../domain/money.js";
import type { StripeBalance, StripeCharge, StripePayout } from "../domain/reconciliation.js";
import type { RefundStatus } from "../domain/stripe-events.js";
import type { Database } from "./store.js";

/** The only source of "now", in milliseconds since the epoch. Nothing in the domain or application layers reads the system clock. */
export interface Clock {
  now(): number;
}

/** A source of new identifiers (UUIDs). */
export interface IdGenerator {
  next(): string;
}

/** Structured logging. Callers never pass card data, names or e-mail addresses; ids and amounts only. */
export interface Logger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export type GatewayErrorCode = "invalid_request" | "authentication" | "not_found" | "rate_limited" | "unavailable" | "declined" | "unknown";

/** What a gateway throws. The message is a fixed sentence and never carries the provider's response body. */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  /** true when the same request may be sent again with the same idempotency key */
  readonly retryable: boolean;

  constructor(code: GatewayErrorCode, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.retryable = code === "rate_limited" || code === "unavailable";
  }
}

export interface CreateAccountInput {
  readonly sellerId: string;
  readonly country: string;
  /** the same key returns the same account: a retry after a crash does not create a second one */
  readonly idempotencyKey: string;
}

export interface CheckoutInput {
  readonly orderId: string;
  /** the connected account that receives the money (the destination of the charge) */
  readonly accountId: string;
  readonly amount: number;
  readonly currency: Currency;
  /** the application fee the platform keeps, computed by the platform and never by the caller */
  readonly applicationFee: number;
  readonly description: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly idempotencyKey: string;
}

export interface RefundInput {
  readonly chargeId: string;
  readonly amount: number;
  readonly orderId: string;
  readonly idempotencyKey: string;
}

/**
 * Everything the core asks of the payment provider. `FakeStripe` implements it for tests and the demo; `HttpStripeGateway` is the
 * adapter for the real API (never run against it, see SECURITY.md). A refund always reverses the transfer to the seller and
 * refunds the platform's fee in proportion: that is the money rule the ledger posts (docs/adr/0003).
 */
export interface StripeGateway {
  createAccount(input: CreateAccountInput): Promise<{ accountId: string }>;
  createAccountLink(input: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<{ url: string; expiresAt: number }>;
  retrieveAccount(accountId: string): Promise<AccountSnapshot>;
  createCheckoutSession(input: CheckoutInput): Promise<{ sessionId: string; url: string }>;
  createRefund(input: RefundInput): Promise<{ refundId: string; status: RefundStatus }>;
  retrieveBalance(accountId: string): Promise<StripeBalance[]>;
  /** payouts of a connected account created at or after `since` (ms) */
  listPayouts(accountId: string, since: number): Promise<StripePayout[]>;
  /** charges of the platform created at or after `since` (ms) */
  listCharges(since: number): Promise<StripeCharge[]>;
}

/** What every use case needs. */
export interface Deps {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly stripe: StripeGateway;
  readonly logger: Logger;
  readonly fees: FeePolicy;
  /** the one origin Stripe sends people back to, e.g. `https://marketplace.example` (see `parseOrigin`) */
  readonly appOrigin: string;
}
