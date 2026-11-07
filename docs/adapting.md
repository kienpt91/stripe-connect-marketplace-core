# Adapting this to a Supabase and Next.js marketplace

The repository is a reference core, not a product. It has never been run against the real Stripe API or a real Supabase project, it has not been audited and it has not been used in production. This guide is for a client who already has a single-page app or a Next.js MVP with Supabase and Stripe and wants the payments backend of a two-sided marketplace. Where a statement about Supabase or Stripe has not been checked against a real project, it says "not verified".

## 1. What you get and what you still build

You get use cases over ports, exported from `src/index.ts`: `registerSeller`, `createOnboardingLink`, `refreshSeller`, `startCheckout`, `requestRefund`, `ingestEvent`, `retryDeferred`, `reconcile`, `sellerLedger`, `sellerOrders`. The ports are `Database` (PostgreSQL adapter, five plain SQL migrations) and `StripeGateway` (`HttpStripeGateway`, or `FakeStripe` for tests). The core owns the money rules: the fee as integers, the append-only ledger, idempotent webhook ingestion, the seller state machine, reconciliation, and the database roles.

You still build the web app, the login, the pages, the cron, the alerting and the operator tooling, and you decide the commercial rules (section 4). `src/bin.ts` only offers `migrate`, `serve`, `reconcile` and `demo`; the Next.js routes below are sketches that were not run.

## 2. Mapping onto Supabase and Next.js

### a. Seller identity

Use the Supabase auth user id as the seller id: `registerSeller` takes the id, and it must be a UUID (`parseUuid` in `src/domain/ids.ts`). Then a policy can compare a row's `seller_id` with `auth.uid()`.

The core reads the identity from `app.seller_id`, set per transaction by `src/infrastructure/postgres/database.ts` after `SET LOCAL ROLE mkt_seller`; every policy in `migrations/0005_row_level_security.sql` goes through `app_seller_id()`. If the browser must read its own rows straight from Supabase, add a new migration (never edit 0005; see deployment.md) with policies for the `authenticated` role. This is a sketch and was not run:

```sql
-- migrations/0006_supabase_authenticated.sql
REVOKE ALL ON sellers, orders, payments, stripe_objects, stripe_events, ledger_entries, ledger_lines FROM anon, authenticated;
GRANT SELECT ON sellers, orders, ledger_entries, ledger_lines TO authenticated;

CREATE POLICY sellers_auth ON sellers        FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY orders_auth  ON orders         FOR SELECT TO authenticated USING (seller_id = auth.uid());
CREATE POLICY entries_auth ON ledger_entries FOR SELECT TO authenticated USING (seller_id = auth.uid());
CREATE POLICY lines_auth   ON ledger_lines   FOR SELECT TO authenticated USING (seller_id = auth.uid());
```

Policies are per role, so these do not touch `mkt_seller`. Give `authenticated` no policy on `stripe_events`. Check which default privileges Supabase gave `anon` and `authenticated` on your tables (the REVOKE line is there for that); not verified. A simpler design needs none of this: the browser never queries these tables, and your route handlers call `sellerLedger` as the seller actor (b below).

Which secrets must never reach the browser: the `DATABASE_URL` of the login role (and its password), `STRIPE_SECRET_KEY`, `WEBHOOK_SECRETS`, and Supabase's service role key. Never put them in a `NEXT_PUBLIC_` variable. Supabase's `service_role` bypasses row level security. If the webhook handler connected with it, or as any role with BYPASSRLS, the policies and the column grants of 0005 would not apply to it, and the guarantee that no application role can change or delete a ledger row would not hold (`test/integration/rls.test.ts` checks the three roles, not your service role). So the handler uses the login role of this repo (member of `mkt_seller`, `mkt_operator`, `mkt_system`; deployment.md) and the adapter switches into `mkt_system` per transaction.

### b. Next.js route handlers

All of these must run on the Node runtime (`export const runtime = "nodejs"`): the core uses `node:crypto` and `pg`, so the Edge runtime will not work. Build the dependencies once per process with `compose(...)` and keep them in a module-level variable. In serverless hosting set `poolMax` small (`compose` takes it; the default is 10 per instance). The fee policy is an object `{ percentBps, fixedMinor, minimumChargeMinor }`; `parseFeePolicy` (exported) checks one, and `src/composition/config.ts` shows the ranges.

```ts
// app/api/webhooks/stripe/route.ts (sketch)
export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  const raw = Buffer.from(await request.arrayBuffer()); // the exact bytes; do not parse before verifying
  const verdict = verifySignature(request.headers.get("stripe-signature") ?? undefined, raw, secrets, Date.now(), 300_000);
  if (verdict !== "ok") return Response.json({ error: "invalid_signature" }, { status: 401 });
  try {
    const result = await ingestEvent(deps, JSON.parse(raw.toString("utf8")));
    return Response.json({ received: true, status: result.status }); // 200 for every recorded outcome
  } catch {
    return Response.json({ error: "internal_error" }, { status: 500 }); // Stripe sends it again
  }
}
```

This follows `src/infrastructure/http/server.ts`: 401 for a bad signature, 400 for a body that is not JSON, 200 for every recorded outcome (`rejected` included, since sending a refused event again cannot change the answer), 500 when processing failed. `await request.text()` also works for valid UTF-8; the byte array is exact. `ingestEvent` calls Stripe for `account.updated`, so the route needs the Stripe key.

- **Checkout:** a route for the signed-in user calls `startCheckout(deps, { sellerId, buyerRef, amount, currency, description, idempotencyKey, successPath, cancelPath })`. The `sellerId` is the id of the seller being bought from, not of the buyer; `buyerRef` is an opaque reference. The request has no fee field. The paths are relative paths on `APP_ORIGIN`.
- **Onboarding:** `registerSeller(deps, { sellerId: user.id, displayName, country })`, then `createOnboardingLink(deps, { kind: "seller", sellerId }, sellerId, { returnPath, refreshPath })` and redirect to the returned URL. Make the seller id with `parseId<"SellerId">(user.id)` (exported; it returns `undefined` for anything that is not a UUID) from the id you got from `auth.getUser()`, never from the request body.
- **Dashboard:** `sellerLedger(deps, actor, sellerId)` and `sellerOrders(...)` with the seller actor. Row level security, not your `WHERE`, is the last lock (`test/contract/isolation.scenarios.ts`).
- **Cron:** call `reconcile(deps, { since })` and `retryDeferred(deps)` on a schedule. Outside `serve` nothing else runs `retryDeferred`. Use a platform cron, GitHub Actions, or a Supabase scheduled job that calls a Node route or runs `reconcile`. Running this package inside a Deno-based Supabase Edge Function is not verified.

### c. Connection pooling

Run migrations over the direct connection or the pooler's session mode (port 5432); transaction mode (port 6543) is the wrong place for DDL with an advisory lock. The adapter keeps its state per transaction only: `SET LOCAL ROLE`, `set_config('app.seller_id', ..., true)` and `pg_advisory_xact_lock`, and it uses no named prepared statements. In principle that suits transaction-mode pooling. It was not verified against Supabase's pooler. One more thing to check: the pool sends `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` as connection startup parameters, and a pooler may refuse or ignore those; not verified. Test with your pooler before you rely on it, or use the direct or session connection.

### d. Migrations

The files in `migrations/` are plain SQL. Apply them with `npm run migrate` (`DATABASE_ADMIN_URL`, checksums, advisory lock; see deployment.md), or copy them into your Supabase CLI migrations directory, in order, and keep the names. Do not mix both ways: `migrate` records checksums in `schema_migrations`. Roles are cluster-wide, and `0001_roles.sql` runs `CREATE ROLE`. Some managed services restrict it; check yours, and run that part as an administrator if needed.

## 3. The Stripe side

- **Account type.** `HttpStripeGateway.createAccount` in `src/infrastructure/stripe/http-gateway.ts` posts `type=express` with the `card_payments` and `transfers` capabilities and `metadata[seller_id]`. To use another account type, change the fields there and check the onboarding and state mapping in `src/domain/seller.ts`; neither was tested against another type.
- **Two webhook endpoints.** One for events of the platform account, one Connect endpoint for events of connected accounts. Each has its own signing secret: put both in `WEBHOOK_SECRETS`.
- **Event types to subscribe to** (`handledEventTypes()` in `src/domain/stripe-events.ts`): `account.updated`, `charge.succeeded`, `refund.created`, `refund.updated`, `refund.failed`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `payout.created`, `payout.updated`, `payout.paid`, `payout.failed`, `payout.canceled`, `transfer.created`, `transfer.updated`, `transfer.reversed`. Others are recorded as `ignored`.
- **Metadata contract.** Checkout writes `order_id` into the PaymentIntent metadata. A charge without a known order id is recorded as ignored (`not_a_marketplace_charge`, `src/application/apply.ts`), so other charges of the same Stripe account do not touch the ledger.

## 4. What to change for the client

- **Fee policy:** `FEE_PERCENT_BPS`, `FEE_FIXED_MINOR`, `MIN_CHARGE_MINOR` (`splitCharge`, `src/domain/money.ts`). One policy for the whole platform.
- **Per-seller fees:** not built. The place is `startCheckout`, which calls `splitCharge(deps.fees, amount)`: look up a policy by seller there. The webhook compares the charge's fee with the order's, so the order must store the fee it used (it does).
- **Currencies:** `CURRENCY_EXPONENT` in `src/domain/money.ts` lists usd, eur, gbp, cad, aud, chf, sek, jpy, krw; other currencies are refused. Add an entry with its exponent. The ledger is per currency; there is no conversion.
- **Refunds and lost disputes:** who bears them is this repository's rule, not Stripe's: the seller bears them, the platform returns its fee in proportion (`allocateReversal` in `src/domain/money.ts`, the postings in `src/domain/ledger.ts` and `src/application/apply.ts`; `docs/adr/0003-the-ledger-and-who-bears-what.md`). When a refund and a lost dispute are for the same money, the platform bears the part the sale can no longer give back (`takeBack` in `src/application/apply.ts`; `platform_fees` can then go below zero). A client that wants the platform to absorb disputes changes the postings and their tests.
- **Seller states** are `new`, `requirements_due`, `pending_review`, `enabled`, `restricted`, `rejected`. Only `enabled` can be sold for. Map them to your UI labels; do not add states without changing `TRANSITIONS`.
- **Tax and Stripe's own fees** are not modelled. The `platform_fees` account holds the application fee, before whatever Stripe charges the platform.

## 5. Go-live checklist

- Create the login role and the owner role, keep passwords and keys in a secret store (deployment.md).
- Use a restricted Stripe key that covers the calls listed in deployment.md; test that every one works.
- Run the integration suite: `scripts/integration.sh` starts a throwaway PostgreSQL 16 container for it. To use your own server, set `MARKETPLACE_TEST_DATABASE_URL` to the superuser URL of a throwaway or staging server (the suites create databases and roles there; never point it at production). Without that variable the database suites are skipped.
- Run an end to end purchase in Stripe's test mode: onboard, pay, refund, payout; then run `reconcile` and read every finding.
- Set up the cron, and alert on `rejected` and stale `deferred` events, negative seller balances and a non-zero exit of `reconcile`.
- Read `SECURITY.md` "What is not guaranteed" with the client.

## 6. What is deliberately left out

Subscriptions, invoicing, tax, accounting for Stripe's fees, a KYC interface (Stripe hosts it), payout scheduling, dispute evidence, multi-currency settlement, per-seller fees, a seller dashboard UI and an admin UI. These are the usual paid extensions.
