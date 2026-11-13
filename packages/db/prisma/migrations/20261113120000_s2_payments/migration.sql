-- S2: checkout sessions, payments (transactions), events, idempotency, rate limiting.
-- Additive only. Touches no existing S1 object except one nullable column on api_credentials.
-- Every user-owned table has a direct FK to auth.users(id) ON DELETE CASCADE. RLS is enabled with no policies and the
-- Supabase Data API roles hold no privileges (same pattern as S1).

-- Credential expiry (NULL = never expires).
ALTER TABLE "api_credentials" ADD COLUMN "expires_at" TIMESTAMPTZ(6);

-- ---------------------------------------------------------------- checkout_sessions
CREATE TABLE "checkout_sessions" (
    "id" UUID NOT NULL,
    "seq" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "external_reference" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "preset_scenario" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "checkout_sessions_amount_check" CHECK ("amount_minor" BETWEEN 1 AND 1000000000000),
    CONSTRAINT "checkout_sessions_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "checkout_sessions_status_check" CHECK ("status" IN ('open','completed','expired','cancelled')),
    CONSTRAINT "checkout_sessions_scenario_check" CHECK ("preset_scenario" IS NULL OR "preset_scenario" IN ('success','decline','pending','pending_then_success','pending_then_failure','cancel','timeout')),
    CONSTRAINT "checkout_sessions_reference_check" CHECK ("external_reference" IS NULL OR char_length("external_reference") BETWEEN 1 AND 255),
    CONSTRAINT "checkout_sessions_metadata_check" CHECK (jsonb_typeof("metadata") = 'object' AND pg_column_size("metadata") <= 8192),
    CONSTRAINT "checkout_sessions_expiry_check" CHECK ("expires_at" > "created_at")
);
CREATE UNIQUE INDEX "checkout_sessions_seq_key" ON "checkout_sessions"("seq");
CREATE UNIQUE INDEX "checkout_sessions_token_hash_key" ON "checkout_sessions"("token_hash");
CREATE UNIQUE INDEX "checkout_sessions_id_user_id_key" ON "checkout_sessions"("id", "user_id");
CREATE UNIQUE INDEX "checkout_sessions_id_user_id_amount_minor_currency_key" ON "checkout_sessions"("id", "user_id", "amount_minor", "currency");
-- API access patterns: list newest first, filtered by status or external reference; per-user expiry sweep; global expiry sweep (S4 worker).
CREATE INDEX "checkout_sessions_user_seq_idx" ON "checkout_sessions"("user_id", "seq" DESC);
CREATE INDEX "checkout_sessions_user_status_seq_idx" ON "checkout_sessions"("user_id", "status", "seq" DESC);
CREATE INDEX "checkout_sessions_user_reference_seq_idx" ON "checkout_sessions"("user_id", "external_reference", "seq" DESC) WHERE "external_reference" IS NOT NULL;
CREATE INDEX "checkout_sessions_open_user_expiry_idx" ON "checkout_sessions"("user_id", "expires_at") WHERE "status" = 'open';
CREATE INDEX "checkout_sessions_open_expiry_idx" ON "checkout_sessions"("expires_at") WHERE "status" = 'open';

-- ---------------------------------------------------------------- transactions
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "seq" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    "user_id" UUID NOT NULL,
    "checkout_session_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "resolve_at" TIMESTAMPTZ(6),
    "resolve_to" TEXT,
    "failure_code" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transactions_status_check" CHECK ("status" IN ('pending','succeeded','failed','cancelled')),
    CONSTRAINT "transactions_scenario_check" CHECK ("scenario" IN ('success','decline','pending','pending_then_success','pending_then_failure','cancel','timeout')),
    CONSTRAINT "transactions_resolve_to_check" CHECK ("resolve_to" IS NULL OR "resolve_to" IN ('succeeded','failed')),
    CONSTRAINT "transactions_resolve_pair_check" CHECK (("resolve_at" IS NULL) = ("resolve_to" IS NULL)),
    CONSTRAINT "transactions_terminal_check" CHECK (("status" = 'pending') = ("resolved_at" IS NULL))
);
CREATE UNIQUE INDEX "transactions_seq_key" ON "transactions"("seq");
-- At most one pending or succeeded payment per session: the database is the final guard against double payment.
CREATE UNIQUE INDEX "transactions_one_active_per_session" ON "transactions"("checkout_session_id") WHERE "status" IN ('pending','succeeded');
CREATE INDEX "transactions_user_seq_idx" ON "transactions"("user_id", "seq" DESC);
CREATE INDEX "transactions_user_status_seq_idx" ON "transactions"("user_id", "status", "seq" DESC);
CREATE INDEX "transactions_session_seq_idx" ON "transactions"("checkout_session_id", "seq" DESC);
CREATE INDEX "transactions_pending_due_idx" ON "transactions"("resolve_at") WHERE "status" = 'pending' AND "resolve_at" IS NOT NULL;
CREATE INDEX "transactions_user_pending_due_idx" ON "transactions"("user_id", "resolve_at") WHERE "status" = 'pending' AND "resolve_at" IS NOT NULL;

-- ---------------------------------------------------------------- events
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "seq" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "payload" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "events_type_check" CHECK ("type" IN ('checkout.session.completed','checkout.session.expired','checkout.session.cancelled','payment.pending','payment.succeeded','payment.failed','payment.cancelled'))
);
CREATE UNIQUE INDEX "events_seq_key" ON "events"("seq");
-- One event per (owner, subject, type): a transition can never emit its event twice.
CREATE UNIQUE INDEX "events_user_id_subject_id_type_key" ON "events"("user_id", "subject_id", "type");
CREATE INDEX "events_user_seq_idx" ON "events"("user_id", "seq" DESC);
CREATE INDEX "events_user_type_seq_idx" ON "events"("user_id", "type", "seq" DESC);

-- ---------------------------------------------------------------- idempotency_keys
CREATE TABLE "idempotency_keys" (
    "user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "token_enc" TEXT NOT NULL,
    "session_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("user_id", "key"),
    CONSTRAINT "idempotency_keys_key_check" CHECK (char_length("key") BETWEEN 1 AND 255)
);
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- ---------------------------------------------------------------- rate limiting
CREATE TABLE "api_rate_limits" (
    "user_id" UUID NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "api_rate_limits_pkey" PRIMARY KEY ("user_id", "window_start")
);
CREATE INDEX "api_rate_limits_window_start_idx" ON "api_rate_limits"("window_start");

-- Not user-owned (pre-authentication abuse counters; buckets are hashes). Explicit, documented exception to the user_id rule.
CREATE TABLE "auth_failure_windows" (
    "scope" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "auth_failure_windows_pkey" PRIMARY KEY ("scope", "bucket", "window_start"),
    CONSTRAINT "auth_failure_windows_scope_check" CHECK ("scope" IN ('ip','client_id','global'))
);
CREATE INDEX "auth_failure_windows_window_start_idx" ON "auth_failure_windows"("window_start");

-- ---------------------------------------------------------------- foreign keys (all owner FKs cascade from Auth)
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES auth.users("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES auth.users("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES auth.users("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES auth.users("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "api_rate_limits" ADD CONSTRAINT "api_rate_limits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES auth.users("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite ownership + amount/currency consistency, enforced by the database: a payment can only reference a session of the
-- same owner with exactly the same amount and currency.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_session_fkey"
  FOREIGN KEY ("checkout_session_id", "user_id", "amount_minor", "currency")
  REFERENCES "checkout_sessions"("id", "user_id", "amount_minor", "currency") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_session_fkey"
  FOREIGN KEY ("session_id", "user_id") REFERENCES "checkout_sessions"("id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED; -- the key row is claimed first, then the session is inserted in the same transaction

-- ---------------------------------------------------------------- RLS and Data API privileges
ALTER TABLE "checkout_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_rate_limits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_failure_windows" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
DECLARE s text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    FOREACH t IN ARRAY ARRAY['checkout_sessions','transactions','events','idempotency_keys','api_rate_limits','auth_failure_windows'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated, service_role', t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['checkout_sessions','transactions','events'] LOOP
      s := pg_get_serial_sequence('public.' || t, 'seq');
      IF s IS NOT NULL THEN EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM anon, authenticated, service_role', s); END IF;
    END LOOP;
  END IF;
END $$;

-- ---------------------------------------------------------------- integrity triggers
-- Checkout session: amount, currency, token hash, owner and id never change; only open -> terminal, terminal is immutable.
CREATE OR REPLACE FUNCTION sandbox_checkout_sessions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.preset_scenario IS DISTINCT FROM OLD.preset_scenario OR NEW.seq IS DISTINCT FROM OLD.seq THEN
    RAISE EXCEPTION 'checkout_sessions: immutable column changed';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'checkout_sessions: % is a terminal status and cannot change', OLD.status;
  END IF;
  IF NEW.status = 'open' THEN
    RAISE EXCEPTION 'checkout_sessions: invalid transition open -> open';
  END IF;
  RETURN NEW;
END;
$$;

-- Transaction: owner, session, amount, currency and scenario never change; only pending -> terminal; terminal is immutable.
CREATE OR REPLACE FUNCTION sandbox_transactions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.scenario IS DISTINCT FROM OLD.scenario OR NEW.seq IS DISTINCT FROM OLD.seq THEN
    RAISE EXCEPTION 'transactions: immutable column changed';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'transactions: % is a terminal status and cannot change', OLD.status;
  END IF;
  IF NEW.status = 'pending' THEN
    RAISE EXCEPTION 'transactions: invalid transition pending -> pending';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'transactions: version must increase by exactly 1';
  END IF;
  RETURN NEW;
END;
$$;

-- Events: UPDATE and TRUNCATE are rejected. DELETE is deliberately allowed so deleting an Auth user can cascade
-- (and so a later retention purge is possible under its own controls).
CREATE OR REPLACE FUNCTION sandbox_events_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'events is immutable (% is not allowed)', TG_OP;
END;
$$;

REVOKE ALL ON FUNCTION sandbox_checkout_sessions_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_transactions_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_events_guard() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION sandbox_checkout_sessions_guard() FROM anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION sandbox_transactions_guard() FROM anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION sandbox_events_guard() FROM anon, authenticated, service_role;
  END IF;
END $$;

CREATE TRIGGER checkout_sessions_guard BEFORE UPDATE ON "checkout_sessions" FOR EACH ROW EXECUTE FUNCTION sandbox_checkout_sessions_guard();
CREATE TRIGGER transactions_guard BEFORE UPDATE ON "transactions" FOR EACH ROW EXECUTE FUNCTION sandbox_transactions_guard();
CREATE TRIGGER events_guard_row BEFORE UPDATE ON "events" FOR EACH ROW EXECUTE FUNCTION sandbox_events_guard();
CREATE TRIGGER events_guard_truncate BEFORE TRUNCATE ON "events" FOR EACH STATEMENT EXECUTE FUNCTION sandbox_events_guard();
