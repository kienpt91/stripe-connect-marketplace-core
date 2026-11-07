-- The ledger: append-only, double entry.
--
-- An entry is one business fact (a sale, a refund, a payout ...) keyed by its posting key, which names the fact: posting the same
-- fact twice is a no-op, so a duplicate or a replayed event can never book money twice. An entry's lines balance: debits equal
-- credits. Three guarantees live in the database, not in the application:
--   1. no UPDATE, DELETE or TRUNCATE on either table, for anyone (triggers; no privilege is granted either);
--   2. an entry declares how many lines it has and what they add up to, and a deferred trigger checks it at COMMIT: an unbalanced
--      entry, a missing line, or a line added to an entry later, fails the transaction;
--   3. a line of a seller's account carries the seller's id, so that row level security can show a seller exactly their own lines.
-- A superuser or the schema owner can still disable a trigger: that is what an audit of the cluster's roles is for (SECURITY.md).
CREATE TABLE ledger_entries (
  seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id          uuid   NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  posting_key text   NOT NULL UNIQUE CHECK (posting_key ~ '^[a-z_]+:[A-Za-z0-9_]+(:[a-z_]+)?$'),
  kind        text   NOT NULL CHECK (kind IN ('sale', 'refund', 'refund_reversal', 'dispute_opened', 'dispute_won', 'dispute_lost', 'payout', 'payout_reversal')),
  seller_id   uuid   NOT NULL REFERENCES sellers (id),
  currency    text   NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  subject     text   NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 120),
  -- when it happened according to Stripe (the object's created time), in ms
  occurred_at bigint NOT NULL CHECK (occurred_at >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  event_id    text,
  line_count  integer NOT NULL CHECK (line_count >= 2),
  total_minor bigint NOT NULL CHECK (total_minor > 0),
  UNIQUE (seq, seller_id),
  UNIQUE (seq, currency)
);

CREATE TABLE ledger_lines (
  entry_seq bigint   NOT NULL REFERENCES ledger_entries (seq),
  line_no   smallint NOT NULL CHECK (line_no >= 1),
  account   text     NOT NULL CHECK (account IN ('stripe_funds', 'seller_balance', 'platform_fees', 'disputed_funds')),
  side      text     NOT NULL CHECK (side IN ('debit', 'credit')),
  amount    bigint   NOT NULL CHECK (amount > 0),
  currency  text     NOT NULL,
  seller_id uuid,
  PRIMARY KEY (entry_seq, line_no),
  -- a seller's own account has the seller's id, the platform's accounts have none
  CHECK ((account = 'seller_balance') = (seller_id IS NOT NULL)),
  -- the line's currency and seller are the entry's (a NULL seller id is not compared)
  FOREIGN KEY (entry_seq, currency) REFERENCES ledger_entries (seq, currency),
  FOREIGN KEY (entry_seq, seller_id) REFERENCES ledger_entries (seq, seller_id)
);
CREATE INDEX ledger_lines_seller_idx ON ledger_lines (seller_id, entry_seq) WHERE seller_id IS NOT NULL;

CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the ledger is append-only (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_lines_append_only BEFORE UPDATE OR DELETE ON ledger_lines FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_lines_no_truncate BEFORE TRUNCATE ON ledger_lines FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();

CREATE FUNCTION ledger_check_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target bigint;
  declared ledger_entries;
  n integer;
  debits bigint;
  credits bigint;
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN target := NEW.seq; ELSE target := NEW.entry_seq; END IF;
  SELECT * INTO declared FROM ledger_entries WHERE seq = target;
  SELECT count(*), coalesce(sum(amount) FILTER (WHERE side = 'debit'), 0), coalesce(sum(amount) FILTER (WHERE side = 'credit'), 0)
    INTO n, debits, credits FROM ledger_lines WHERE entry_seq = target;
  IF n <> declared.line_count OR debits <> declared.total_minor OR credits <> declared.total_minor THEN
    RAISE EXCEPTION 'ledger entry % does not balance: % lines for the % declared, debits %, credits %, total %',
      declared.posting_key, n, declared.line_count, debits, credits, declared.total_minor USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry();
CREATE CONSTRAINT TRIGGER ledger_lines_balanced AFTER INSERT ON ledger_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry();
