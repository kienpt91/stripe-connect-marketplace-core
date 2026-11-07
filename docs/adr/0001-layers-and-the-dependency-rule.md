# 0001. Layers and the dependency rule, checked by a test

Status: accepted

## Context

The money rules (fee split, refund allocation, ledger postings, event ordering, reconciliation) are the part of a marketplace that must be right and must be testable without a network. If they import an HTTP client, a database driver or the system clock, every test needs those, and a rule can quietly start depending on wall-clock time or on a row that happens to exist.

## Decision

Four layers and entry points: `src/domain` (pure rules: `money.ts`, `ledger.ts`, `stripe-events.ts`, `reconciliation.ts`, `seller.ts`) <- `src/application` (use cases and the ports they need, `ports.ts` and `store.ts`) <- `src/infrastructure` (PostgreSQL, the HTTP webhook server, `FakeStripe`, `HttpStripeGateway`) <- `src/composition` (wiring). `src/bin.ts`, `src/index.ts` and `src/demo` are entry points that may reach `composition`, `application` and `domain`, not `infrastructure`.

`test/architecture/layers.test.ts` reads every file under `src`, extracts its imports and fails on a wrong direction, on any package or Node built-in imported by the domain or application layers, and on `pg` anywhere outside `src/infrastructure/postgres`. In the pure layers it also fails on `Date.now`, `new Date()`, `Math.random`, `process.`, `fetch(`, timers, `crypto` randomness and `console.`. Time and ids come in through the `Clock` and `IdGenerator` ports in `src/application/ports.ts`. A second test in the same file checks that no value is put into SQL text: the only interpolations allowed are a role from a fixed map and a list of numbered placeholders. Stripe is a port too: `StripeGateway`, implemented by `FakeStripe` and `HttpStripeGateway`.

## Consequences

- Every time rule is tested with a clock set by hand, and the whole use case layer runs with no key and no network.
- Persistence is a port (`Database`, `Tx`), so there is a second implementation, `test/support/memory-db.ts`. That is code to keep in step with the PostgreSQL adapter, and it is only trusted because the same scenarios run on both (see 0007).
- The check is textual: it reads import specifiers and a pattern list, not the type graph. A new source of nondeterminism not in the pattern list would pass; the pattern list has to be extended when one is found.
- Ports cost indirection for a small codebase. The price is accepted because the alternative is rules that cannot be tested without PostgreSQL and Stripe.
