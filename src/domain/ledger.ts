import type { Currency } from "./money.js";
import type { SellerId } from "./ids.js";
import { err, ok, type Result } from "./result.js";

/**
 * The accounts of the ledger. They are fixed by the domain, not rows somebody can add.
 *
 *   stripe_funds     asset      everything Stripe holds for the platform and its sellers (the platform balance and the connected balances)
 *   seller_balance   liability  what the platform owes a seller: net sales, less refunds, lost disputes and payouts
 *   platform_fees    revenue    the application fees the platform kept
 *   disputed_funds   asset      money Stripe withdrew for an open dispute; it comes back if the dispute is won
 *
 * Stripe's own processing fees are not modelled (SECURITY.md, docs/adr/0003).
 */
export const ACCOUNTS = ["stripe_funds", "seller_balance", "platform_fees", "disputed_funds"] as const;
export type Account = (typeof ACCOUNTS)[number];

export type Side = "debit" | "credit";

/** The side on which an account grows. The balance of an account is positive when it has more on this side. */
export const NORMAL_SIDE: Readonly<Record<Account, Side>> = {
  stripe_funds: "debit",
  seller_balance: "credit",
  platform_fees: "credit",
  disputed_funds: "debit",
};

/** An account that belongs to one seller: its lines carry the seller id, which is what row level security reads. */
export function isSellerAccount(account: Account): boolean {
  return account === "seller_balance";
}

export const ENTRY_KINDS = ["sale", "refund", "refund_reversal", "dispute_opened", "dispute_won", "dispute_lost", "payout", "payout_reversal"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export interface Line {
  readonly account: Account;
  readonly side: Side;
  /** a positive whole number of minor units */
  readonly amount: number;
}

/**
 * One business fact, posted once. Its lines balance (debits equal credits). The posting key names the fact (`sale:ch_...`), so
 * posting the same fact twice, whatever the number of deliveries, is a no-op.
 */
export interface Entry {
  readonly postingKey: string;
  readonly kind: EntryKind;
  readonly sellerId: SellerId;
  readonly currency: Currency;
  /** the Stripe object the entry is about */
  readonly subject: string;
  /** when the fact happened according to Stripe (the object's `created`), in ms: the same whichever event delivered it */
  readonly occurredAt: number;
  readonly lines: readonly Line[];
}

export type EntryError = "no_lines" | "invalid_amount" | "unbalanced";

export function sumSide(lines: readonly Line[], side: Side): number {
  let total = 0;
  for (const line of lines) {
    if (line.side === side) total += line.amount;
  }
  return total;
}

/** An entry has at least two lines, whole positive amounts, and debits equal to credits. */
export function validateEntry(entry: Entry): Result<Entry, EntryError> {
  if (entry.lines.length < 2) return err("no_lines");
  for (const line of entry.lines) {
    if (!Number.isSafeInteger(line.amount) || line.amount < 1) return err("invalid_amount");
  }
  if (sumSide(entry.lines, "debit") !== sumSide(entry.lines, "credit")) return err("unbalanced");
  return ok(entry);
}

const DEBIT = (account: Account, amount: number): Line => ({ account, side: "debit", amount });
const CREDIT = (account: Account, amount: number): Line => ({ account, side: "credit", amount });
const nonZero = (lines: readonly Line[]): Line[] => lines.filter((l) => l.amount > 0);

interface Common {
  readonly sellerId: SellerId;
  readonly currency: Currency;
  readonly occurredAt: number;
}

/** A charge succeeded: the buyer's money arrives at Stripe; the seller is owed the net and the platform keeps the fee. */
export function saleEntry(c: Common & { chargeId: string; amount: number; fee: number }): Entry {
  return {
    postingKey: `sale:${c.chargeId}`, kind: "sale", sellerId: c.sellerId, currency: c.currency, subject: c.chargeId, occurredAt: c.occurredAt,
    lines: nonZero([DEBIT("stripe_funds", c.amount), CREDIT("seller_balance", c.amount - c.fee), CREDIT("platform_fees", c.fee)]),
  };
}

/** A refund succeeded: the money goes back to the buyer, out of the seller's balance and the platform's fee in proportion to the sale. */
export function refundEntry(c: Common & { refundId: string; amount: number; feePart: number }): Entry {
  return {
    postingKey: `refund:${c.refundId}`, kind: "refund", sellerId: c.sellerId, currency: c.currency, subject: c.refundId, occurredAt: c.occurredAt,
    lines: nonZero([DEBIT("seller_balance", c.amount - c.feePart), DEBIT("platform_fees", c.feePart), CREDIT("stripe_funds", c.amount)]),
  };
}

/** A dispute needs a response: Stripe withdrew the disputed amount. It is held aside, not yet a loss. */
export function disputeOpenedEntry(c: Common & { disputeId: string; amount: number }): Entry {
  return {
    postingKey: `dispute:${c.disputeId}:open`, kind: "dispute_opened", sellerId: c.sellerId, currency: c.currency, subject: c.disputeId, occurredAt: c.occurredAt,
    lines: [DEBIT("disputed_funds", c.amount), CREDIT("stripe_funds", c.amount)],
  };
}

/** The dispute was won: Stripe reinstated the funds. */
export function disputeWonEntry(c: Common & { disputeId: string; amount: number }): Entry {
  return {
    postingKey: `dispute:${c.disputeId}:won`, kind: "dispute_won", sellerId: c.sellerId, currency: c.currency, subject: c.disputeId, occurredAt: c.occurredAt,
    lines: [DEBIT("stripe_funds", c.amount), CREDIT("disputed_funds", c.amount)],
  };
}

/** The dispute was lost: the withdrawn money is gone, taken from the seller's balance and the platform's fee in proportion to the sale. */
export function disputeLostEntry(c: Common & { disputeId: string; amount: number; feePart: number }): Entry {
  return {
    postingKey: `dispute:${c.disputeId}:lost`, kind: "dispute_lost", sellerId: c.sellerId, currency: c.currency, subject: c.disputeId, occurredAt: c.occurredAt,
    lines: nonZero([DEBIT("seller_balance", c.amount - c.feePart), DEBIT("platform_fees", c.feePart), CREDIT("disputed_funds", c.amount)]),
  };
}

/** A payout to the seller's bank was created: the seller's balance goes down and the money leaves Stripe. */
export function payoutEntry(c: Common & { payoutId: string; amount: number }): Entry {
  return {
    postingKey: `payout:${c.payoutId}`, kind: "payout", sellerId: c.sellerId, currency: c.currency, subject: c.payoutId, occurredAt: c.occurredAt,
    lines: [DEBIT("seller_balance", c.amount), CREDIT("stripe_funds", c.amount)],
  };
}

/** The mirror image of an entry, for a fact that is undone (a payout that failed, a refund that failed). */
export function reversalOf(entry: Entry, kind: "refund_reversal" | "payout_reversal", occurredAt: number): Entry {
  return {
    ...entry, postingKey: `${entry.postingKey}:reversal`, kind, occurredAt,
    lines: entry.lines.map((l): Line => ({ account: l.account, side: l.side === "debit" ? "credit" : "debit", amount: l.amount })),
  };
}

export interface AccountTotals {
  readonly debits: number;
  readonly credits: number;
}

/** The balance of an account: more on its normal side is positive, more on the other side negative. */
export function accountBalance(account: Account, totals: AccountTotals): number {
  return NORMAL_SIDE[account] === "debit" ? totals.debits - totals.credits : totals.credits - totals.debits;
}

/** Debits and credits of an account over a set of lines (one currency). */
export function totalsOf(lines: readonly Line[], account: Account): AccountTotals {
  const own = lines.filter((l) => l.account === account);
  return { debits: sumSide(own, "debit"), credits: sumSide(own, "credit") };
}
