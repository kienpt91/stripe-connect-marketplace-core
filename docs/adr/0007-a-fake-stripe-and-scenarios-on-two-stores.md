# 0007. A fake Stripe, and scenarios that run on two stores

Status: accepted

## Context

The interesting failures of a payments backend (a duplicate, a reordered pair of events, a refund that fails after it succeeded, a payout that fails after it was shown as paid) cannot be provoked on demand against Stripe, and a test suite that needs a key and a network is not one that gets run. The repository also has no Stripe account behind it.

## Decision

`src/infrastructure/stripe/fake-stripe.ts` implements `StripeGateway` in memory and keeps the state Stripe would keep: accounts and their requirements, balances, sessions, charges, transfers, refunds, disputes, payouts. It follows Stripe's documented shapes and rules: the same idempotency key returns the same answer and other parameters under it are refused, a payout draws on the available balance only, a refund cannot exceed what is left. Where the rule is this repository's (how a refund splits the fee, 0003) it calls the same `allocateReversal` as the ledger. Every action of the outside world (a buyer pays, a dispute opens, a payout is made) queues the events Stripe would send in `takeEvents()`; the test decides the order and how often they are delivered. `injectFailure` makes the next calls of a method fail with a `GatewayError`, and `calls` logs every gateway call. `test/infrastructure/fake-stripe.test.ts` checks the rules, and that every event the fake emits is one `parseStripeEvent` reads.

The scenario suites in `test/contract` (`all.ts`) run twice: on the in-memory store (`test/application/marketplace.test.ts`, 60 shuffles in the convergence scenario) and on PostgreSQL with every migration and the login role (`test/integration/marketplace.pg.test.ts`, 8 shuffles). The double is trusted only where both agree.

`HttpStripeGateway` was run only against a loopback server (`test/infrastructure/http-gateway.test.ts`): request fields, pagination, error mapping, size and time limits, untrusted responses.

## Consequences

- What this does not prove: behaviour against the real Stripe API, real delivery timing and retry schedules, differences between API versions, Stripe's own rounding (0002) and the real shape of every event type. The fake encodes this repository's reading of the documentation; if that reading is wrong, the fake and the code are wrong together.
- The in-memory store and the fake must be kept in step with PostgreSQL and the API by hand. The two-store rule catches drift in the first; nothing catches drift in the second except running against Stripe.
- Before any real use, run the checkout, refund, dispute and payout flows in Stripe's test mode and compare the events with the fixtures. Not done.
