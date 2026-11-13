-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "api_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_hash" TEXT NOT NULL,
    "client_secret_hint" TEXT NOT NULL,
    "webhook_secret_enc" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "api_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_credentials_client_id_key" ON "api_credentials"("client_id");

-- CreateIndex
CREATE INDEX "api_credentials_user_id_created_at_idx" ON "api_credentials"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at" DESC);



-- One active credential pair per user. The database is the final guard against duplicates.
CREATE UNIQUE INDEX "api_credentials_one_active_per_user"
  ON "api_credentials"("user_id") WHERE "revoked_at" IS NULL;

-- Ownership. Deleting the Supabase Auth user deletes their credentials. audit_logs deliberately has NO FK.
ALTER TABLE "api_credentials"
  ADD CONSTRAINT "api_credentials_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES auth.users("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS enabled with no policies: denies the Supabase Data API (anon/authenticated).
-- Prisma's role (postgres) has BYPASSRLS, so the application's user_id filters are the real isolation.
ALTER TABLE "api_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;

-- Remove Supabase's default Data API grants on our tables (guarded so it also runs on plain Postgres).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "api_credentials", "audit_logs" FROM anon, authenticated, service_role;
  END IF;
END $$;

-- audit_logs is append-only: UPDATE, DELETE and TRUNCATE are always rejected.
CREATE OR REPLACE FUNCTION sandbox_audit_logs_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% is not allowed)', TG_OP;
END;
$$;

REVOKE ALL ON FUNCTION sandbox_audit_logs_guard() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION sandbox_audit_logs_guard() FROM anon, authenticated, service_role;
  END IF;
END $$;

CREATE TRIGGER audit_logs_guard_row
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION sandbox_audit_logs_guard();

CREATE TRIGGER audit_logs_guard_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION sandbox_audit_logs_guard();
