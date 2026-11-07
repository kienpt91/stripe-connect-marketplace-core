import { err, ok, type Result } from "./result.js";

/**
 * Money is an integer number of minor units (cents, pence, yen) and a currency, never a floating point number. The
 * currencies below are the ones whose minor unit exponent is known here; anything else is refused instead of guessed.
 */
export const CURRENCY_EXPONENT = { usd: 2, eur: 2, gbp: 2, cad: 2, aud: 2, chf: 2, sek: 2, jpy: 0, krw: 0 } as const;
export type Currency = keyof typeof CURRENCY_EXPONENT;

export function parseCurrency(value: unknown): Currency | undefined {
  return typeof value === "string" && Object.hasOwn(CURRENCY_EXPONENT, value) ? (value as Currency) : undefined;
}

/** The largest charge Stripe accepts: eight digits in the minor unit. */
export const MAX_CHARGE_MINOR = 99_999_999;

/** A non-negative whole number that a JavaScript number holds exactly. */
export function isMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Sums that cannot silently lose precision: an overflow throws instead of rounding. */
export function addMinor(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new RangeError("amount overflow");
  return sum;
}

/** `12.34 USD` for two decimals, `1234 JPY` for none. For people and demos; nothing is parsed back from it. */
export function formatMinor(amount: number, currency: Currency): string {
  const exponent = CURRENCY_EXPONENT[currency];
  const sign = amount < 0 ? "-" : "";
  const digits = String(Math.abs(amount)).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? "" : `.${digits.slice(digits.length - exponent)}`;
  return `${sign}${whole}${fraction} ${currency.toUpperCase()}`;
}

/**
 * The platform's commission: a percentage in basis points (1 bp = 0.01 %) plus a fixed amount, both in integers.
 * `minimumChargeMinor` is the smallest charge the marketplace accepts, which keeps the fixed part from eating a small sale.
 */
export interface FeePolicy {
  readonly percentBps: number;
  readonly fixedMinor: number;
  readonly minimumChargeMinor: number;
}

export function parseFeePolicy(value: { percentBps: unknown; fixedMinor: unknown; minimumChargeMinor: unknown }): Result<FeePolicy, "invalid_fee_policy"> {
  const { percentBps, fixedMinor, minimumChargeMinor } = value;
  if (!isMinor(percentBps) || percentBps > 10_000) return err("invalid_fee_policy");
  if (!isMinor(fixedMinor) || fixedMinor > MAX_CHARGE_MINOR) return err("invalid_fee_policy");
  if (!isMinor(minimumChargeMinor) || minimumChargeMinor < 1 || minimumChargeMinor > MAX_CHARGE_MINOR) return err("invalid_fee_policy");
  return ok({ percentBps, fixedMinor, minimumChargeMinor });
}

export interface Split {
  /** the application fee the platform keeps */
  readonly fee: number;
  /** what the seller receives: the charge less the fee, at least 1 */
  readonly sellerNet: number;
}

export type SplitError = "invalid_amount" | "amount_below_minimum" | "amount_above_maximum" | "fee_not_below_amount";

/**
 * The fee of a charge: `amount * percentBps / 10000` rounded half up, plus the fixed part. The product is computed in BigInt, so it
 * is an exact integer division whatever the limits are set to (at the Stripe maximum it stays below 2^53 anyway). A fee that
 * would leave the seller nothing is refused, never clipped: a silent cap would change the commission the seller agreed to.
 */
export function splitCharge(policy: FeePolicy, amount: number): Result<Split, SplitError> {
  if (!Number.isSafeInteger(amount) || amount < 1) return err("invalid_amount");
  if (amount < policy.minimumChargeMinor) return err("amount_below_minimum");
  if (amount > MAX_CHARGE_MINOR) return err("amount_above_maximum");
  const percent = (BigInt(amount) * BigInt(policy.percentBps) + 5_000n) / 10_000n;
  const fee = percent + BigInt(policy.fixedMinor);
  if (fee >= BigInt(amount)) return err("fee_not_below_amount");
  return ok({ fee: Number(fee), sellerNet: amount - Number(fee) });
}

/** A sale as the allocation rule sees it: what the buyer paid and how much of it was the platform's fee. */
export interface Sale {
  readonly amount: number;
  readonly fee: number;
}

/** What has already been taken back from a sale: refunds and lost disputes together, and the part of that which was the fee. */
export interface Taken {
  readonly amount: number;
  readonly fee: number;
}

export interface Reversal {
  /** the platform's part of the amount taken back */
  readonly feePart: number;
  /** the seller's part */
  readonly sellerPart: number;
}

export type ReversalError = "invalid_amount" | "exceeds_remaining";

/**
 * Splits an amount taken back from a sale (a refund, a lost dispute) between the platform and the seller in the proportion of
 * the original sale. The fee part is cumulative: after `taken + amount` has been reversed, the fee reversed so far is
 * `floor(fee * (taken + amount) / sale)`, and this reversal gets the difference. So the fee parts of any series of reversals add
 * up to exactly the fee when the whole sale has been taken back, and a rounding unit is never created or lost.
 */
export function allocateReversal(sale: Sale, taken: Taken, amount: number): Result<Reversal, ReversalError> {
  if (!Number.isSafeInteger(amount) || amount < 1) return err("invalid_amount");
  const cumulative = taken.amount + amount;
  if (cumulative > sale.amount) return err("exceeds_remaining");
  const target = Number((BigInt(sale.fee) * BigInt(cumulative)) / BigInt(sale.amount));
  const remainingFee = Math.max(sale.fee - taken.fee, 0);
  const feePart = Math.min(Math.max(target - taken.fee, 0), amount, remainingFee);
  return ok({ feePart, sellerPart: amount - feePart });
}
