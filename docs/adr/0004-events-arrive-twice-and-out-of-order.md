# 0004. Events arrive twice and out of order

Status: accepted

## Context

Stripe's webhook guide says an endpoint may receive the same event more than once and that the order of events is not guaranteed; the `created` field of an event is not an order either. A refund can arrive before its charge, a payout's `paid` before its `created`, two deliveries of one charge at the same moment. The books must end the same whatever happens.

## Decision

`ingestEvent` in `src/application/ingest.ts` treats the event id as the idempotency key and records the event and applies it in one transaction. If anything throws, nothing is recorded. Inside the transaction it takes `tx.lock(subject)`, a PostgreSQL advisory transaction lock on the charge, payout or account the event is about, so events of one charge are applied one after the other. `test/integration/adapter.pg.test.ts` ("a refund and its charge arriving at the same moment") shows the lock working, and a control with the lock switched off in which the refund is stranded as deferred until `retryDeferred` runs.

An event that needs a charge not yet recorded is stored as `deferred` and applied in the transaction that records the charge (`applyDeferred`); `retryDeferred` does the same on demand. Statuses have ranks (`refundRank`, `disputeRank`, `payoutRank` in `src/domain/stripe-events.ts`) and a stored status only moves up; a trigger in `migrations/0003` enforces it. `account.updated` is only a signal: the state is read from Stripe, and a snapshot observed earlier than the stored one is `stale` (`applyAccount` and the `observed_at <= new value` condition in the PostgreSQL repository).

Outcomes: `applied`; `stale` (valid, nothing new); `ignored` (not this marketplace's); `rejected` (cannot be trusted: unreadable object, money to the wrong account, an object that changed; no balance moves); `duplicate` (id seen before). The payload is kept only for deferred and rejected events (a CHECK in `migrations/0003`). The server (`src/infrastructure/http/server.ts`) answers 200 for every ingest outcome, rejected included, because sending it again cannot change it, and 500 when processing throws so that Stripe retries.

## Consequences

- `test/contract/convergence.scenarios.ts` delivers shuffled, duplicated and concurrent copies of one busy afternoon and ends in the same books as the in-order run, on both stores.
- A rejected charge leaves its transfer waiting; reconciliation reports it as stuck (0006).
- A dispute that goes to `lost` and then to an appeal state is not modelled; the later event is stale.
- Events of one object with the same second of `created` are ordered by rank alone.
- A held lock per charge serialises that charge's events; throughput across charges is unaffected.
