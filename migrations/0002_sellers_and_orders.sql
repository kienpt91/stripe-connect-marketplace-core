-- Sellers (the tenants) and their orders.
--
-- Times are milliseconds since the epoch in bigint columns, so that what the application wrote is what it reads back. Amounts are
-- bigint minor units; no column in this schema can hold a fraction of a cent.
CREATE TABLE sellers (
  id               uuid PRIMARY KEY,
  display_name     text   NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  stripe_account_id text  NOT NULL UNIQUE CHECK (stripe_account_id ~ '^acct_[A-Za-z0-9]{8,64}$'),
  state            text   NOT NULL CHECK (state IN ('new', 'requirements_due', 'pending_review', 'enabled', 'restricted', 'rejected')),
  -- the parts of the Stripe account the state machine reads, as last observed
  account_snapshot jsonb,
  observed_at      bigint NOT NULL DEFAULT 0 CHECK (observed_at >= 0),
  created_at       bigint NOT NULL CHECK (created_at >= 0)
);

-- The state machine has a second lock in the database: a rejected seller stays rejected and nothing goes back to `new`, whoever
-- writes (the trigger applies to the table owner and to superusers too, unless somebody disables it on purpose).
CREATE FUNCTION sellers_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'rejected' AND NEW.state <> 'rejected' THEN
    RAISE EXCEPTION 'a rejected seller cannot change state' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state = 'new' AND OLD.state <> 'new' THEN
    RAISE EXCEPTION 'a seller cannot go back to new' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sellers_state_guard BEFORE UPDATE ON sellers FOR EACH ROW EXECUTE FUNCTION sellers_state_guard();

CREATE TABLE orders (
  id              uuid PRIMARY KEY,
  seller_id       uuid   NOT NULL REFERENCES sellers (id),
  buyer_ref       text   NOT NULL CHECK (buyer_ref ~ '^[A-Za-z0-9_.:@-]{1,100}$'),
  amount          bigint NOT NULL CHECK (amount > 0 AND amount <= 99999999),
  currency        text   NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  -- the platform's fee: always less than the amount, so the seller is owed at least one minor unit
  fee             bigint NOT NULL CHECK (fee >= 0 AND fee < amount),
  description     text   NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  status          text   NOT NULL CHECK (status IN ('awaiting_payment', 'paid', 'partially_refunded', 'refunded')),
  idempotency_key text   NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  session_id      text   CHECK (session_id IS NULL OR session_id ~ '^cs_(test_|live_)?[A-Za-z0-9]{8,64}$'),
  charge_id       text   CHECK (charge_id IS NULL OR charge_id ~ '^ch_[A-Za-z0-9]{8,64}$'),
  created_at      bigint NOT NULL CHECK (created_at >= 0),
  -- one order per key and seller: the database is what makes a retried purchase the same purchase
  UNIQUE (seller_id, idempotency_key),
  UNIQUE (id, seller_id)
);
CREATE INDEX orders_seller_idx ON orders (seller_id, created_at DESC);
