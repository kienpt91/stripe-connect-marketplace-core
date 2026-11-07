import { parseStripeId } from "./ids.js";
import { err, ok, type Result } from "./result.js";

/**
 * Where a seller is on the way to being able to sell, as far as the platform is concerned.
 *
 *   new               the Connect account exists; nothing is known about it yet
 *   requirements_due  Stripe still needs information from the seller (details not submitted, or something is currently due)
 *   pending_review    everything asked has been submitted and Stripe is verifying it
 *   enabled           charges and payouts are on and nothing is overdue: the seller can be sold for
 *   restricted        the seller had been live (or Stripe or the platform put a hold) and can no longer take payments
 *   rejected          Stripe rejected the account (fraud, terms of service, ...): final
 */
export const SELLER_STATES = ["new", "requirements_due", "pending_review", "enabled", "restricted", "rejected"] as const;
export type SellerState = (typeof SELLER_STATES)[number];

/** The parts of a Stripe account object the state machine reads. Never the whole object: nothing else is stored. */
export interface AccountSnapshot {
  readonly accountId: string;
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  readonly detailsSubmitted: boolean;
  readonly currentlyDue: readonly string[];
  readonly pastDue: readonly string[];
  readonly pendingVerification: readonly string[];
  readonly disabledReason: string | null;
}

/** Holds Stripe or the platform puts on an account that are not about missing information. */
const HOLD_REASONS: ReadonlySet<string> = new Set(["listed", "platform_paused", "under_review", "other"]);

/**
 * The state a snapshot describes, given the state the seller was in. The rules, in order:
 * 1. a `rejected.*` reason is final; 2. a hold reason restricts; 3. charges and payouts on and nothing overdue is `enabled`;
 * 4. a seller that was live and no longer is `restricted`, even while Stripe re-verifies; 5. everything submitted and nothing
 * due is `pending_review`; 6. anything else is `requirements_due`.
 */
export function deriveSellerState(snapshot: AccountSnapshot, previous: SellerState): SellerState {
  const reason = snapshot.disabledReason;
  if (reason !== null && reason.startsWith("rejected.")) return "rejected";
  if (reason !== null && HOLD_REASONS.has(reason)) return "restricted";
  if (snapshot.chargesEnabled && snapshot.payoutsEnabled && snapshot.pastDue.length === 0) return "enabled";
  if (previous === "enabled" || previous === "restricted") return "restricted";
  if (snapshot.detailsSubmitted && snapshot.currentlyDue.length === 0 && snapshot.pastDue.length === 0) return "pending_review";
  return "requirements_due";
}

/** The transitions a seller may make. `rejected` has none: a late or stale event cannot bring a rejected seller back. */
const TRANSITIONS: Readonly<Record<SellerState, readonly SellerState[]>> = {
  new: ["requirements_due", "pending_review", "enabled", "restricted", "rejected"],
  requirements_due: ["requirements_due", "pending_review", "enabled", "restricted", "rejected"],
  pending_review: ["pending_review", "requirements_due", "enabled", "restricted", "rejected"],
  enabled: ["enabled", "restricted", "rejected"],
  restricted: ["restricted", "enabled", "rejected"],
  rejected: ["rejected"],
};

export function canTransition(from: SellerState, to: SellerState): boolean {
  return TRANSITIONS[from].includes(to);
}

export type StateChange =
  | { readonly kind: "unchanged"; readonly state: SellerState }
  | { readonly kind: "moved"; readonly from: SellerState; readonly state: SellerState }
  | { readonly kind: "refused"; readonly from: SellerState; readonly wanted: SellerState };

/** The outcome of applying a snapshot to a seller in `current`: stay, move, or refuse an impossible move and keep `current`. */
export function applySnapshot(current: SellerState, snapshot: AccountSnapshot): StateChange {
  const wanted = deriveSellerState(snapshot, current);
  if (wanted === current) return { kind: "unchanged", state: current };
  if (!canTransition(current, wanted)) return { kind: "refused", from: current, wanted };
  return { kind: "moved", from: current, state: wanted };
}

/** Only an enabled seller is sold for: a checkout for any other state is refused. */
export function canTakePayments(state: SellerState): boolean {
  return state === "enabled";
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 200) return undefined;
  return value.every((v) => typeof v === "string" && v.length <= 200) ? (value as string[]) : undefined;
}

/** Reads a Stripe account object (from the API or an event) into a snapshot, strictly: a wrong type anywhere is an error. */
export function parseAccountSnapshot(value: unknown): Result<AccountSnapshot, "invalid_account"> {
  if (typeof value !== "object" || value === null) return err("invalid_account");
  const o = value as Record<string, unknown>;
  const accountId = parseStripeId("acct", o["id"]);
  if (accountId === undefined) return err("invalid_account");
  if (typeof o["charges_enabled"] !== "boolean" || typeof o["payouts_enabled"] !== "boolean" || typeof o["details_submitted"] !== "boolean") return err("invalid_account");
  const requirements = o["requirements"] ?? {};
  if (typeof requirements !== "object" || requirements === null) return err("invalid_account");
  const r = requirements as Record<string, unknown>;
  const currentlyDue = stringList(r["currently_due"]);
  const pastDue = stringList(r["past_due"]);
  const pendingVerification = stringList(r["pending_verification"]);
  const reason = r["disabled_reason"] ?? null;
  if (currentlyDue === undefined || pastDue === undefined || pendingVerification === undefined) return err("invalid_account");
  if (reason !== null && (typeof reason !== "string" || reason.length > 100)) return err("invalid_account");
  return ok({
    accountId,
    chargesEnabled: o["charges_enabled"],
    payoutsEnabled: o["payouts_enabled"],
    detailsSubmitted: o["details_submitted"],
    currentlyDue,
    pastDue,
    pendingVerification,
    disabledReason: reason,
  });
}
