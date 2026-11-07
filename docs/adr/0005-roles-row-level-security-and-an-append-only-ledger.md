# 0005. Roles, row level security and an append-only ledger

Status: accepted

## Context

Two worries: one seller reading or changing another seller's orders and balances, and a bug (or a person) rewriting the ledger. Application-side filtering is one lock; the database should be a second one, and the ledger's history should not depend on every future code path behaving.

## Decision

`migrations/0001_roles.sql` creates three NOLOGIN roles that cannot bypass row level security and own no table: `mkt_seller`, `mkt_operator`, `mkt_system`. The application connects with one login role that is a member of all three. `PostgresDatabase.transaction` in `src/infrastructure/postgres/database.ts` starts every transaction with `SET LOCAL ROLE` (taken from a fixed map, never from input) and `set_config('app.seller_id', ..., true)`.

`migrations/0005_row_level_security.sql` enables and forces row level security on all seven tables, so the owner is subject to the policies too. Policies read the claim through `app_seller_id()`; a missing claim is NULL and matches nothing, a malformed one fails the statement. A seller reads only rows carrying their own id, cannot read `stripe_events`, and writes nothing. Only `ledger_lines` of the account `seller_balance` carry a seller id, so a seller sees their own balance lines and not the platform's side of an entry. The operator reads everything and writes nothing. The system role can INSERT everywhere and UPDATE only listed columns (grants per column); on the two ledger tables it gets INSERT and nothing else.

`migrations/0004_ledger.sql` adds triggers that refuse UPDATE, DELETE and TRUNCATE on `ledger_entries` and `ledger_lines` for anyone, the owner included. An entry declares `line_count` and `total_minor`, and a deferred constraint trigger checks at COMMIT that its lines match and that debits equal credits. `posting_key` is unique.

## Consequences

- Evidence: `test/integration/rls.test.ts` attacks the policies (cross-seller reads by join, subquery and union; a missing or non-UUID claim; `SET ROLE` out of the login role's membership; write attempts by each role). `test/integration/schema.test.ts` checks that the ledger refuses UPDATE, DELETE and TRUNCATE even for the superuser, an unbalanced entry, a missing line, a line added later, a wrong declared total, and a repeated posting key.
- Limits: anything able to run arbitrary SQL as the login role can `SET ROLE` or call `set_config` itself, so a SQL injection defeats the policies; the adapter puts no value in SQL text (0001). A superuser or the schema owner can disable a trigger. The system role reads every seller's rows, because the webhook handler is the whole platform.
- Mapping the roles onto a hosted PostgreSQL such as Supabase is in `docs/adapting.md`. That mapping has not been run against a real Supabase project.
