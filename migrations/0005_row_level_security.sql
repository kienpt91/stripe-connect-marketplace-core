-- Row level security and grants.
--
-- The application sets the identity of the request at the start of every transaction:
--     SET LOCAL ROLE mkt_seller;
--     SELECT set_config('app.seller_id', '<uuid>', true);
-- and every policy below reads it through app_seller_id(). A missing or empty claim is NULL, a comparison with NULL is never true,
-- so a request without an identity sees nothing (it fails closed); a malformed claim fails the statement.
--
-- FORCE ROW LEVEL SECURITY makes the policies apply to the table owner as well. Only a superuser or a role with BYPASSRLS skips
-- them, and the application never connects as one.
--
-- What this does and does not protect: it stops a query that forgot a WHERE clause, or was given the wrong id, from reading
-- another seller's rows. It does not stop code that is able to run arbitrary SQL as the login role from issuing SET ROLE or
-- set_config itself: keep that SQL in the repositories (all of it uses bind parameters).
CREATE FUNCTION app_seller_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.seller_id', true), '')::uuid $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sellers', 'orders', 'payments', 'stripe_objects', 'stripe_events', 'ledger_entries', 'ledger_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END
$$;

-- Reads: a seller sees the rows that carry their id, an operator and the system see everything the grants below allow.
GRANT SELECT ON sellers, orders, payments, stripe_objects, ledger_entries, ledger_lines TO mkt_seller, mkt_operator, mkt_system;
GRANT SELECT ON stripe_events TO mkt_operator, mkt_system;

CREATE POLICY sellers_self     ON sellers        FOR SELECT TO mkt_seller   USING (id = app_seller_id());
CREATE POLICY orders_self      ON orders         FOR SELECT TO mkt_seller   USING (seller_id = app_seller_id());
CREATE POLICY payments_self    ON payments       FOR SELECT TO mkt_seller   USING (seller_id = app_seller_id());
CREATE POLICY objects_self     ON stripe_objects FOR SELECT TO mkt_seller   USING (seller_id = app_seller_id());
CREATE POLICY entries_self     ON ledger_entries FOR SELECT TO mkt_seller   USING (seller_id = app_seller_id());
CREATE POLICY lines_self       ON ledger_lines   FOR SELECT TO mkt_seller   USING (seller_id = app_seller_id());

CREATE POLICY sellers_operator  ON sellers        FOR SELECT TO mkt_operator USING (true);
CREATE POLICY orders_operator   ON orders         FOR SELECT TO mkt_operator USING (true);
CREATE POLICY payments_operator ON payments       FOR SELECT TO mkt_operator USING (true);
CREATE POLICY objects_operator  ON stripe_objects FOR SELECT TO mkt_operator USING (true);
CREATE POLICY events_operator   ON stripe_events  FOR SELECT TO mkt_operator USING (true);
CREATE POLICY entries_operator  ON ledger_entries FOR SELECT TO mkt_operator USING (true);
CREATE POLICY lines_operator    ON ledger_lines   FOR SELECT TO mkt_operator USING (true);

-- Writes: only the system, and only what the flows need. Identity columns (ids, the seller, amounts, currencies) cannot be updated
-- by any application role; the ledger tables get INSERT and nothing else.
GRANT INSERT ON sellers, orders, payments, stripe_objects, stripe_events, ledger_entries, ledger_lines TO mkt_system;
GRANT UPDATE (state, account_snapshot, observed_at) ON sellers TO mkt_system;
GRANT UPDATE (status, session_id, charge_id) ON orders TO mkt_system;
GRANT UPDATE (refunded, reversed, reversed_fee) ON payments TO mkt_system;
GRANT UPDATE (status, rank, fee_part, secondary_amount) ON stripe_objects TO mkt_system;
GRANT UPDATE (status, reason, payload) ON stripe_events TO mkt_system;

CREATE POLICY sellers_system  ON sellers        FOR ALL TO mkt_system USING (true) WITH CHECK (true);
CREATE POLICY orders_system   ON orders         FOR ALL TO mkt_system USING (true) WITH CHECK (true);
CREATE POLICY payments_system ON payments       FOR ALL TO mkt_system USING (true) WITH CHECK (true);
CREATE POLICY objects_system  ON stripe_objects FOR ALL TO mkt_system USING (true) WITH CHECK (true);
CREATE POLICY events_system   ON stripe_events  FOR ALL TO mkt_system USING (true) WITH CHECK (true);
CREATE POLICY entries_system  ON ledger_entries FOR ALL TO mkt_system USING (true) WITH CHECK (true);
CREATE POLICY lines_system    ON ledger_lines   FOR ALL TO mkt_system USING (true) WITH CHECK (true);
