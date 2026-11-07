-- What Stripe told us: the charge behind each paid order, the refunds, disputes, payouts and transfers around it, and the events.

-- One row per successful charge of the marketplace. The counters are what has been taken back from the sale so far; the ledger
-- entries are the record, these are what the next refund is allocated against, under the row lock of the charge.
CREATE TABLE payments (
  charge_id    text   PRIMARY KEY CHECK (charge_id ~ '^ch_[A-Za-z0-9]{8,64}$'),
  order_id     uuid   NOT NULL,
  seller_id    uuid   NOT NULL REFERENCES sellers (id),
  account_id   text   NOT NULL,
  currency     text   NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  amount       bigint NOT NULL CHECK (amount > 0),
  fee          bigint NOT NULL CHECK (fee >= 0 AND fee < amount),
  refunded     bigint NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  reversed     bigint NOT NULL DEFAULT 0 CHECK (reversed >= refunded AND reversed <= amount),
  reversed_fee bigint NOT NULL DEFAULT 0 CHECK (reversed_fee >= 0 AND reversed_fee <= fee AND reversed_fee <= reversed),
  anomaly      text   CHECK (anomaly IS NULL OR char_length(anomaly) <= 400),
  created_at   bigint NOT NULL CHECK (created_at >= 0),
  -- the order and the seller must agree: a payment cannot name another seller's order
  FOREIGN KEY (order_id, seller_id) REFERENCES orders (id, seller_id)
);
CREATE INDEX payments_seller_idx ON payments (seller_id, created_at);

-- A refund, a dispute, a payout or a transfer as last seen. The status only ever moves up in rank (trigger below).
CREATE TABLE stripe_objects (
  kind             text   NOT NULL CHECK (kind IN ('refund', 'dispute', 'payout', 'transfer')),
  id               text   NOT NULL CHECK (id ~ '^[a-z]{2,4}_[A-Za-z0-9]{8,64}$'),
  seller_id        uuid   NOT NULL REFERENCES sellers (id),
  account_id       text   NOT NULL,
  charge_id        text   REFERENCES payments (charge_id),
  currency         text   NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  amount           bigint NOT NULL CHECK (amount > 0),
  fee_part         bigint NOT NULL DEFAULT 0 CHECK (fee_part >= 0 AND fee_part <= amount),
  secondary_amount bigint NOT NULL DEFAULT 0 CHECK (secondary_amount >= 0),
  status           text   NOT NULL CHECK (char_length(status) <= 40),
  rank             smallint NOT NULL CHECK (rank BETWEEN 0 AND 4),
  created_at       bigint NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (kind, id),
  -- refunds, disputes and transfers belong to a charge; only a payout does not
  CHECK ((kind = 'payout') = (charge_id IS NULL))
);
CREATE INDEX stripe_objects_seller_idx ON stripe_objects (seller_id, kind);

CREATE FUNCTION stripe_objects_rank_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rank < OLD.rank THEN
    RAISE EXCEPTION 'the status of a % cannot move down in rank', OLD.kind USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stripe_objects_rank_guard BEFORE UPDATE ON stripe_objects FOR EACH ROW EXECUTE FUNCTION stripe_objects_rank_guard();

-- The event log: one row per Stripe event id, which is what makes a delivery idempotent. The payload is kept only while somebody
-- needs it: a deferred event is applied from it later, a rejected one is looked at by a person. Applied events keep no payload
-- (the CHECK below), so the table does not grow into a copy of Stripe's data.
CREATE TABLE stripe_events (
  id          text   PRIMARY KEY CHECK (id ~ '^evt_[A-Za-z0-9]{8,64}$'),
  type        text   NOT NULL CHECK (char_length(type) <= 100),
  account     text,
  subject     text   NOT NULL CHECK (char_length(subject) <= 120),
  received_at bigint NOT NULL CHECK (received_at >= 0),
  status      text   NOT NULL CHECK (status IN ('applied', 'stale', 'deferred', 'rejected', 'ignored')),
  reason      text   CHECK (reason IS NULL OR char_length(reason) <= 300),
  payload     jsonb,
  CHECK (payload IS NULL OR status IN ('deferred', 'rejected'))
);
CREATE INDEX stripe_events_deferred_idx ON stripe_events (subject, received_at) WHERE status = 'deferred';
CREATE INDEX stripe_events_flagged_idx ON stripe_events (received_at) WHERE status IN ('deferred', 'rejected');
