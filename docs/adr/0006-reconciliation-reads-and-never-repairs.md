# 0006. Reconciliation reads and never repairs

Status: accepted

## Context

Webhooks can be lost, endpoints can be down for a day, and this repository's own rules (0003) can disagree with Stripe's figures. Something has to compare the ledger with Stripe on a schedule and say where they differ. If it also fixed the difference, a bug in either side would be hidden by a silent write, and an operator could not tell a lost event from a wrong rule.

## Decision

`compareLedgerWithStripe` in `src/domain/reconciliation.ts` is pure. `reconcile` in `src/application/reconcile.ts` reads the ledger in one transaction as the operator role, then reads Stripe (`retrieveAccount`, `retrieveBalance`, `listPayouts` per seller, `listCharges` for the platform), and returns findings. It writes nothing. If Stripe cannot be read it returns `gateway_failed` instead of a half-compared report.

Compared: ledger debit and credit totals per currency; each seller's balance against the connected account's `available + pending`; negative seller balances; payouts (missing on either side, amount, status); charges (missing on either side, amount, fee, refunded amount, destination); each sale's transfer (exists, goes to the seller, amount is the net, reversed amount is the seller's part of what was taken back); the seller's state against the account; payments whose order differs; and flagged events, namely deferred longer than `stuckAfterMs` (default 15 minutes) and rejected ones. An error is money that disagrees; a warning is something to look at, such as a lagging payout status or a negative seller balance. `since` limits the comparison of payouts, charges and transfers to objects created at or after it; balances are always compared.

The only repair is `refreshSeller` (`src/application/sellers.ts`), which does what the `account.updated` handler does: read the account from Stripe and apply it. Everything else is for a person.

## Consequences

- `test/contract/reconciliation.scenarios.ts` covers lost sale, refund and payout events, a lagging status, a charge to the wrong account and the transfer waiting for it, a sale that differs from its order, the window, and an unreadable Stripe.
- It cannot see disputes (Stripe's disputes are not listed; they show up only through the balance and the transfer), Stripe's own fees (not modelled), or objects older than `since`.
- A reconcile compares a ledger snapshot with Stripe's later state; an event applied in between can show as a transient finding. Run it again before acting.
- Not verified against the real API: the figures `retrieveBalance` and `listCharges` return were only exercised through `FakeStripe` and a loopback server.
