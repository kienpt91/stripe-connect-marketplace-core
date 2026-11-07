import { asId, parseUuid, type OrderId } from "../domain/ids.js";
import { err, ok, type Result } from "../domain/result.js";
import type { RefundStatus } from "../domain/stripe-events.js";
import { GatewayError, type Deps } from "./ports.js";
import type { Actor } from "./store.js";

export type RefundError = "invalid_order_id" | "invalid_amount" | "invalid_idempotency_key" | "not_found" | "not_paid" | "exceeds_refundable" | "gateway_failed";

const KEY = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Asks Stripe to refund an order, in whole or in part. The refund takes the seller's share back (the transfer is reversed) and
 * returns the platform's fee in proportion; nothing is written to the ledger here. The ledger changes when the signed `refund.*`
 * event arrives, so there is one path into the ledger and the books match what Stripe confirms.
 *
 * A seller can refund their own orders, an operator any. For a seller, another seller's order is `not_found`, exactly like an
 * order that does not exist (row level security hides it before the query returns).
 */
export async function requestRefund(
  deps: Deps,
  actor: Actor,
  request: { readonly orderId: unknown; readonly amount: unknown; readonly idempotencyKey: unknown },
): Promise<Result<{ refundId: string; status: RefundStatus; amount: number }, RefundError>> {
  if (actor.kind === "system") return err("not_found");
  const orderUuid = parseUuid(request.orderId);
  if (orderUuid === undefined) return err("invalid_order_id");
  if (typeof request.idempotencyKey !== "string" || !KEY.test(request.idempotencyKey)) return err("invalid_idempotency_key");
  if (request.amount !== undefined && (typeof request.amount !== "number" || !Number.isSafeInteger(request.amount) || request.amount < 1)) return err("invalid_amount");

  const found = await deps.db.transaction(actor, async (tx) => {
    const order = await tx.orders.get(asId<"OrderId">(orderUuid) as OrderId);
    if (order === undefined) return undefined;
    const payment = order.chargeId === null ? null : ((await tx.payments.get(order.chargeId)) ?? null);
    return { order, payment };
  });
  if (found === undefined) return err("not_found");
  if (found.payment === null) return err("not_paid");
  const refundable = found.payment.amount - found.payment.reversed;
  const amount = typeof request.amount === "number" ? request.amount : refundable;
  if (amount < 1 || amount > refundable) return err("exceeds_refundable");

  try {
    const refund = await deps.stripe.createRefund({ chargeId: found.payment.chargeId, amount, orderId: found.order.id, idempotencyKey: request.idempotencyKey });
    return ok({ refundId: refund.refundId, status: refund.status, amount });
  } catch (error) {
    if (error instanceof GatewayError) {
      deps.logger.warn("refund.failed", { orderId: found.order.id, code: error.code });
      return err("gateway_failed");
    }
    throw error;
  }
}
