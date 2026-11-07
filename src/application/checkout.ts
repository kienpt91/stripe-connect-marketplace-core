import { asId, parseUuid, type OrderId } from "../domain/ids.js";
import { parseCurrency, splitCharge, type Currency, type SplitError } from "../domain/money.js";
import { err, ok, type Result } from "../domain/result.js";
import { canTakePayments } from "../domain/seller.js";
import { returnUrl } from "../domain/url.js";
import { GatewayError, type Deps } from "./ports.js";
import type { OrderRecord } from "./store.js";

export interface CheckoutRequest {
  readonly sellerId: unknown;
  /** an opaque reference to the buyer in the application: not a name, not an e-mail address */
  readonly buyerRef: unknown;
  /** whole minor units (cents): a number with a fraction is refused, not rounded */
  readonly amount: unknown;
  readonly currency: unknown;
  readonly description: unknown;
  /** the caller's key for this purchase: the same key is the same order, however often it is sent */
  readonly idempotencyKey: unknown;
  readonly successPath: unknown;
  readonly cancelPath: unknown;
}

export interface Checkout {
  readonly orderId: OrderId;
  readonly checkoutUrl: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly fee: number;
  readonly sellerNet: number;
  /** true when the key had been used before and nothing new was created */
  readonly replayed: boolean;
}

export type CheckoutError =
  | "invalid_seller_id" | "invalid_buyer_ref" | "invalid_currency" | "invalid_description" | "invalid_idempotency_key" | "invalid_redirect"
  | SplitError
  | "seller_not_found" | "seller_not_enabled" | "idempotency_conflict" | "order_not_payable" | "gateway_failed";

const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const BUYER = /^[A-Za-z0-9_.:@-]{1,100}$/;

/**
 * Starts a purchase from one seller. The platform decides the fee: the request has no field for it, and the amount and fee reach
 * Stripe as integers of the minor unit. The order is written first and the Checkout Session is created after, outside any
 * transaction, with an idempotency key made from the order id; a crash or a retry between the two repeats the call and gets the
 * same session. Only a seller in the `enabled` state can be sold for.
 */
export async function startCheckout(deps: Deps, request: CheckoutRequest): Promise<Result<Checkout, CheckoutError>> {
  const sellerUuid = parseUuid(request.sellerId);
  if (sellerUuid === undefined) return err("invalid_seller_id");
  const sellerId = asId<"SellerId">(sellerUuid);
  if (typeof request.buyerRef !== "string" || !BUYER.test(request.buyerRef)) return err("invalid_buyer_ref");
  const currency = parseCurrency(request.currency);
  if (currency === undefined) return err("invalid_currency");
  if (typeof request.description !== "string" || request.description.length < 1 || request.description.length > 200 || !SAFE_TEXT.test(request.description)) return err("invalid_description");
  if (typeof request.idempotencyKey !== "string" || !KEY.test(request.idempotencyKey)) return err("invalid_idempotency_key");
  const success = returnUrl(deps.appOrigin, request.successPath);
  const cancel = returnUrl(deps.appOrigin, request.cancelPath);
  if (!success.ok || !cancel.ok) return err("invalid_redirect");
  // a fraction, a string, a negative number, one below the minimum or above what Stripe takes: the split says which
  if (typeof request.amount !== "number") return err("invalid_amount");
  const amount = request.amount;
  const split = splitCharge(deps.fees, amount);
  if (!split.ok) return err(split.error);

  const wanted = { buyerRef: request.buyerRef, amount, currency, description: request.description };
  const stored = await deps.db.transaction({ kind: "system" }, async (tx) => {
    const seller = await tx.sellers.get(sellerId);
    if (seller === undefined) return err("seller_not_found" as const);
    if (!canTakePayments(seller.state)) return err("seller_not_enabled" as const);
    const existing = await tx.orders.findByKey(sellerId, request.idempotencyKey as string);
    if (existing !== undefined) return ok({ order: existing, accountId: seller.accountId, replayed: true });
    const order: OrderRecord = {
      id: asId<"OrderId">(deps.ids.next()) as OrderId, sellerId, ...wanted, fee: split.value.fee, status: "awaiting_payment",
      idempotencyKey: request.idempotencyKey as string, sessionId: null, chargeId: null, createdAt: deps.clock.now(),
    };
    if (await tx.orders.insert(order)) return ok({ order, accountId: seller.accountId, replayed: false });
    const winner = await tx.orders.findByKey(sellerId, request.idempotencyKey as string);
    return winner === undefined ? err("idempotency_conflict" as const) : ok({ order: winner, accountId: seller.accountId, replayed: true });
  });
  if (!stored.ok) return stored;
  const { order, accountId, replayed } = stored.value;
  if (order.buyerRef !== wanted.buyerRef || order.amount !== wanted.amount || order.currency !== wanted.currency || order.description !== wanted.description) return err("idempotency_conflict");
  if (order.status !== "awaiting_payment") return err("order_not_payable");

  let session: { sessionId: string; url: string };
  try {
    session = await deps.stripe.createCheckoutSession({
      orderId: order.id, accountId, amount: order.amount, currency: order.currency, applicationFee: order.fee, description: order.description,
      successUrl: success.value, cancelUrl: cancel.value, idempotencyKey: `order-${order.id}`,
    });
  } catch (error) {
    if (error instanceof GatewayError) {
      deps.logger.warn("checkout.session_failed", { orderId: order.id, code: error.code });
      return err("gateway_failed");
    }
    throw error;
  }
  if (order.sessionId === null) await deps.db.transaction({ kind: "system" }, (tx) => tx.orders.attachSession(order.id, session.sessionId));
  return ok({ orderId: order.id, checkoutUrl: session.url, amount: order.amount, currency: order.currency, fee: order.fee, sellerNet: order.amount - order.fee, replayed });
}
