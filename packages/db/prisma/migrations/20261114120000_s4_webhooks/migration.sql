-- S4: webhook endpoints, deliveries, delivery attempts, scheduler lease.
-- Additive. Changes to existing objects: one new unique index on events(id, user_id) (tenant-safe composite FKs), the events type
-- check widened by one value (webhook_endpoint.test), and the api_idempotency_keys scope check widened by one value. No existing row
-- is changed. No DROP of any table, no TRUNCATE, no DELETE.
-- Requires 20261113200000_payment_methods (events.occurrence and the constraint names it created).

-- ---------------------------------------------------------------- existing tables
CREATE UNIQUE INDEX "events_id_user_id_key" ON "events"("id", "user_id");

ALTER TABLE "events" DROP CONSTRAINT "events_type_check";
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK ("type" IN (
  'checkout.session.completed','checkout.session.expired','checkout.session.cancelled','payment.pending','payment.succeeded','payment.failed','payment.cancelled',
  'payment_method.created','payment_method.updated','payment_method.default_updated','payment_method.disabled','payment_method.deleted',
  'webhook_endpoint.test')) NOT VALID;
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";

ALTER TABLE "api_idempotency_keys" DROP CONSTRAINT "api_idempotency_keys_scope_check";
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_scope_check" CHECK ("scope" IN ('payment_method.create','setup_session.create','charge.create','webhook_endpoint.create')) NOT VALID;
ALTER TABLE "api_idempotency_keys" VALIDATE CONSTRAINT "api_idempotency_keys_scope_check";

-- ---------------------------------------------------------------- webhook_endpoints
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "seq" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    "user_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "enabled_events" TEXT[] NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'enabled',
    -- sealBound(secret, purpose "webhook-endpoint-secret", context "user|endpoint"); never stored in plaintext
    "secret_sealed" TEXT NOT NULL,
    "previous_secret_sealed" TEXT,
    "previous_secret_expires_at" TIMESTAMPTZ(6),
    "max_attempts" SMALLINT NOT NULL DEFAULT 8,
    "failure_mode" TEXT NOT NULL DEFAULT 'none',
    "failure_mode_remaining" INTEGER,
    "failure_delay_seconds" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_endpoints_url_check" CHECK (char_length("url") BETWEEN 1 AND 2048),
    CONSTRAINT "webhook_endpoints_description_check" CHECK ("description" IS NULL OR char_length("description") <= 500),
    CONSTRAINT "webhook_endpoints_events_check" CHECK (cardinality("enabled_events") BETWEEN 1 AND 32),
    CONSTRAINT "webhook_endpoints_status_check" CHECK ("status" IN ('enabled','disabled')),
    CONSTRAINT "webhook_endpoints_previous_secret_check" CHECK (("previous_secret_sealed" IS NULL) = ("previous_secret_expires_at" IS NULL)),
    CONSTRAINT "webhook_endpoints_max_attempts_check" CHECK ("max_attempts" BETWEEN 1 AND 12),
    CONSTRAINT "webhook_endpoints_failure_mode_check" CHECK ("failure_mode" IN ('none','http_500','timeout','invalid_signature','delay','duplicate','out_of_order')),
    CONSTRAINT "webhook_endpoints_failure_remaining_check" CHECK ("failure_mode_remaining" IS NULL OR "failure_mode_remaining" BETWEEN 1 AND 100),
    CONSTRAINT "webhook_endpoints_failure_delay_check" CHECK ("failure_delay_seconds" IS NULL OR "failure_delay_seconds" BETWEEN 1 AND 300),
    CONSTRAINT "webhook_endpoints_failure_shape_check" CHECK (("failure_mode" IN ('delay','out_of_order')) = ("failure_delay_seconds" IS NOT NULL)),
    CONSTRAINT "webhook_endpoints_version_check" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "webhook_endpoints_seq_key" ON "webhook_endpoints"("seq");
CREATE UNIQUE INDEX "webhook_endpoints_id_user_id_key" ON "webhook_endpoints"("id", "user_id");
CREATE INDEX "webhook_endpoints_user_seq_idx" ON "webhook_endpoints"("user_id", "seq" DESC) WHERE "deleted_at" IS NULL;
-- Fan-out reads the owner's enabled endpoints inside every event transaction.
CREATE INDEX "webhook_endpoints_fanout_idx" ON "webhook_endpoints"("user_id") WHERE "status" = 'enabled' AND "deleted_at" IS NULL;

-- ---------------------------------------------------------------- webhook_deliveries (one per event x endpoint)
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "seq" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    "user_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" SMALLINT NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    -- per-claim fencing token; only the holder of the current token may record a result
    "lease_token" UUID,
    "locked_until" TIMESTAMPTZ(6),
    "manual_pending" BOOLEAN NOT NULL DEFAULT false,
    "last_status_code" SMALLINT,
    "last_error_code" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_deliveries_status_check" CHECK ("status" IN ('pending','retrying','succeeded','failed','cancelled')),
    CONSTRAINT "webhook_deliveries_attempt_count_check" CHECK ("attempt_count" BETWEEN 0 AND 1000),
    CONSTRAINT "webhook_deliveries_lease_check" CHECK (("lease_token" IS NULL) = ("locked_until" IS NULL)),
    CONSTRAINT "webhook_deliveries_terminal_check" CHECK (
      ("status" IN ('succeeded','failed','cancelled')) = ("completed_at" IS NOT NULL)
      AND ("status" IN ('pending','retrying')) = ("next_attempt_at" IS NOT NULL)),
    CONSTRAINT "webhook_deliveries_status_code_check" CHECK ("last_status_code" IS NULL OR "last_status_code" BETWEEN 100 AND 599),
    CONSTRAINT "webhook_deliveries_error_code_check" CHECK ("last_error_code" IS NULL OR char_length("last_error_code") <= 64)
);
CREATE UNIQUE INDEX "webhook_deliveries_seq_key" ON "webhook_deliveries"("seq");
-- Fan-out can never create two deliveries of one event to one endpoint.
CREATE UNIQUE INDEX "webhook_deliveries_event_endpoint_key" ON "webhook_deliveries"("event_id", "endpoint_id");
CREATE UNIQUE INDEX "webhook_deliveries_id_user_id_key" ON "webhook_deliveries"("id", "user_id");
-- Claim scan: due work only.
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries"("next_attempt_at") WHERE "status" IN ('pending','retrying');
-- API / dashboard lists.
CREATE INDEX "webhook_deliveries_user_seq_idx" ON "webhook_deliveries"("user_id", "seq" DESC);
CREATE INDEX "webhook_deliveries_user_status_seq_idx" ON "webhook_deliveries"("user_id", "status", "seq" DESC);
CREATE INDEX "webhook_deliveries_endpoint_seq_idx" ON "webhook_deliveries"("endpoint_id", "seq" DESC);

-- ---------------------------------------------------------------- webhook_delivery_attempts (append-only history)
CREATE TABLE "webhook_delivery_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "attempt_no" SMALLINT NOT NULL,
    "trigger" TEXT NOT NULL,
    "lease_token" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_ms" INTEGER,
    "outcome" TEXT NOT NULL,
    "status_code" SMALLINT,
    "error_code" TEXT,
    "response_excerpt" TEXT,
    "response_headers" JSONB,
    "injected" BOOLEAN NOT NULL DEFAULT false,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "signature_kind" TEXT,
    "next_retry_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_delivery_attempts_attempt_no_check" CHECK ("attempt_no" BETWEEN 1 AND 1000),
    CONSTRAINT "webhook_delivery_attempts_trigger_check" CHECK ("trigger" IN ('scheduled','manual')),
    CONSTRAINT "webhook_delivery_attempts_outcome_check" CHECK ("outcome" IN ('success','retryable','permanent','abandoned')),
    CONSTRAINT "webhook_delivery_attempts_status_code_check" CHECK ("status_code" IS NULL OR "status_code" BETWEEN 100 AND 599),
    CONSTRAINT "webhook_delivery_attempts_error_code_check" CHECK ("error_code" IS NULL OR char_length("error_code") <= 64),
    CONSTRAINT "webhook_delivery_attempts_excerpt_check" CHECK ("response_excerpt" IS NULL OR char_length("response_excerpt") <= 1024),
    CONSTRAINT "webhook_delivery_attempts_headers_check" CHECK ("response_headers" IS NULL OR (jsonb_typeof("response_headers") = 'object' AND pg_column_size("response_headers") <= 2048)),
    CONSTRAINT "webhook_delivery_attempts_signature_kind_check" CHECK ("signature_kind" IS NULL OR "signature_kind" IN ('valid','valid_dual','injected_invalid')),
    CONSTRAINT "webhook_delivery_attempts_duration_check" CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0)
);
-- An attempt number can be recorded once per delivery: double recording is impossible.
CREATE UNIQUE INDEX "webhook_delivery_attempts_delivery_attempt_key" ON "webhook_delivery_attempts"("delivery_id", "attempt_no");
CREATE INDEX "webhook_delivery_attempts_user_created_idx" ON "webhook_delivery_attempts"("user_id", "created_at" DESC);

-- ---------------------------------------------------------------- scheduler_leases (operational; no user_id, documented exception)
CREATE TABLE "scheduler_leases" (
    "name" TEXT NOT NULL,
    "lease_token" UUID,
    "locked_until" TIMESTAMPTZ(6),
    "last_started_at" TIMESTAMPTZ(6),
    "last_finished_at" TIMESTAMPTZ(6),
    "last_summary" JSONB,

    CONSTRAINT "scheduler_leases_pkey" PRIMARY KEY ("name"),
    -- 'tick' is the production scheduler; hosted integration tests use their own 'test-<runId>' row and delete it afterwards.
    CONSTRAINT "scheduler_leases_name_check" CHECK ("name" = 'tick' OR "name" ~ '^test-[0-9a-f]{12}$'),
    CONSTRAINT "scheduler_leases_lease_check" CHECK (("lease_token" IS NULL) = ("locked_until" IS NULL)),
    CONSTRAINT "scheduler_leases_summary_check" CHECK ("last_summary" IS NULL OR pg_column_size("last_summary") <= 4096)
);
INSERT INTO "scheduler_leases" ("name") VALUES ('tick');

-- ---------------------------------------------------------------- foreign keys (owner FKs cascade from Auth; composite FKs keep every link inside one tenant)
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES auth.users("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES auth.users("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES auth.users("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_fkey" FOREIGN KEY ("event_id", "user_id") REFERENCES "events"("id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_fkey" FOREIGN KEY ("endpoint_id", "user_id") REFERENCES "webhook_endpoints"("id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_delivery_fkey" FOREIGN KEY ("delivery_id", "user_id") REFERENCES "webhook_deliveries"("id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------- RLS and Data API privileges (same pattern as S1/S2)
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_delivery_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduler_leases" ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
DECLARE s text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    FOREACH t IN ARRAY ARRAY['webhook_endpoints','webhook_deliveries','webhook_delivery_attempts','scheduler_leases'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated, service_role', t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['webhook_endpoints','webhook_deliveries'] LOOP
      s := pg_get_serial_sequence('public.' || t, 'seq');
      IF s IS NOT NULL THEN EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM anon, authenticated, service_role', s); END IF;
    END LOOP;
  END IF;
END $$;

-- ---------------------------------------------------------------- integrity triggers
-- Endpoint: identity never changes; a deleted endpoint is final; version rises by exactly 1 per change.
CREATE OR REPLACE FUNCTION sandbox_webhook_endpoints_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'webhook_endpoints: immutable column changed';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'webhook_endpoints: a deleted endpoint cannot change';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'webhook_endpoints: version must increase by exactly 1';
  END IF;
  RETURN NEW;
END;
$$;

-- Delivery: owner, event and endpoint never change; cancelled is final; a finished delivery may only be re-armed by a manual retry.
CREATE OR REPLACE FUNCTION sandbox_webhook_deliveries_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'webhook_deliveries: immutable column changed';
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'webhook_deliveries: a cancelled delivery cannot change';
  END IF;
  IF OLD.status IN ('succeeded','failed') AND NEW.status NOT IN ('succeeded','failed') AND NOT (NEW.status = 'retrying' AND NEW.manual_pending) THEN
    RAISE EXCEPTION 'webhook_deliveries: a finished delivery can only be re-armed by a manual retry';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'webhook_deliveries: attempt_count cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;

-- Attempts are history: no UPDATE, no TRUNCATE. DELETE is allowed so account deletion can cascade.
CREATE OR REPLACE FUNCTION sandbox_webhook_attempts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'webhook_delivery_attempts is append-only (% is not allowed)', TG_OP;
END;
$$;

REVOKE ALL ON FUNCTION sandbox_webhook_endpoints_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_webhook_deliveries_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_webhook_attempts_guard() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION sandbox_webhook_endpoints_guard() FROM anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION sandbox_webhook_deliveries_guard() FROM anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION sandbox_webhook_attempts_guard() FROM anon, authenticated, service_role;
  END IF;
END $$;

CREATE TRIGGER webhook_endpoints_guard BEFORE UPDATE ON "webhook_endpoints" FOR EACH ROW EXECUTE FUNCTION sandbox_webhook_endpoints_guard();
CREATE TRIGGER webhook_deliveries_guard BEFORE UPDATE ON "webhook_deliveries" FOR EACH ROW EXECUTE FUNCTION sandbox_webhook_deliveries_guard();
CREATE TRIGGER webhook_delivery_attempts_guard_row BEFORE UPDATE ON "webhook_delivery_attempts" FOR EACH ROW EXECUTE FUNCTION sandbox_webhook_attempts_guard();
CREATE TRIGGER webhook_delivery_attempts_guard_truncate BEFORE TRUNCATE ON "webhook_delivery_attempts" FOR EACH STATEMENT EXECUTE FUNCTION sandbox_webhook_attempts_guard();
