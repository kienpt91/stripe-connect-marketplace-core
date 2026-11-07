import { asId, parseUuid, type SellerId } from "../domain/ids.js";
import { err, ok, type Result } from "../domain/result.js";
import { applySnapshot, type SellerState } from "../domain/seller.js";
import { returnUrl } from "../domain/url.js";
import { GatewayError, type Deps } from "./ports.js";
import type { Actor, SellerRecord } from "./store.js";

export type RegisterError = "invalid_seller_id" | "invalid_name" | "invalid_country" | "gateway_failed";

export interface RegisterRequest {
  /** the id of the seller in the application, for example the id of the signed-in user */
  readonly sellerId: unknown;
  readonly displayName: unknown;
  /** ISO 3166 alpha-2, upper case: where the seller's business is */
  readonly country: unknown;
}

const PRINTABLE_LINE = /^[^\u0000-\u001f\u007f]+$/u;

/**
 * Creates the seller and its Connect account. The account is created with an idempotency key derived from the seller id, so a call
 * that crashed after Stripe answered and before the row was written is repeated safely: the same account comes back. Calling it
 * again for a registered seller returns the seller and calls nothing.
 */
export async function registerSeller(deps: Deps, request: RegisterRequest): Promise<Result<SellerRecord, RegisterError>> {
  const sellerId = parseUuid(request.sellerId);
  if (sellerId === undefined) return err("invalid_seller_id");
  const name = typeof request.displayName === "string" ? request.displayName.trim() : "";
  if (name.length < 1 || name.length > 100 || !PRINTABLE_LINE.test(name)) return err("invalid_name");
  if (typeof request.country !== "string" || !/^[A-Z]{2}$/.test(request.country)) return err("invalid_country");
  const id = asId<"SellerId">(sellerId);

  const existing = await deps.db.transaction({ kind: "system" }, (tx) => tx.sellers.get(id));
  if (existing !== undefined) return ok(existing);

  let accountId: string;
  try {
    ({ accountId } = await deps.stripe.createAccount({ sellerId, country: request.country, idempotencyKey: `seller-${sellerId}` }));
  } catch (error) {
    if (error instanceof GatewayError) {
      deps.logger.warn("seller.account_failed", { sellerId, code: error.code });
      return err("gateway_failed");
    }
    throw error;
  }
  const record: SellerRecord = { id, displayName: name, accountId, state: "new", snapshot: null, observedAt: 0, createdAt: deps.clock.now() };
  return ok(
    await deps.db.transaction({ kind: "system" }, async (tx) => {
      // a second registration of the same seller that got here first wins; both created the same account
      if (!(await tx.sellers.insert(record))) return (await tx.sellers.get(id)) ?? record;
      return record;
    }),
  );
}

export type LinkError = "not_found" | "invalid_redirect" | "gateway_failed";

/**
 * A one-time link to Stripe's hosted onboarding for the seller's account. The seller asks for their own; an operator may ask for
 * any. For anyone else the answer is `not_found`, the same as for a seller that does not exist.
 */
export async function createOnboardingLink(
  deps: Deps,
  actor: Actor,
  sellerId: SellerId,
  paths: { readonly returnPath: unknown; readonly refreshPath: unknown },
): Promise<Result<{ url: string; expiresAt: number }, LinkError>> {
  const back = returnUrl(deps.appOrigin, paths.returnPath);
  const refresh = returnUrl(deps.appOrigin, paths.refreshPath);
  if (!back.ok || !refresh.ok) return err("invalid_redirect");
  if (actor.kind === "seller" && actor.sellerId !== sellerId) return err("not_found");
  const seller = await deps.db.transaction(actor, (tx) => tx.sellers.get(sellerId));
  if (seller === undefined) return err("not_found");
  try {
    return ok(await deps.stripe.createAccountLink({ accountId: seller.accountId, returnUrl: back.value, refreshUrl: refresh.value }));
  } catch (error) {
    if (error instanceof GatewayError) return err("gateway_failed");
    throw error;
  }
}

/**
 * The repair that is always safe: read the seller's account from Stripe and apply it, as the `account.updated` handler does. Used
 * after reconciliation reports a state mismatch (for example when an `account.updated` event never arrived).
 */
export async function refreshSeller(deps: Deps, sellerId: SellerId): Promise<Result<{ state: SellerState; changed: boolean }, "not_found" | "gateway_failed" | "refused">> {
  const system = { kind: "system" } as const;
  const seller = await deps.db.transaction(system, (tx) => tx.sellers.get(sellerId));
  if (seller === undefined) return err("not_found");
  const observedAt = deps.clock.now();
  let snapshot;
  try {
    snapshot = await deps.stripe.retrieveAccount(seller.accountId);
  } catch (error) {
    if (error instanceof GatewayError) return err("gateway_failed");
    throw error;
  }
  return deps.db.transaction(system, async (tx) => {
    await tx.lock(`account:${seller.accountId}`);
    const current = (await tx.sellers.get(sellerId)) ?? seller;
    const change = applySnapshot(current.state, snapshot);
    if (change.kind === "refused") return err("refused" as const);
    await tx.sellers.applySnapshot(sellerId, change.state, snapshot, observedAt);
    return ok({ state: change.state, changed: change.kind === "moved" });
  });
}
