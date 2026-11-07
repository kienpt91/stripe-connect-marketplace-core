# Changelog

## 0.1.0

First release.

- PostgreSQL schema in plain SQL migrations (`migrations/`): sellers as tenants, orders with an idempotency key per seller, payments, refunds, disputes, payouts and transfers as last seen, an event log with one row per Stripe event id, and an append-only double-entry ledger whose entries are checked for balance at COMMIT; row level security on every table with three roles.
- Seller onboarding state machine (`new`, `requirements_due`, `pending_review`, `enabled`, `restricted`, `rejected`) driven by the account as Stripe reports it; `rejected` is final.
- Checkout with a destination charge and an application fee computed in integers of the minor unit (half up); the request has no way to name a fee.
- Idempotent webhook ingestion: the event id is the idempotency key, an event is recorded and applied in one transaction, an event that needs a charge that has not arrived waits for it, refund, dispute and payout states only move up in rank, `account.updated` reads the account from Stripe.
- Refunds split pro rata between the platform's fee and the seller's share (the parts add up exactly), lost and won disputes, payouts and the reversal of a payout or a refund that failed. When a charge in dispute is also refunded, the part of a lost dispute that the refund already took from the seller is borne by the platform, in either order of the two events.
- Reconciliation of the ledger against Stripe: balances, payouts, charges, transfers, seller state, ledger totals, events that are stuck or rejected.
- A fake Stripe and an offline demonstration that needs no keys; an adapter for the real API (`HttpStripeGateway`) that has only been run against a loopback server.
- `stripe-connect-marketplace-core migrate | serve | reconcile | demo`; `scripts/demo.sh` runs the demonstration against a throwaway container.
- `docs/adapting.md` maps the core onto a Supabase and Next.js application.
- Tests: counts and coverage in the README.
