# Deployment notes

The service has never been run against the real Stripe API or in production, and it has not been audited. Treat this page as what the code does, plus a checklist to verify in your own environment. Tested on PostgreSQL 16 only.

## The database roles

Roles are cluster-wide. `migrations/0001_roles.sql` creates three NOLOGIN roles if they are missing: `mkt_seller`, `mkt_operator`, `mkt_system`. The application connects with one login role that is a member of all three and switches into one of them at the start of every transaction (`SET LOCAL ROLE`). Create it yourself:

```sql
CREATE ROLE marketplace_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD '<from your secret store>';
GRANT mkt_seller, mkt_operator, mkt_system TO marketplace_app;
```

NOINHERIT matters: the login role alone can read nothing (`test/integration/rls.test.ts`). The schema is owned by a different role (the one in `DATABASE_ADMIN_URL`), which only `migrate` uses; never run the service as the owner. Do not use a superuser or a role with BYPASSRLS (on Supabase that includes the service role) for the service: row level security and the column grants would not apply to it. `0001` needs `CREATE ROLE`; on a managed service that restricts it, create the three roles first as an administrator (the migration skips roles that exist) and run the rest as the owner.

Keep the password out of the URL: use `PGPASSWORD` or a `.pgpass` file. Off the host, use `sslmode=verify-full` in `DATABASE_URL`, with the CA available to the process.

## Migrations

Run `npm run migrate` (`DATABASE_ADMIN_URL`) before each deploy, from one place. It applies the plain SQL files in `migrations/` in order, each in its own transaction, records a SHA-256 checksum in `schema_migrations`, and refuses to continue if an applied file was edited. An advisory lock stops two deployments migrating at once. It prints how many migrations it applied and how many were already there.

## Environment

`serve` and `reconcile` read the same variables (`src/composition/config.ts`). A missing or invalid one is named in the error; no value is printed.

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | the login role's connection string |
| `STRIPE_SECRET_KEY` | yes | the platform's secret or restricted key |
| `WEBHOOK_SECRETS` | yes | comma-separated signing secrets, newest first; each at least 24 characters without spaces. Give the account endpoint and the Connect endpoint a secret each and list both. `reconcile` requires it too |
| `APP_ORIGIN` | yes | the one `https` origin people are sent back to (plain http for localhost only); no path |
| `FEE_PERCENT_BPS` | no | default 1000 (10 %), 0 to 10000 |
| `FEE_FIXED_MINOR` | no | default 30, 0 to 99999999; minor units of whichever currency the charge is in, not currency-aware: 30 is 0.30 USD but 30 yen |
| `MIN_CHARGE_MINOR` | no | default 100, 1 to 99999999; the same: 100 is 1.00 USD but 100 yen |
| `STRIPE_API_VERSION` | no | sent as `Stripe-Version` when set; empty means unset |
| `HOST`, `PORT` | no | default `127.0.0.1`, 8080 |
| `WEBHOOK_MAX_BODY_BYTES` | no | default 65536, 1024 to 1048576 |
| `WEBHOOK_TOLERANCE_SECONDS` | no | signature age tolerance, default 300, 5 to 3600 |
| `TRUSTED_PROXY_HOPS` | no | proxies in front that append to `X-Forwarded-For`, default 0 (header ignored), 0 to 3 |
| `SINCE_DAYS` | no | `reconcile` only: how far back, default 30, 1 to 400 |
| `DATABASE_ADMIN_URL` | `migrate` only | the schema owner's URL |

## The webhook endpoint

`POST /webhooks/stripe`. Terminate TLS and apply request limits at a reverse proxy and forward to the service's `HOST:PORT`. The server itself enforces `application/json` (415), the body limit (413), a 15 second request timeout and a 10 second header timeout. The signature is checked over the exact bytes before the body is parsed. Set `TRUSTED_PROXY_HOPS=1` with one proxy that writes `X-Forwarded-For`; the address is only used to count failed signatures (401, then 429 after 30 a minute, which never blocks a valid signature).

Answers: 200 means recorded (every outcome, `rejected` and `duplicate` included); 400 body is not JSON; 401 signature refused; 404, 405, 413, 415, 429 as described; 500 processing failed, nothing was recorded. Stripe treats a non-2xx response as a failed delivery and sends the event again; the event id makes a repeat safe. Stripe's retry schedule is in its documentation, not checked here.

`GET /healthz` answers 200 while the process runs. `GET /readyz` answers 200 if `SELECT 1` works, otherwise 503. Use `/readyz` for the load balancer.

## Rotating secrets

Webhook secret: create the new one in Stripe, put it first in `WEBHOOK_SECRETS` (`new,old`), restart, then remove the old one. Any listed secret verifies a request (`src/infrastructure/http/signature.ts`).

Stripe key: use a restricted key. `HttpStripeGateway` calls only these endpoints, with `Authorization: Bearer` and no redirects followed: `POST /v1/accounts`, `POST /v1/account_links`, `GET /v1/accounts/{id}`, `POST /v1/checkout/sessions`, `POST /v1/refunds`, `GET /v1/balance` and `GET /v1/payouts` (both with a `Stripe-Account` header), `GET /v1/charges`. Give the key the permissions for those and nothing else; the dashboard's permission names are not checked here, so confirm with a test-mode run. Roll the key in Stripe, change the variable, restart.

## Scheduled work

`npm run reconcile` compares the ledger with Stripe and prints every finding. Exit code 1 means at least one `ERROR` finding (or an unexpected failure such as a missing variable), 2 means Stripe could not be read or `SINCE_DAYS` is invalid, 0 means no error finding. Warnings (a negative seller balance, a stuck or rejected event, a missing transfer) exit 0: read the output or monitor them separately. Run it daily from a cron or scheduler as the login role. `retryDeferred` runs inside `serve` every minute; with no `serve` process, schedule it yourself.

## What to monitor

Alert on: `ERROR` and `WARNING` lines of `reconcile`; events with status `rejected` or an old `deferred` (as `mkt_operator`: `SET ROLE mkt_operator; SELECT id, type, status, reason FROM stripe_events WHERE status IN ('deferred','rejected');`); negative seller balances (a refund or a lost dispute above what the seller was owed); a rising rate of 5xx or log lines `http.processing_failed`, `job.failed`, `database.pool_error`; `/readyz` failing. Logs are JSON lines on stdout.

## Backups and restore

The ledger is the record. Back up the database with your provider's tools and test a restore. After restoring to a point in time, run `reconcile`: events Stripe sent after that point arrive again only if Stripe still retries them, and the findings show what is missing. Erasure of personal data is out of scope here.

## Data kept

`stripe_events` keeps the event payload only while the status is `deferred` or `rejected` (a table CHECK says the same); other events keep id, type, status and reason. Sellers have a display name and the parts of the Stripe account the state machine reads. Orders carry `buyer_ref`, an opaque reference you choose; this core asks for no buyer name or e-mail address. The accepted format (`[A-Za-z0-9_.:@-]`, up to 100 characters) would let one through, so do not put one in it.

## Upgrading

Migrations are append-only: never edit one that was applied (the checksum refuses it); add a new file with the next number. Read `CHANGELOG.md` before upgrading and run `migrate` before starting the new version.
