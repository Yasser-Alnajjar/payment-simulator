-- Payment methods (test cards), setup sessions, saved-card charges. Additive: new tables, new nullable columns, and three widenings
-- of existing S2 objects (documented in docs/payment-methods.md): events.type check (new types), events uniqueness (adds `occurrence`),
-- transactions.checkout_session_id (nullable, so a saved-card charge needs no checkout session). No existing row is changed.
-- Never stores a full card number or a security code: only brand, last four, expiry, a keyed fingerprint and the test behavior.

-- ---------------------------------------------------------------- payment_methods
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL,
    "seq" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    "user_id" UUID NOT NULL,
    "customer_reference" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'card',
    "brand" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "exp_month" SMALLINT NOT NULL,
    "exp_year" SMALLINT NOT NULL,
    "cardholder_name" TEXT,
    "fingerprint" TEXT NOT NULL,
    "test_behavior" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_methods_type_check" CHECK ("type" = 'card'),
    CONSTRAINT "payment_methods_brand_check" CHECK ("brand" IN ('visa','mastercard','meeza','amex','discover')),
    CONSTRAINT "payment_methods_last4_check" CHECK ("last4" ~ '^[0-9]{4}$'),
    CONSTRAINT "payment_methods_exp_check" CHECK ("exp_month" BETWEEN 1 AND 12 AND "exp_year" BETWEEN 2000 AND 2200),
    CONSTRAINT "payment_methods_status_check" CHECK ("status" IN ('active','expired','disabled')),
    CONSTRAINT "payment_methods_behavior_check" CHECK ("test_behavior" IN ('succeed','decline','insufficient_funds','authentication_required','processor_error')),
    CONSTRAINT "payment_methods_customer_check" CHECK ("customer_reference" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
    CONSTRAINT "payment_methods_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "payment_methods_name_check" CHECK ("cardholder_name" IS NULL OR char_length("cardholder_name") BETWEEN 1 AND 100),
    -- A default is always an active, undeleted method (expiry by the clock is enforced by the service).
    CONSTRAINT "payment_methods_default_check" CHECK (NOT "is_default" OR ("status" = 'active' AND "deleted_at" IS NULL))
);
CREATE UNIQUE INDEX "payment_methods_seq_key" ON "payment_methods"("seq");
CREATE UNIQUE INDEX "payment_methods_id_user_id_key" ON "payment_methods"("id", "user_id");
-- At most one default per owner and customer: the database is the final guard for concurrent default updates.
CREATE UNIQUE INDEX "payment_methods_one_default_per_customer" ON "payment_methods"("user_id", "customer_reference") WHERE "is_default" AND "deleted_at" IS NULL;
-- Duplicate-card detection: the same card (keyed fingerprint) cannot be saved twice for one customer while it is not deleted.
CREATE UNIQUE INDEX "payment_methods_no_duplicate_card" ON "payment_methods"("user_id", "customer_reference", "fingerprint") WHERE "deleted_at" IS NULL;
CREATE INDEX "payment_methods_user_seq_idx" ON "payment_methods"("user_id", "seq" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "payment_methods_user_customer_seq_idx" ON "payment_methods"("user_id", "customer_reference", "seq" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "payment_methods_user_status_seq_idx" ON "payment_methods"("user_id", "status", "seq" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "payment_methods_user_created_idx" ON "payment_methods"("user_id", "created_at" DESC);
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES auth.users("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- setup_sessions (hosted checkout, mode = setup: no amount, no payment)
CREATE TABLE "setup_sessions" (
    "id" UUID NOT NULL,
    "seq" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "customer_reference" TEXT NOT NULL,
    "external_reference" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'open',
    "payment_method_id" UUID,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_failure_code" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setup_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "setup_sessions_status_check" CHECK ("status" IN ('open','completed','expired','cancelled')),
    CONSTRAINT "setup_sessions_customer_check" CHECK ("customer_reference" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
    CONSTRAINT "setup_sessions_reference_check" CHECK ("external_reference" IS NULL OR char_length("external_reference") BETWEEN 1 AND 255),
    CONSTRAINT "setup_sessions_metadata_check" CHECK (jsonb_typeof("metadata") = 'object' AND pg_column_size("metadata") <= 8192),
    CONSTRAINT "setup_sessions_expiry_check" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "setup_sessions_attempts_check" CHECK ("attempt_count" >= 0),
    -- Only a completed setup can reference a method (it may later be cleared to NULL if the method row is ever removed).
    CONSTRAINT "setup_sessions_method_check" CHECK ("payment_method_id" IS NULL OR "status" = 'completed')
);
CREATE UNIQUE INDEX "setup_sessions_seq_key" ON "setup_sessions"("seq");
CREATE UNIQUE INDEX "setup_sessions_token_hash_key" ON "setup_sessions"("token_hash");
CREATE UNIQUE INDEX "setup_sessions_id_user_id_key" ON "setup_sessions"("id", "user_id");
CREATE INDEX "setup_sessions_user_seq_idx" ON "setup_sessions"("user_id", "seq" DESC);
CREATE INDEX "setup_sessions_user_customer_idx" ON "setup_sessions"("user_id", "customer_reference", "seq" DESC);
CREATE INDEX "setup_sessions_open_expiry_idx" ON "setup_sessions"("expires_at") WHERE "status" = 'open';
ALTER TABLE "setup_sessions" ADD CONSTRAINT "setup_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES auth.users("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Composite FK keeps the method inside the owner's scope. A method is soft-deleted, so the reference normally stays.
ALTER TABLE "setup_sessions" ADD CONSTRAINT "setup_sessions_method_fkey" FOREIGN KEY ("payment_method_id", "user_id") REFERENCES "payment_methods"("id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED; -- deferred: deleting an Auth user cascades to every child table in any order

-- ---------------------------------------------------------------- api_idempotency_keys (create-payment-method, create-setup-session, create-charge)
CREATE TABLE "api_idempotency_keys" (
    "user_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "token_enc" TEXT,
    "resource_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_idempotency_keys_pkey" PRIMARY KEY ("user_id", "scope", "key"),
    CONSTRAINT "api_idempotency_keys_scope_check" CHECK ("scope" IN ('payment_method.create','setup_session.create','charge.create')),
    CONSTRAINT "api_idempotency_keys_key_check" CHECK (char_length("key") BETWEEN 1 AND 255)
);
CREATE INDEX "api_idempotency_keys_created_at_idx" ON "api_idempotency_keys"("created_at");
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES auth.users("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- transactions: saved-card charges and card payments
-- Widening: a payment may now be a saved-card charge without a checkout session (checkout_session_id NULL). The composite FK to
-- checkout_sessions is MATCH SIMPLE, so it is not evaluated when the session column is NULL; every existing row is unaffected.
ALTER TABLE "transactions" ALTER COLUMN "checkout_session_id" DROP NOT NULL;
ALTER TABLE "transactions" ADD COLUMN "payment_method_id" UUID;
ALTER TABLE "transactions" ADD COLUMN "customer_reference" TEXT;
ALTER TABLE "transactions" ADD COLUMN "external_reference" TEXT;
ALTER TABLE "transactions" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "transactions" ADD COLUMN "card_brand" TEXT;
ALTER TABLE "transactions" ADD COLUMN "card_last4" TEXT;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_origin_check" CHECK ("checkout_session_id" IS NOT NULL OR "payment_method_id" IS NOT NULL);
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_card_check" CHECK (("card_brand" IS NULL) = ("card_last4" IS NULL) AND ("card_last4" IS NULL OR "card_last4" ~ '^[0-9]{4}$'));
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_charge_ref_check" CHECK ("external_reference" IS NULL OR char_length("external_reference") BETWEEN 1 AND 255);
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_metadata_check" CHECK (jsonb_typeof("metadata") = 'object' AND pg_column_size("metadata") <= 8192);
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_method_fkey" FOREIGN KEY ("payment_method_id", "user_id") REFERENCES "payment_methods"("id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "transactions_method_seq_idx" ON "transactions"("user_id", "payment_method_id", "seq" DESC) WHERE "payment_method_id" IS NOT NULL;
CREATE INDEX "transactions_customer_seq_idx" ON "transactions"("user_id", "customer_reference", "seq" DESC) WHERE "customer_reference" IS NOT NULL;

-- ---------------------------------------------------------------- events: new types, repeatable per occurrence
ALTER TABLE "events" ADD COLUMN "occurrence" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "events_user_subject_type_occurrence_key" ON "events"("user_id", "subject_id", "type", "occurrence");
DROP INDEX "events_user_id_subject_id_type_key";
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK ("type" IN (
  'checkout.session.completed','checkout.session.expired','checkout.session.cancelled','payment.pending','payment.succeeded','payment.failed','payment.cancelled',
  'payment_method.created','payment_method.updated','payment_method.default_updated','payment_method.disabled','payment_method.deleted'));

-- ---------------------------------------------------------------- checkout_sessions: optional customer (lets the hosted page offer that customer's saved test cards)
ALTER TABLE "checkout_sessions" ADD COLUMN "customer_reference" TEXT;
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_customer_check" CHECK ("customer_reference" IS NULL OR "customer_reference" ~ '^[A-Za-z0-9_.:@-]{1,128}$');

-- ---------------------------------------------------------------- RLS and Data API privileges (same pattern as S1/S2)
ALTER TABLE "payment_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "setup_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_idempotency_keys" ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
DECLARE s text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    FOREACH t IN ARRAY ARRAY['payment_methods','setup_sessions','api_idempotency_keys'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated, service_role', t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['payment_methods','setup_sessions'] LOOP
      s := pg_get_serial_sequence('public.' || t, 'seq');
      IF s IS NOT NULL THEN EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM anon, authenticated, service_role', s); END IF;
    END LOOP;
  END IF;
END $$;

-- ---------------------------------------------------------------- integrity triggers
-- Payment method: identity and card facts never change; a deleted method is final; version rises by exactly 1 per change.
CREATE OR REPLACE FUNCTION sandbox_payment_methods_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.customer_reference IS DISTINCT FROM OLD.customer_reference
     OR NEW.type IS DISTINCT FROM OLD.type OR NEW.brand IS DISTINCT FROM OLD.brand OR NEW.last4 IS DISTINCT FROM OLD.last4
     OR NEW.exp_month IS DISTINCT FROM OLD.exp_month OR NEW.exp_year IS DISTINCT FROM OLD.exp_year OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
     OR NEW.test_behavior IS DISTINCT FROM OLD.test_behavior OR NEW.cardholder_name IS DISTINCT FROM OLD.cardholder_name
     OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment_methods: immutable column changed';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'payment_methods: a deleted method cannot change';
  END IF;
  IF OLD.status = 'disabled' AND NEW.status <> 'disabled' THEN
    RAISE EXCEPTION 'payment_methods: a disabled method cannot be re-enabled';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'payment_methods: version must increase by exactly 1';
  END IF;
  RETURN NEW;
END;
$$;

-- Setup session: owner, token, customer, expiry never change; open -> terminal only; terminal is final. Attempt counters may change while open.
CREATE OR REPLACE FUNCTION sandbox_setup_sessions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.customer_reference IS DISTINCT FROM OLD.customer_reference OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'setup_sessions: immutable column changed';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'setup_sessions: % is a terminal status and cannot change', OLD.status;
  END IF;
  RETURN NEW;
END;
$$;

-- Transactions guard, extended: the saved-card columns are immutable too (same rules as before for every existing column).
CREATE OR REPLACE FUNCTION sandbox_transactions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.scenario IS DISTINCT FROM OLD.scenario OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.payment_method_id IS DISTINCT FROM OLD.payment_method_id OR NEW.customer_reference IS DISTINCT FROM OLD.customer_reference
     OR NEW.external_reference IS DISTINCT FROM OLD.external_reference OR NEW.metadata IS DISTINCT FROM OLD.metadata
     OR NEW.card_brand IS DISTINCT FROM OLD.card_brand OR NEW.card_last4 IS DISTINCT FROM OLD.card_last4 THEN
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

-- Checkout session guard, extended with the new immutable column (every existing rule unchanged).
CREATE OR REPLACE FUNCTION sandbox_checkout_sessions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.preset_scenario IS DISTINCT FROM OLD.preset_scenario OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.customer_reference IS DISTINCT FROM OLD.customer_reference THEN
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

REVOKE ALL ON FUNCTION sandbox_payment_methods_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_setup_sessions_guard() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION sandbox_payment_methods_guard() FROM anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION sandbox_setup_sessions_guard() FROM anon, authenticated, service_role;
  END IF;
END $$;

CREATE TRIGGER payment_methods_guard BEFORE UPDATE ON "payment_methods" FOR EACH ROW EXECUTE FUNCTION sandbox_payment_methods_guard();
CREATE TRIGGER setup_sessions_guard BEFORE UPDATE ON "setup_sessions" FOR EACH ROW EXECUTE FUNCTION sandbox_setup_sessions_guard();
