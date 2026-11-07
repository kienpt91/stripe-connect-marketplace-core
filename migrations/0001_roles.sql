-- The database roles the application uses.
--
-- Roles are cluster-wide objects. The application connects with ONE login role (create it yourself, with a password from your
-- secret store, see docs/deployment.md) that is a member of the three roles below and switches into one of them at the start of
-- every transaction (SET LOCAL ROLE). None of them can bypass row level security, and none owns a table, so every policy applies to
-- every statement the application sends.
--
--   mkt_seller    a signed-in seller: reads their own rows and nothing else, writes nothing
--   mkt_operator  platform staff: reads every row (reconciliation, support), writes nothing
--   mkt_system    the webhook handler and the checkout: writes what the flows need, can never change or delete a ledger row
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['mkt_seller', 'mkt_operator', 'mkt_system'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT', r);
    END IF;
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO mkt_seller, mkt_operator, mkt_system;
