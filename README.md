# stripe-connect-marketplace-core

A reference core for the payments backend of a two-sided marketplace on Stripe Connect, written for the questions a code and security review of such a system has to answer:

1. **Events repeat, race and arrive out of order.** Webhooks are idempotent on the event id and applied exactly once; a refund that arrives before its charge waits for it; shuffled, duplicated and concurrent deliveries of the same history end in the same books, on both stores.
2. **One seller sees or changes another seller's money.** Row level security with a role and an identity claim per transaction, and three locks on the door: the use case, the query and the database role.
3. **The books are rewritten or do not balance.** An append-only double-entry ledger: no UPDATE, DELETE or TRUNCATE for anyone (the owner included), every entry checked for balance at COMMIT, every business fact booked once.
4. **The commission or an amount is manipulated.** Integer minor units, a fee computed by the platform (the request has no field for it), half-up rounding, refunds split pro rata so that the parts add up exactly.
5. **A forged request pretends to be Stripe.** HMAC over the raw bytes, checked before anything is parsed; replay and tampering are tested.

It also has a seller onboarding state machine (`new`, `requirements_due`, `pending_review`, `enabled`, `restricted`, `rejected`), checkout with destination charges, payouts, refunds and disputes, and a reconciliation report that flags where the ledger and Stripe disagree.

It is an original, small, public reference that is meant to be adapted to a client in days (`docs/adapting.md` maps it onto a Supabase and Next.js app). It has **not** been used in production, has **not** had an independent security review, and has **never talked to Stripe**: tests and demos use an in-process fake, and the adapter for the real API has only been run against a fake server on loopback. Read "What is not verified" before relying on any of it.

## Demo output

`scripts/demo.sh` starts a throwaway PostgreSQL 16.14 container with no network, runs the whole story with the fake Stripe (no key, no account) and prints what happened; it exits 1 if a claim does not hold. This is real output (`docs/demo-output.txt`).

```
stripe-connect-marketplace-core demo
database: PostgreSQL 16.14 (Debian 16.14-1.pgdg13+1), a throwaway server with no network; Stripe: an in-process fake, nothing leaves this process

1. a seller's onboarding follows the account at Stripe
  registered Alba Ceramics            state new
  checkout while new               refused: seller_not_enabled
  account.updated, details missing -> requirements_due
  details submitted, verifying     -> pending_review; checkout refused: seller_not_enabled
  verified, charges and payouts on -> enabled
  -> no checkout until the account is enabled; the state is read from Stripe, not from the event

2. checkout: a destination charge with the platform's fee in integers of the minor unit
  order of 49.99 USD: fee 5.30 USD (10 % of 49.99 is 4.999, rounded half up to 5.00, plus 0.30), seller gets 44.69 USD
  the same idempotency key again   -> the same order, the same session: true
  amounts 49.99, 4999.5, "4999", -4999, 99 -> invalid_amount, invalid_amount, invalid_amount, invalid_amount, amount_below_minimum
  a request that names its own fee -> the fee is 10.30 USD anyway (the request has no such field)
  -> the fee is the platform's, whole minor units, half up; a retried key is one order

3. the webhook over HTTP on loopback: signature, replay, tampering, size
  charge.succeeded, signed           -> HTTP 200 {"received":true,"status":"applied"}
  the same event delivered again     -> HTTP 200 {"received":true,"status":"duplicate"}
  signed with another secret         -> HTTP 401 {"error":"invalid_signature"}
  body changed after signing         -> HTTP 401 {"error":"invalid_signature"}
  signature from ten minutes ago     -> HTTP 401 {"error":"invalid_signature"}
  no signature at all                -> HTTP 401 {"error":"invalid_signature"}
  a 70 KB body                       -> HTTP 413 {"error":"payload_too_large"}
  transfer.created, signed           -> HTTP 200 {"received":true,"status":"applied"}
  ledger: 1 sale entry, Alba is owed 44.69 USD
  -> a forged, altered, stale or missing signature never reaches the ledger; a replay is a no-op

4. a sale, a refund and a dispute whose events arrive backwards, and some of them twice
  charge.dispute.closed      deferred (waiting for ch_1Fake0000000013)
  charge.dispute.created     deferred (waiting for ch_1Fake0000000013)
  charge.dispute.created     duplicate
  refund.created             deferred (waiting for ch_1Fake0000000013)
  transfer.reversed          deferred (waiting for ch_1Fake0000000013)
  transfer.created           deferred (waiting for ch_1Fake0000000013)
  transfer.created           duplicate
  charge.succeeded           applied
  events still waiting for a charge: 0 (the 5 that were waiting were applied in the transaction that recorded the charge)
  refund 30.00 USD of 120.00 USD: the platform gives back 3.07 USD of its 12.30 USD (floor of 307.5), the seller 26.93 USD
  Alba's second sale is worth 80.77 USD to her in any order; the books say 80.77 USD
  -> out of order and duplicated events end in the same books as in order (a refund before its charge waits for it)

5. a refund after the seller was paid out
  payout of 120.00 USD: Alba is owed 5.46 USD
  refund of the rest (90.00 USD) requested: succeeded
  Alba is owed -75.31 USD: she owes the platform 75.31 USD
  WARNING negative_seller_balance    a1ba0000-0000-4000-8000-000000000001  the seller owes the platform 75.31 USD: a refund or a lost dispute exceeded what the seller was owed
  -> the ledger records the debt, stays balanced, and reconciliation names it without calling it a mismatch

6. the webhook endpoint was down: reconciliation finds what the ledger missed
  ERROR   balance_mismatch           b2b00000-0000-4000-8000-000000000002  ledger owes the seller 224.70 USD, the Stripe balance of acct_1Fake0000000030 is 124.70 USD (available + pending)
  ERROR   payout_missing_in_ledger   po_1Fake0000000038  Stripe paid out 100.00 USD (paid) from acct_1Fake0000000030; the ledger has no such payout
  the 2 lost events are delivered: no errors left
  -> a payout the ledger never heard of is an error with both numbers; delivering the events clears it

7. sellers cannot see each other's money, and nobody can rewrite the ledger
  Bruno asks the application for Alba's ledger     -> forbidden
  Bruno's own ledger                               -> 2 lines, balance 124.70 USD
  as Bruno's database role, asking by Alba's id    -> 0 ledger lines, 0 orders, seller row hidden: true
  Bruno's role tries to change an order            -> permission denied for table orders
  the database owner tries UPDATE: the ledger is append-only (UPDATE on ledger_lines)
  the database owner tries DELETE: the ledger is append-only (DELETE on ledger_entries)
  the database owner tries TRUNCATE: the ledger is append-only (TRUNCATE on ledger_lines)
  an entry whose debits and credits differ         -> ledger entry payout:po_1Forged00001 does not balance: 2 lines for the 2 declared, debits 99999, credits 100000, total 100000
  -> isolation holds at the application and at the database role; the ledger is append-only even for its owner, and unbalanced entries cannot commit

8. the books
  funds at Stripe 79.99 USD + disputed 0.00 USD  =  owed to sellers 49.39 USD + platform fees 30.60 USD
  all debits 939.99 USD, all credits 939.99 USD
  -> debits equal credits, and what Stripe holds is what the sellers are owed plus what the platform earned

RESULT: every claim held (8 of 8).
```

## Run it

Everything runs in containers; nothing is installed on your machine except Docker. Node 24.14.1 and PostgreSQL 16.14 are pinned by digest in the scripts.

```sh
scripts/node.sh install                  # npm ci --ignore-scripts into a docker volume (the only step with network access)
scripts/node.sh "npm run typecheck && npm test"   # offline suite, thresholds enforced
scripts/integration.sh                   # every test incl. PostgreSQL, against a throwaway database with no network, thresholds enforced
scripts/demo.sh | tee docs/demo-output.txt
```

The PostgreSQL tests have a connection budget (40 connections, `test/support/connection-budget.ts`) and run against a server with PostgreSQL's default `max_connections` of 100, as the CI service does: one test file at a time, every pool of the scenario suites opened through `openPool`. A monitor (`test/support/connection-monitor.ts`) refuses to start when the server allows fewer connections than the budget and fails the run when the measured peak is over it; the peak is printed at the end ("postgres connections: peak 12 of 97 usable").

The project is mounted read-only into a container that runs as you, drops every capability, has no network after the install and is limited to 4 CPUs and 6 GiB.

## How it fits together

```
src/domain          pure rules: money and fees, the seller state machine, the ledger, Stripe event parsing, reconciliation
src/application     use cases (register, onboarding link, checkout, ingest, refund, reconcile, views), ports, applying an event
src/infrastructure  PostgreSQL adapter, webhook server (node:http), signature, fake Stripe, HTTP adapter for the real API
src/composition     wires the adapters into the use cases; configuration, serve
src/bin.ts, src/demo  entry points: migrate | serve | reconcile | demo; the demonstration
migrations/         plain SQL: schema, the append-only ledger, row level security
```

The direction is domain <- application <- infrastructure <- composition, enforced by `test/architecture/layers.test.ts` (ADR 0001). The path of an event: webhook server (size, signature over the raw bytes) -> `ingestEvent` (lock on the charge, payout or account; the event id is recorded or found; the fact is applied; waiting events are applied) -> ledger entries keyed by the business fact, all in one transaction. A purchase: `startCheckout` writes the order (one per idempotency key), asks Stripe for a Checkout Session with the fee and the destination account, and the sale is booked when the signed `charge.succeeded` event arrives. Nothing is booked from what a caller says; everything is booked from what Stripe confirms.

The ledger in one table (amounts are minor units; the rules are in [ADR 0003](docs/adr/0003-the-ledger-and-who-bears-what.md)):

| Fact | Debit | Credit |
| --- | --- | --- |
| sale | `stripe_funds` (the charge) | `seller_balance` (net), `platform_fees` (fee) |
| refund | `seller_balance`, `platform_fees` (pro rata) | `stripe_funds` |
| dispute opened / won / lost | `disputed_funds` / `stripe_funds` / `seller_balance` and `platform_fees` (pro rata) | `stripe_funds` / `disputed_funds` / `disputed_funds` |
| payout | `seller_balance` | `stripe_funds` |

Decisions, with their trade-offs: [0001 layers](docs/adr/0001-layers-and-the-dependency-rule.md), [0002 money and the fee](docs/adr/0002-money-is-integers-and-the-fee-is-the-platforms.md), [0003 the ledger and who bears what](docs/adr/0003-the-ledger-and-who-bears-what.md), [0004 events arrive twice and out of order](docs/adr/0004-events-arrive-twice-and-out-of-order.md), [0005 roles, row level security, append-only](docs/adr/0005-roles-row-level-security-and-an-append-only-ledger.md), [0006 reconciliation](docs/adr/0006-reconciliation-reads-and-never-repairs.md), [0007 a fake Stripe and scenarios on two stores](docs/adr/0007-a-fake-stripe-and-scenarios-on-two-stores.md). The threat model, with a test named for every claim (checked by `test/docs/docs.test.ts`) and a list of what is not guaranteed, is in [SECURITY.md](SECURITY.md). Deployment: [docs/deployment.md](docs/deployment.md). Adapting it to a client's Supabase and Next.js app: [docs/adapting.md](docs/adapting.md).

## What was verified, and how

All numbers come from runs of the final tree in fresh containers (the dependency volume was removed first; Node 24.14.1, PostgreSQL 16.14 pinned by digest, no network after the install).

| Run | Files | Tests | Result |
| --- | --- | --- | --- |
| `npm run coverage` (default, no database) | 15 | 395 | passed, thresholds met |
| `scripts/integration.sh` (everything, PostgreSQL included) | 21 | 567 | passed, thresholds met |
| `scripts/demo.sh` | | | exit 0, "every claim held (8 of 8)" |

172 of the tests need a database: the schema (39), row level security (32), the adapter (14), the real server and the demo database (10), and every scenario again on PostgreSQL (77). The scenario suites (onboarding, checkout, webhooks in any order, refunds and disputes, isolation between sellers, reconciliation, shuffled delivery) run on the in-memory double **and** on PostgreSQL, so the double is only trusted because both agree. Mutating a policy, the append-only triggers, the balance trigger or `FORCE ROW LEVEL SECURITY` makes tests fail (checked by hand while writing them).

Coverage (lines / statements), thresholds domain >= 95, application >= 90, overall >= 85, enforced in both runs:

| | default run | with PostgreSQL |
| --- | --- | --- |
| overall | 98.91 / 97.63 | 99.08 / 97.84 |
| `src/domain` | 100 / 100 | 100 / 100 |
| `src/application` | 98.42 / 97.60 | 98.42 / 97.60 |
| `src/composition` | 93.33 / 91.11 | 97.61 / 93.44 |
| `src/infrastructure/http` | 97.24 / 96.15 | 97.24 / 96.15 |
| `src/infrastructure/stripe` | 99.41 / 96.48 | 99.41 / 96.48 |
| `src/infrastructure` (clocks, logger) | 100 / 100 | 100 / 100 |
| `src/infrastructure/postgres` | not measured without a database | 99.47 / 99.07 |

Also run: release script tests (29 checks), secret scan on the tree and the full history (clean), dependency age check (90 locked packages, none newer than 2026-10-24), the checks of `test/docs/docs.test.ts` (links, contact information in the text) and of the commit message hook (`test/docs/commit-msg.test.ts`).

## What is not verified

- **Never run against Stripe.** No real account, no test-mode key, no Stripe CLI, no real webhook delivery. Event shapes, endpoints and parameters were written from Stripe's public API reference. `HttpStripeGateway` has only been run against a fake server on loopback; it creates Express accounts and Checkout Sessions with a destination and an application fee. Run a complete test-mode flow and `reconcile` before trusting any of it.
- **The money rules are this repository's rules**, not Stripe's: how a refund splits the platform's fee from the seller's share, that a lost dispute is charged to the seller in the ledger while the platform pays at Stripe until an operator reverses the transfer, and that when a charge in dispute was also refunded the platform bears the part of a lost dispute that the refund had already taken from the seller (`platform_fees` then goes below zero; ADR 0003). Stripe's own processing fees, dispute fees, taxes and appeals are not modelled (SECURITY.md).
- PostgreSQL 16.14 and Node 24.14.1 only. The CI workflows were written but have not been run on GitHub (they are modelled on the sibling repositories, whose workflows have).
- Supabase and its connection pooler were not used in any test; `docs/adapting.md` says what to check.
- Nine currencies are known; any other is refused. No conversion between currencies.
- No load test; the lock per charge serialises one charge's events, not the system's.

## Dependencies

| Package | Why |
| --- | --- |
| `pg` 8.23.1 (runtime) | the PostgreSQL driver; everything else at runtime is Node's standard library (`node:http`, `node:crypto`, `fetch`) |
| `typescript` 6.0.3 | compiler and type checker (strict) |
| `vitest` 5.0.5, `@vitest/coverage-v8` 5.0.5 | test runner and coverage with thresholds |
| `@types/node` 24.19.2, `@types/pg` 8.23.1 | types |

Exact pins, a committed lockfile, every package at least seven days old at the pin, installs without lifecycle scripts.

## Licence

MIT, see `LICENSE`. Copyright (c) 2026 Kien Phan.
