import { parseCurrency } from "../domain/money.js";
import { compareLedgerWithStripe, type Finding, type LedgerPayment, type LedgerPayout, type LedgerSeller, type LedgerTransfer, type LedgerView, type StripeAccountView } from "../domain/reconciliation.js";
import { err, ok, type Result } from "../domain/result.js";
import { GatewayError, type Deps } from "./ports.js";

export interface ReconcileOptions {
  /** only objects created at or after this time (ms) are compared */
  readonly since: number;
  /** a deferred event, or a sale without a transfer, older than this is reported (default 15 minutes) */
  readonly stuckAfterMs?: number;
}

export interface ReconcileReport {
  readonly at: number;
  readonly since: number;
  readonly sellers: number;
  readonly payments: number;
  readonly payouts: number;
  readonly findings: readonly Finding[];
}

export type ReconcileError = "gateway_failed";

/**
 * Compares the ledger with what Stripe says now and returns every difference. It reads, it never writes and never repairs: a person
 * decides what a mismatch means. Run by an operator (the database role sees every seller); the reads of Stripe happen after the
 * ledger has been read in one transaction, so what is compared is one consistent view of the ledger against Stripe's current state.
 */
export async function reconcile(deps: Deps, options: ReconcileOptions): Promise<Result<ReconcileReport, ReconcileError>> {
  const now = deps.clock.now();
  const ledger = await deps.db.transaction({ kind: "operator" }, async (tx): Promise<LedgerView> => {
    const totals = await tx.ledger.totals();
    const sellers: LedgerSeller[] = [];
    for (const s of await tx.sellers.list()) {
      sellers.push({ sellerId: s.id, accountId: s.accountId, state: s.state, balances: await tx.ledger.balanceOf(s.id) });
    }
    const accountOf = new Map(sellers.map((s) => [s.sellerId as string, s.accountId]));
    const payments: LedgerPayment[] = (await tx.payments.list()).map((p) => ({
      chargeId: p.chargeId, sellerId: p.sellerId, accountId: p.accountId, amount: p.amount, fee: p.fee, currency: p.currency,
      refunded: p.refunded, reversed: p.reversed, reversedFee: p.reversedFee, createdAt: p.createdAt, anomaly: p.anomaly,
    }));
    const payouts: LedgerPayout[] = (await tx.objects.list("payout")).map((o) => ({
      id: o.id, sellerId: o.sellerId, accountId: accountOf.get(o.sellerId) ?? o.accountId, amount: o.amount, currency: o.currency,
      status: o.status as LedgerPayout["status"], createdAt: o.createdAt,
    }));
    const transfers: LedgerTransfer[] = (await tx.objects.list("transfer")).map((o) => ({
      id: o.id, chargeId: o.chargeId ?? "", accountId: o.accountId, amount: o.amount, amountReversed: o.secondaryAmount,
    }));
    const perCurrency = new Map<string, { debits: number; credits: number }>();
    for (const t of totals) {
      const sum = perCurrency.get(t.currency) ?? { debits: 0, credits: 0 };
      perCurrency.set(t.currency, { debits: sum.debits + t.debits, credits: sum.credits + t.credits });
    }
    return {
      sellers, payouts, payments, transfers, flaggedEvents: await tx.events.flagged(),
      totals: [...perCurrency].flatMap(([code, sum]) => {
        const currency = parseCurrency(code);
        return currency === undefined ? [] : [{ currency, ...sum }];
      }),
    };
  });

  const accounts: StripeAccountView[] = [];
  let charges;
  try {
    for (const seller of ledger.sellers) {
      accounts.push({
        accountId: seller.accountId,
        snapshot: await deps.stripe.retrieveAccount(seller.accountId),
        balances: await deps.stripe.retrieveBalance(seller.accountId),
        payouts: await deps.stripe.listPayouts(seller.accountId, options.since),
      });
    }
    charges = await deps.stripe.listCharges(options.since);
  } catch (error) {
    if (error instanceof GatewayError) {
      deps.logger.warn("reconcile.gateway_failed", { code: error.code });
      return err("gateway_failed");
    }
    throw error;
  }
  const findings = compareLedgerWithStripe(ledger, { accounts, charges }, { now, since: options.since, stuckAfterMs: options.stuckAfterMs ?? 15 * 60_000 });
  return ok({ at: now, since: options.since, sellers: ledger.sellers.length, payments: ledger.payments.length, payouts: ledger.payouts.length, findings });
}
