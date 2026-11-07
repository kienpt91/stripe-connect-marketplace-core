import { applySnapshot, type AccountSnapshot, type SellerState } from "./seller.js";
import { formatMinor, parseCurrency, type Currency } from "./money.js";
import { payoutRank, type PayoutStatus } from "./stripe-events.js";

/**
 * Reconciliation compares what the ledger says with what Stripe says, and reports every difference with both values. It never
 * repairs anything and never trusts either side: a mismatch is a finding for a person. This file is pure; the use case that
 * reads the two sides is in application/reconcile.ts.
 */

export interface LedgerSeller {
  readonly sellerId: string;
  readonly accountId: string;
  readonly state: SellerState;
  /** the balance of the seller's account per currency (what the platform owes the seller) */
  readonly balances: Readonly<Record<string, number>>;
}

export interface LedgerPayout {
  readonly id: string;
  readonly sellerId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly status: PayoutStatus;
  readonly createdAt: number;
}

export interface LedgerPayment {
  readonly chargeId: string;
  readonly sellerId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly fee: number;
  readonly currency: Currency;
  /** refunds that succeeded and were posted */
  readonly refunded: number;
  /** the part of those refunds that was the platform's fee: the rest was taken back from the seller */
  readonly refundedFee: number;
  readonly createdAt: number;
  /** set at ingestion when the charge differed from the order it paid for */
  readonly anomaly: string | null;
}

export interface LedgerTransfer {
  readonly id: string;
  readonly chargeId: string;
  /** the connected account the transfer went to */
  readonly accountId: string;
  readonly amount: number;
  readonly amountReversed: number;
}

export interface FlaggedEvent {
  readonly id: string;
  readonly type: string;
  readonly status: "deferred" | "rejected";
  readonly reason: string | null;
  readonly receivedAt: number;
}

export interface LedgerView {
  readonly sellers: readonly LedgerSeller[];
  readonly payouts: readonly LedgerPayout[];
  readonly payments: readonly LedgerPayment[];
  readonly transfers: readonly LedgerTransfer[];
  /** total debits and credits per currency over the whole ledger */
  readonly totals: readonly { readonly currency: Currency; readonly debits: number; readonly credits: number }[];
  readonly flaggedEvents: readonly FlaggedEvent[];
}

export interface StripePayout {
  readonly id: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly status: PayoutStatus;
  readonly createdAt: number;
}

export interface StripeBalance {
  readonly currency: Currency;
  readonly available: number;
  readonly pending: number;
}

export interface StripeAccountView {
  readonly accountId: string;
  readonly snapshot: AccountSnapshot;
  readonly balances: readonly StripeBalance[];
  readonly payouts: readonly StripePayout[];
}

export interface StripeCharge {
  readonly id: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly applicationFee: number | null;
  readonly amountRefunded: number;
  readonly destination: string | null;
  /** the order id in the charge's metadata; a charge without one is not the marketplace's */
  readonly orderId: string | null;
  readonly createdAt: number;
}

export interface StripeView {
  readonly accounts: readonly StripeAccountView[];
  readonly charges: readonly StripeCharge[];
}

export const FINDING_KINDS = [
  "unbalanced_ledger", "balance_mismatch", "negative_seller_balance",
  "payout_missing_in_ledger", "payout_missing_in_stripe", "payout_amount_mismatch", "payout_status_mismatch",
  "charge_missing_in_ledger", "charge_missing_in_stripe", "charge_amount_mismatch", "fee_mismatch", "refund_mismatch", "destination_mismatch",
  "transfer_missing", "transfer_mismatch", "order_mismatch", "seller_state_mismatch", "stuck_event", "rejected_event",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
  readonly kind: FindingKind;
  /** an error is money that disagrees; a warning is something a person should look at */
  readonly severity: "error" | "warning";
  /** the seller, charge, payout or event the finding is about */
  readonly subject: string;
  readonly message: string;
}

export interface CompareOptions {
  readonly now: number;
  /** an event deferred for longer than this is stuck */
  readonly stuckAfterMs: number;
  /** only objects created at or after this time (ms) are compared; both sides are cut at the same instant */
  readonly since: number;
}

const money = (amount: number, currency: Currency): string => formatMinor(amount, currency);

/** Every difference between the ledger and Stripe, errors first, in a stable order. */
export function compareLedgerWithStripe(ledger: LedgerView, stripe: StripeView, options: CompareOptions): Finding[] {
  const out: Finding[] = [];
  const add = (kind: FindingKind, severity: Finding["severity"], subject: string, message: string): void => void out.push({ kind, severity, subject, message });

  for (const t of ledger.totals) {
    if (t.debits !== t.credits) add("unbalanced_ledger", "error", t.currency, `debits ${money(t.debits, t.currency)} and credits ${money(t.credits, t.currency)} differ`);
  }

  const accountView = new Map(stripe.accounts.map((a) => [a.accountId, a]));
  for (const seller of ledger.sellers) {
    const view = accountView.get(seller.accountId);
    for (const [code, balance] of Object.entries(seller.balances)) {
      const currency = parseCurrency(code);
      if (currency === undefined) continue;
      if (balance < 0) add("negative_seller_balance", "warning", seller.sellerId, `the seller owes the platform ${money(-balance, currency)}: a refund or a lost dispute exceeded what the seller was owed`);
      if (view === undefined) continue;
      const theirs = view.balances.find((b) => b.currency === currency);
      const stripeTotal = theirs === undefined ? 0 : theirs.available + theirs.pending;
      if (stripeTotal !== balance) {
        add("balance_mismatch", "error", seller.sellerId, `ledger owes the seller ${money(balance, currency)}, the Stripe balance of ${seller.accountId} is ${money(stripeTotal, currency)} (available + pending)`);
      }
    }
    if (view !== undefined) {
      for (const b of view.balances) {
        if (!(b.currency in seller.balances) && b.available + b.pending !== 0) {
          add("balance_mismatch", "error", seller.sellerId, `the ledger has no ${b.currency.toUpperCase()} balance for the seller, the Stripe balance of ${seller.accountId} is ${money(b.available + b.pending, b.currency)}`);
        }
      }
      const change = applySnapshot(seller.state, view.snapshot);
      if (change.kind !== "unchanged") {
        const wanted = change.kind === "moved" ? change.state : change.wanted;
        add("seller_state_mismatch", "warning", seller.sellerId, `the seller is ${seller.state} here, Stripe's account says ${wanted}`);
      }
      comparePayouts(seller.accountId, ledger.payouts, view.payouts, options.since, add);
    }
  }
  compareCharges(ledger.payments, stripe.charges, options.since, add);

  compareTransfers(ledger, options, add);
  for (const p of ledger.payments) {
    if (p.anomaly !== null) add("order_mismatch", "error", p.chargeId, `the charge differs from the order it paid for: ${p.anomaly}`);
  }
  for (const e of ledger.flaggedEvents) {
    if (e.status === "deferred" && options.now - e.receivedAt > options.stuckAfterMs) {
      add("stuck_event", "warning", e.id, `${e.type} has waited for ${e.reason ?? "its prerequisite"} since ${new Date(e.receivedAt).toISOString()}`);
    }
    if (e.status === "rejected" && e.receivedAt >= options.since) add("rejected_event", "warning", e.id, `${e.type} was rejected: ${e.reason ?? "no reason recorded"}`);
  }
  return out.sort((a, b) => (a.severity === b.severity ? a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject) : a.severity === "error" ? -1 : 1));
}

type Add = (kind: FindingKind, severity: Finding["severity"], subject: string, message: string) => void;

function comparePayouts(accountId: string, ledger: readonly LedgerPayout[], stripe: readonly StripePayout[], since: number, add: Add): void {
  const ours = new Map(ledger.filter((p) => p.accountId === accountId && p.createdAt >= since).map((p) => [p.id, p]));
  const theirs = new Map(stripe.filter((p) => p.createdAt >= since).map((p) => [p.id, p]));
  for (const [id, payout] of theirs) {
    const mine = ours.get(id);
    if (mine === undefined) {
      // a payout that failed or was canceled left the balance where it was: nothing for the ledger to have missed
      if (payoutRank(payout.status) < 4) add("payout_missing_in_ledger", "error", id, `Stripe paid out ${money(payout.amount, payout.currency)} (${payout.status}) from ${accountId}; the ledger has no such payout`);
      continue;
    }
    if (mine.amount !== payout.amount || mine.currency !== payout.currency) {
      add("payout_amount_mismatch", "error", id, `ledger ${money(mine.amount, mine.currency)}, Stripe ${money(payout.amount, payout.currency)}`);
    }
    if (mine.status !== payout.status) add("payout_status_mismatch", "warning", id, `ledger says ${mine.status}, Stripe says ${payout.status}`);
  }
  for (const [id, payout] of ours) {
    if (!theirs.has(id)) add("payout_missing_in_stripe", "error", id, `the ledger has a payout of ${money(payout.amount, payout.currency)} that Stripe does not list for ${accountId}`);
  }
}

function compareCharges(ledger: readonly LedgerPayment[], stripe: readonly StripeCharge[], since: number, add: Add): void {
  const ours = new Map(ledger.filter((p) => p.createdAt >= since).map((p) => [p.chargeId, p]));
  const theirs = new Map(stripe.filter((c) => c.orderId !== null && c.createdAt >= since).map((c) => [c.id, c]));
  for (const [id, charge] of theirs) {
    const mine = ours.get(id);
    if (mine === undefined) {
      add("charge_missing_in_ledger", "error", id, `Stripe took ${money(charge.amount, charge.currency)} for order ${charge.orderId}; the ledger has no sale for it`);
      continue;
    }
    if (mine.amount !== charge.amount || mine.currency !== charge.currency) add("charge_amount_mismatch", "error", id, `ledger ${money(mine.amount, mine.currency)}, Stripe ${money(charge.amount, charge.currency)}`);
    if ((charge.applicationFee ?? 0) !== mine.fee) add("fee_mismatch", "error", id, `ledger fee ${money(mine.fee, mine.currency)}, Stripe application fee ${money(charge.applicationFee ?? 0, charge.currency)}`);
    if (charge.amountRefunded !== mine.refunded) add("refund_mismatch", "error", id, `ledger refunded ${money(mine.refunded, mine.currency)}, Stripe amount_refunded ${money(charge.amountRefunded, charge.currency)}`);
    if (charge.destination !== null && charge.destination !== mine.accountId) add("destination_mismatch", "error", id, `the charge pays ${charge.destination}, the order's seller is ${mine.accountId}`);
  }
  for (const [id, payment] of ours) {
    if (!theirs.has(id)) add("charge_missing_in_stripe", "error", id, `the ledger has a sale of ${money(payment.amount, payment.currency)} that Stripe does not list as a marketplace charge`);
  }
}

/**
 * Every sale of a destination charge has a transfer to the seller of exactly the net amount; every refund takes the seller's part of
 * it back. A sale whose transfer has not been seen after `stuckAfterMs` is reported, and so is a transfer that says anything else.
 */
function compareTransfers(ledger: LedgerView, options: CompareOptions, add: Add): void {
  const byCharge = new Map(ledger.transfers.map((t) => [t.chargeId, t]));
  for (const p of ledger.payments) {
    if (p.createdAt < options.since) continue;
    const t = byCharge.get(p.chargeId);
    if (t === undefined) {
      if (options.now - p.createdAt > options.stuckAfterMs) add("transfer_missing", "warning", p.chargeId, `no transfer to ${p.accountId} was seen for this sale`);
      continue;
    }
    if (t.accountId !== p.accountId) add("transfer_mismatch", "error", t.id, `the transfer went to ${t.accountId}, the order's seller is ${p.accountId}`);
    if (t.amount !== p.amount - p.fee) add("transfer_mismatch", "error", t.id, `transferred ${money(t.amount, p.currency)}, the net of the sale is ${money(p.amount - p.fee, p.currency)}`);
    if (t.amountReversed !== p.refunded - p.refundedFee) add("transfer_mismatch", "warning", t.id, `reversed ${money(t.amountReversed, p.currency)}, the seller's part of the refunds is ${money(p.refunded - p.refundedFee, p.currency)}`);
  }
}

/** Plain text, one line per finding, for a terminal or a job log. */
export function formatFindings(findings: readonly Finding[]): string[] {
  if (findings.length === 0) return ["no differences between the ledger and Stripe"];
  return findings.map((f) => `${f.severity.toUpperCase().padEnd(7)} ${f.kind.padEnd(26)} ${f.subject}  ${f.message}`);
}
