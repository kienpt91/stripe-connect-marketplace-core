import { describe, expect, it } from "vitest";
import { compareLedgerWithStripe, formatFindings, type LedgerView, type StripeView, type CompareOptions, type Finding } from "../../src/domain/reconciliation.js";
import type { AccountSnapshot } from "../../src/domain/seller.js";

const NOW = 1_762_100_000_000;
const SINCE = 1_762_000_000_000;
const options: CompareOptions = { now: NOW, since: SINCE, stuckAfterMs: 15 * 60_000 };
const ACCT = "acct_1SellerAaaa";
const snapshot: AccountSnapshot = { accountId: ACCT, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, currentlyDue: [], pastDue: [], pendingVerification: [], disabledReason: null };

/** A seller who sold 1000 (fee 130), refunded 200 (fee part 26) and was paid out 600: the ledger owes the seller 870 - 174 - 600 = 96. */
function agreeing(): { ledger: LedgerView; stripe: StripeView } {
  const ledger: LedgerView = {
    sellers: [{ sellerId: "s1", accountId: ACCT, state: "enabled", balances: { usd: 96 } }],
    payouts: [{ id: "po_1PayoutAaaaa", sellerId: "s1", accountId: ACCT, amount: 600, currency: "usd", status: "paid", createdAt: SINCE + 10 }],
    payments: [{ chargeId: "ch_1ChargeAaaaa", sellerId: "s1", accountId: ACCT, amount: 1000, fee: 130, currency: "usd", refunded: 200, refundedFee: 26, createdAt: SINCE + 5, anomaly: null }],
    transfers: [{ id: "tr_1TransferAaa", chargeId: "ch_1ChargeAaaaa", accountId: ACCT, amount: 870, amountReversed: 174 }],
    totals: [{ currency: "usd", debits: 5, credits: 5 }],
    flaggedEvents: [],
  };
  const stripe: StripeView = {
    accounts: [{
      accountId: ACCT, snapshot, balances: [{ currency: "usd", available: 90, pending: 6 }],
      payouts: [{ id: "po_1PayoutAaaaa", amount: 600, currency: "usd", status: "paid", createdAt: SINCE + 10 }],
    }],
    charges: [{ id: "ch_1ChargeAaaaa", amount: 1000, currency: "usd", applicationFee: 130, amountRefunded: 200, destination: ACCT, orderId: "o1", createdAt: SINCE + 5 }],
  };
  return { ledger, stripe };
}

const kinds = (findings: readonly Finding[]) => findings.map((f) => f.kind);
const run = (mutate: (v: { ledger: LedgerView; stripe: StripeView }) => { ledger: LedgerView; stripe: StripeView }) => {
  const { ledger, stripe } = mutate(agreeing());
  return compareLedgerWithStripe(ledger, stripe, options);
};

describe("reconciliation", () => {
  it("finds nothing when the ledger and Stripe agree, counting available and pending together", () => {
    const { ledger, stripe } = agreeing();
    expect(compareLedgerWithStripe(ledger, stripe, options)).toEqual([]);
    expect(formatFindings([])).toEqual(["no differences between the ledger and Stripe"]);
  });

  it("flags a ledger that does not balance", () => {
    expect(kinds(run((v) => ({ ...v, ledger: { ...v.ledger, totals: [{ currency: "usd", debits: 10, credits: 9 }] } })))).toEqual(["unbalanced_ledger"]);
  });

  it("flags a seller balance that differs from the Stripe balance, with both numbers", () => {
    const findings = run((v) => ({ ...v, stripe: { ...v.stripe, accounts: [{ ...v.stripe.accounts[0]!, balances: [{ currency: "usd", available: 100, pending: 6 }] }] } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "balance_mismatch", severity: "error", subject: "s1" });
    expect(findings[0]?.message).toContain("0.96 USD");
    expect(findings[0]?.message).toContain("1.06 USD");
  });

  it("flags a currency Stripe holds for the seller that the ledger has never seen", () => {
    const findings = run((v) => ({ ...v, stripe: { ...v.stripe, accounts: [{ ...v.stripe.accounts[0]!, balances: [...v.stripe.accounts[0]!.balances, { currency: "eur", available: 5, pending: 0 }] }] } }));
    expect(kinds(findings)).toEqual(["balance_mismatch"]);
    expect(findings[0]?.message).toContain("EUR");
    expect(run((v) => ({ ...v, stripe: { ...v.stripe, accounts: [{ ...v.stripe.accounts[0]!, balances: [...v.stripe.accounts[0]!.balances, { currency: "eur", available: 0, pending: 0 }] }] } }))).toEqual([]);
  });

  it("treats a ledger balance in a currency Stripe lists no balance for as a Stripe balance of zero", () => {
    const findings = run((v) => ({ ...v, stripe: { ...v.stripe, accounts: [{ ...v.stripe.accounts[0]!, balances: [] }] } }));
    expect(kinds(findings)).toEqual(["balance_mismatch"]);
  });

  it("flags a seller that owes the platform money (a refund after the payout)", () => {
    const findings = run((v) => ({
      ...v,
      ledger: { ...v.ledger, sellers: [{ ...v.ledger.sellers[0]!, balances: { usd: -40 } }] },
      stripe: { ...v.stripe, accounts: [{ ...v.stripe.accounts[0]!, balances: [{ currency: "usd", available: -40, pending: 0 }] }] },
    }));
    expect(kinds(findings)).toEqual(["negative_seller_balance"]);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.message).toContain("0.40 USD");
  });

  it("ignores a balance in a currency code it does not know", () => {
    expect(run((v) => ({ ...v, ledger: { ...v.ledger, sellers: [{ ...v.ledger.sellers[0]!, balances: { ...v.ledger.sellers[0]!.balances, zzz: 5 } }] } }))).toEqual([]);
  });

  describe("payouts", () => {
    it("flags a payout Stripe made that the ledger never recorded", () => {
      const findings = run((v) => ({ ...v, ledger: { ...v.ledger, payouts: [] } }));
      expect(findings.map((f) => f.kind)).toEqual(["payout_missing_in_ledger"]);
      expect(findings[0]?.severity).toBe("error");
    });

    it("does not flag a payout that failed or was canceled and that the ledger never recorded: it changed no balance", () => {
      for (const status of ["failed", "canceled"] as const) {
        const findings = run((v) => ({
          ...v,
          ledger: { ...v.ledger, payouts: [], sellers: [{ ...v.ledger.sellers[0]!, balances: { usd: 696 } }] },
          stripe: { ...v.stripe, accounts: [{ ...v.stripe.accounts[0]!, balances: [{ currency: "usd", available: 696, pending: 0 }], payouts: [{ id: "po_1PayoutAaaaa", amount: 600, currency: "usd", status, createdAt: SINCE + 10 }] }] },
        }));
        expect(findings).toEqual([]);
      }
    });

    it("flags a payout in the ledger that Stripe does not list", () => {
      expect(kinds(run((v) => ({ ...v, stripe: { ...v.stripe, accounts: [{ ...v.stripe.accounts[0]!, payouts: [] }] } })))).toEqual(["payout_missing_in_stripe"]);
    });

    it("flags a different amount, and a status that lags behind as a warning", () => {
      const amount = run((v) => ({ ...v, stripe: { ...v.stripe, accounts: [{ ...v.stripe.accounts[0]!, payouts: [{ ...v.stripe.accounts[0]!.payouts[0]!, amount: 601 }] }] } }));
      expect(kinds(amount)).toEqual(["payout_amount_mismatch"]);
      const status = run((v) => ({ ...v, stripe: { ...v.stripe, accounts: [{ ...v.stripe.accounts[0]!, payouts: [{ ...v.stripe.accounts[0]!.payouts[0]!, status: "failed" }] }] } }));
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({ kind: "payout_status_mismatch", severity: "warning" });
      expect(status[0]?.message).toBe("ledger says paid, Stripe says failed");
    });

    it("compares only payouts created inside the window, on both sides", () => {
      const findings = run((v) => ({
        ...v,
        ledger: { ...v.ledger, payouts: [{ ...v.ledger.payouts[0]!, createdAt: SINCE - 1 }] },
        stripe: { ...v.stripe, accounts: [{ ...v.stripe.accounts[0]!, payouts: [] }] },
      }));
      expect(findings).toEqual([]);
    });
  });

  describe("charges", () => {
    it("flags a marketplace charge Stripe took that the ledger has no sale for", () => {
      expect(kinds(run((v) => ({ ...v, ledger: { ...v.ledger, payments: [], transfers: [] } })))).toContain("charge_missing_in_ledger");
    });

    it("ignores a Stripe charge that carries no order id: it is not the marketplace's", () => {
      expect(run((v) => ({ ...v, stripe: { ...v.stripe, charges: [...v.stripe.charges, { id: "ch_1OtherAaaaaa", amount: 5, currency: "usd", applicationFee: null, amountRefunded: 0, destination: null, orderId: null, createdAt: SINCE + 1 }] } }))).toEqual([]);
    });

    it("flags a sale the ledger has and Stripe does not list", () => {
      expect(kinds(run((v) => ({ ...v, stripe: { ...v.stripe, charges: [] } })))).toEqual(["charge_missing_in_stripe"]);
    });

    it("flags a different amount, fee, refunded total and destination", () => {
      const charge = (patch: object) => run((v) => ({ ...v, stripe: { ...v.stripe, charges: [{ ...v.stripe.charges[0]!, ...patch }] } }));
      expect(kinds(charge({ amount: 1001 }))).toEqual(["charge_amount_mismatch"]);
      expect(kinds(charge({ applicationFee: 131 }))).toEqual(["fee_mismatch"]);
      expect(kinds(charge({ applicationFee: null }))).toEqual(["fee_mismatch"]);
      expect(kinds(charge({ amountRefunded: 300 }))).toEqual(["refund_mismatch"]);
      expect(kinds(charge({ destination: "acct_1Another000" }))).toEqual(["destination_mismatch"]);
      expect(kinds(charge({ destination: null }))).toEqual([]);
    });
  });

  describe("transfers", () => {
    it("flags a transfer to the wrong account, of the wrong amount, and a reversal that does not match the refunds", () => {
      const transfer = (patch: object) => run((v) => ({ ...v, ledger: { ...v.ledger, transfers: [{ ...v.ledger.transfers[0]!, ...patch }] } }));
      expect(transfer({ accountId: "acct_1Another000" })[0]).toMatchObject({ kind: "transfer_mismatch", severity: "error" });
      expect(transfer({ amount: 869 })[0]).toMatchObject({ kind: "transfer_mismatch", severity: "error" });
      expect(transfer({ amountReversed: 0 })[0]).toMatchObject({ kind: "transfer_mismatch", severity: "warning" });
    });

    it("flags a sale that still has no transfer after the grace period, and not before it", () => {
      expect(kinds(run((v) => ({ ...v, ledger: { ...v.ledger, transfers: [] } })))).toEqual(["transfer_missing"]);
      const fresh = run((v) => ({ ...v, ledger: { ...v.ledger, transfers: [], payments: [{ ...v.ledger.payments[0]!, createdAt: NOW - 60_000 }] } }));
      expect(fresh).toEqual([]);
    });

    it("leaves out sales older than the window", () => {
      expect(run((v) => ({ ...v, ledger: { ...v.ledger, transfers: [], payments: [{ ...v.ledger.payments[0]!, createdAt: SINCE - 5 }] }, stripe: { ...v.stripe, charges: [] } }))).toEqual([]);
    });
  });

  it("flags a seller whose state here is not what Stripe's account says", () => {
    const findings = run((v) => ({ ...v, ledger: { ...v.ledger, sellers: [{ ...v.ledger.sellers[0]!, state: "pending_review" }] } }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "seller_state_mismatch", severity: "warning" });
    expect(findings[0]?.message).toBe("the seller is pending_review here, Stripe's account says enabled");
    const refused = run((v) => ({ ...v, ledger: { ...v.ledger, sellers: [{ ...v.ledger.sellers[0]!, state: "rejected" }] } }));
    expect(refused[0]?.message).toBe("the seller is rejected here, Stripe's account says enabled");
  });

  it("flags a sale that differs from its order, and events that are stuck or rejected", () => {
    const findings = run((v) => ({
      ...v,
      ledger: {
        ...v.ledger,
        payments: [{ ...v.ledger.payments[0]!, anomaly: "application fee 100, the order was 130" }],
        flaggedEvents: [
          { id: "evt_1Old0000000", type: "refund.created", status: "deferred", reason: "waiting for ch_1Lost000000", receivedAt: NOW - 3_600_000 },
          { id: "evt_1New0000000", type: "refund.created", status: "deferred", reason: "waiting for ch_1Lost000000", receivedAt: NOW - 60_000 },
          { id: "evt_1Bad0000000", type: "charge.succeeded", status: "rejected", reason: "destination_mismatch", receivedAt: NOW - 1000 },
          { id: "evt_1Ancient000", type: "charge.succeeded", status: "rejected", reason: "destination_mismatch", receivedAt: SINCE - 1000 },
          { id: "evt_1NoReason00", type: "charge.succeeded", status: "rejected", reason: null, receivedAt: NOW - 1000 },
        ],
      },
    }));
    expect(findings.map((f) => `${f.kind}:${f.subject}`).sort()).toEqual([
      "order_mismatch:ch_1ChargeAaaaa", "rejected_event:evt_1Bad0000000", "rejected_event:evt_1NoReason00", "stuck_event:evt_1Old0000000",
    ]);
    expect(findings.find((f) => f.kind === "order_mismatch")?.severity).toBe("error");
    expect(findings.find((f) => f.subject === "evt_1NoReason00")?.message).toContain("no reason recorded");
  });

  it("lists errors before warnings in a stable order", () => {
    const findings = run((v) => ({
      ...v,
      ledger: { ...v.ledger, payouts: [], sellers: [{ ...v.ledger.sellers[0]!, state: "restricted" }] },
      stripe: { ...v.stripe, charges: [] },
    }));
    expect(findings.map((f) => `${f.severity}:${f.kind}`)).toEqual(["error:charge_missing_in_stripe", "error:payout_missing_in_ledger", "warning:seller_state_mismatch"]);
    expect(formatFindings(findings)[0]).toMatch(/^ERROR\s+charge_missing_in_stripe\s+ch_1ChargeAaaaa/);
  });

  it("does not look at an account Stripe was not asked about", () => {
    const findings = run((v) => ({ ...v, stripe: { ...v.stripe, accounts: [] } }));
    expect(findings).toEqual([]);
  });
});
