> **Historical document (S1 is complete). Rule R-DB-1 in `arch-plan.md` supersedes §10 (test plan execution order, "disposable" DB), §11 and every reference to a disposable/throwaway/local Postgres, `TEST_DATABASE_URL` or a second test project: tests run only against the existing Hosted Supabase database under the safeguards in `docs/S2-plan.md` §9.**

# S1 revised plan, v2: user-level ownership (PROPOSAL; nothing implemented, applied or run)

Supersedes the multi-tenant parts of `arch-plan.md` (§6 and the workspace/project entities in §12), `docs/S0-report.md` (§3, §5) and `docs/S1-migration-proposal.md` (now only a historical record; its purge function E is **removed**, not deferred in code). Existing code and the unapplied migration are untouched until you approve this.

## 1. Decisions incorporated

| # | Decision | How it is reflected |
|---|---|---|
| 1 | Direct `user_id` ownership; no workspaces/members/projects/profile table/quotas/authz framework | Two S1 tables, both with `user_id`. Explicit `{ id, userId }` filters in every query; no helper, no generic guard. |
| 2 | `api_credentials.user_id → auth.users.id ON DELETE CASCADE` | In migration. Deletion policy in §7. |
| 3 | One active pair per user via partial unique index `WHERE revoked_at IS NULL`; transaction-safe; DB is the final guard | In migration. "Active" is defined by `revoked_at IS NULL` only, so I **drop the `status` enum** (it would duplicate that fact and could disagree with it). Details in §5. |
| 4 | Audit independent of Auth FK; document what happens to `user_id` | §7. |
| 5 | No audit purge function in S1; retention stays in S6 | Purge function, flag and 90-day logic removed. The guard is now unconditional. |
| 6 | Migration unapplied; no SQL against hosted; separate disposable Postgres for tests | §10, §11. |
| 7 | Final review package | This document. |

Two things I changed beyond your list, for your veto: (a) `status` enum dropped (above); (b) `expires_at` dropped from `api_credentials` because nothing in S1 sets or reads it. S2 adds it with the API auth that needs it (one `ALTER TABLE ADD COLUMN`).

**One point you must explicitly accept.** You asked that secrets "never be recoverable from the database."
- **Client secret:** met fully. Only a SHA-256 hash is stored; the plaintext exists in the HTTP response that creates/rotates it and nowhere else.
- **Webhook signing secret:** HMAC signing needs the plaintext at delivery time, so it cannot be hashed. It is stored only as an AES-256-GCM ciphertext; a database dump, backup or SQL access alone cannot recover it. Recovery needs `SECRETS_ENCRYPTION_KEY`, which lives only in the app/worker environment, never in the database. It is shown once to the user and there is no "reveal" feature. This is the single unavoidable exception to "unrecoverable"; the only way to meet your wording literally is to not sign webhooks.

## 2. Final Prisma schema (`packages/db/prisma/schema.prisma`)

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated"
}

datasource db {
  provider = "postgresql"
}

model ApiCredential {
  id               String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  /// auth.users.id. The FK (ON DELETE CASCADE) is raw SQL in the migration; Prisma does not model the auth schema.
  userId           String    @map("user_id") @db.Uuid
  clientId         String    @unique @map("client_id")
  /// SHA-256 hex of the client secret. The plaintext is never stored.
  clientSecretHash String    @map("client_secret_hash")
  /// Display-only, e.g. "sbx_sk_…a1b2".
  clientSecretHint String    @map("client_secret_hint")
  /// AES-256-GCM ciphertext. The signing key is only in the app environment.
  webhookSecretEnc String    @map("webhook_secret_enc")
  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  lastUsedAt       DateTime? @map("last_used_at") @db.Timestamptz(6)
  /// NULL = active. Raw-SQL partial unique index guarantees at most one active row per user.
  revokedAt        DateTime? @map("revoked_at") @db.Timestamptz(6)

  @@index([userId, createdAt(sort: Desc)])
  @@map("api_credentials")
}

/// Append-only. No foreign keys: history outlives the user and the resources it describes.
model AuditLog {
  id         String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId     String?  @map("user_id") @db.Uuid
  action     String
  targetType String?  @map("target_type")
  targetId   String?  @map("target_id")
  metadata   Json     @default("{}")
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([userId, createdAt(sort: Desc)])
  @@map("audit_logs")
}
```
The partial unique index and the `auth.users` FK are not expressible in Prisma's schema. They are present only in the migration SQL, and a test asserts both exist (Prisma does not detect them as drift on `migrate deploy`; we never use `migrate dev`/`reset`).

## 3. Complete revised S1 migration (`packages/db/prisma/migrations/20261113000000_s1_foundation/migration.sql`)

Replaces the unapplied file. Not executed or syntax-checked anywhere yet. `prisma migrate deploy` sends the file as one multi-statement query, which PostgreSQL runs as a single implicit transaction, so a failure rolls everything back (to be verified on the test DB).

```sql
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
CREATE INDEX "api_credentials_user_id_created_at_idx" ON "api_credentials"("user_id", "created_at" DESC);
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
```
Contents: 2 tables, 4 indexes (one partial unique), 1 FK, 2 RLS enables, 2 guarded revokes, 1 function, 2 triggers. No enums, no purge function, nothing touching existing objects (inspection showed `public` is empty). Limit that remains by design: a role that owns the table can still drop the trigger; real protection against that needs the non-owner runtime role (later, separately approved).

## 4. Pre-migration SQL: default-privilege hardening (operator script; not run)

Why: inspection showed objects created by `postgres` in `public` get `arwdDxtm` (tables), `rwU` (sequences), `X` (functions) for `anon`, `authenticated`, `service_role`. Prisma creates `_prisma_migrations` as `postgres` before our SQL runs, so without this it would be born fully granted to the Data API roles with no RLS.

```sql
BEGIN;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
COMMIT;
```
- Effect: only affects objects `postgres` creates later in `public`; existing objects and other schemas (`storage`, `auth`, …) are unchanged. No data is touched.
- Privilege required: `postgres` (the role the inspection ran as).
- Pre-check (read-only): `select defaclobjtype, defaclacl::text from pg_default_acl where defaclnamespace = 'public'::regnamespace and pg_get_userbyid(defaclrole) = 'postgres';` should show the three anon/authenticated/service_role entries before, none after.
- Optional, no SQL: dashboard → Settings → API → remove `public` from "Exposed schemas" (the app never uses the Data API).

## 5. Concurrency design for credentials

All three operations run inside one `db.$transaction` (default READ COMMITTED) together with their audit insert; the unique index is the last line of defense, the explicit WHERE clauses make normal outcomes deterministic.

- **create:** `INSERT` (user_id from the session). If the user already has an active row, PostgreSQL raises unique violation `23505` on `api_credentials_one_active_per_user`; the service maps it to `conflict` ("You already have active credentials"). Two concurrent creates: one commits, the other waits on the unique-index entry then fails with 23505.
- **rotate(credentialId):** (1) `UPDATE ... SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`; require exactly 1 row, else `not_found`. (2) `INSERT` the replacement. (3) audit insert. Concurrent rotates of the same credential: the second `UPDATE` blocks on the row lock, re-evaluates `revoked_at IS NULL` after the first commits, matches 0 rows, and fails. Rotate racing create: the unique index rejects whichever tries to insert while another active row exists.
- **revoke(credentialId):** same `UPDATE ... WHERE id, user_id, revoked_at IS NULL`; 0 rows → `not_found` (also for already-revoked).
- Secrets: generated server-side with `crypto.randomBytes`, hashed/encrypted before insert, returned in the action response once, held only in React state (lost on navigation), never logged, never re-readable. List/read queries never select `client_secret_hash` or `webhook_secret_enc`.
- Open implementation risk: how the Prisma 7 pg-adapter reports `23505` for a partial index (expected `P2002`; the test asserts the mapping and I will also inspect the underlying code/constraint name as a fallback).

## 6. Post-migration verification SQL (all read-only `SELECT`; run after approval of the apply step)

```sql
-- 1. Exactly the expected tables
select tablename from pg_tables where schemaname = 'public' order by 1;
--   expect: _prisma_migrations, api_credentials, audit_logs

-- 2. RLS on every table
select c.relname, c.relrowsecurity as rls_enabled
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1;
--   expect: rls_enabled = true for all three (after step "Protect _prisma_migrations" below)

-- 3. Data API roles hold no table privileges
select c.relname, r.rolname,
       has_table_privilege(r.rolname, c.oid, 'SELECT')  as sel,
       has_table_privilege(r.rolname, c.oid, 'INSERT')  as ins,
       has_table_privilege(r.rolname, c.oid, 'UPDATE')  as upd,
       has_table_privilege(r.rolname, c.oid, 'DELETE')  as del,
       has_table_privilege(r.rolname, c.oid, 'TRUNCATE') as trunc
from pg_class c cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1, 2;
--   expect: all false

-- 4. Partial unique index
select indexdef from pg_indexes
where schemaname = 'public' and indexname = 'api_credentials_one_active_per_user';
--   expect: CREATE UNIQUE INDEX ... (user_id) WHERE (revoked_at IS NULL)

-- 5. Foreign keys
select conrelid::regclass as tbl, conname, confrelid::regclass as refs,
       case confdeltype when 'c' then 'CASCADE' else confdeltype::text end as on_delete
from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace order by 1;
--   expect: exactly one row: api_credentials -> auth.users, CASCADE; none for audit_logs

-- 6. Audit triggers present and enabled
select tgname, tgenabled, pg_get_triggerdef(oid) from pg_trigger
where tgrelid = 'public.audit_logs'::regclass and not tgisinternal order by 1;
--   expect: audit_logs_guard_row (UPDATE/DELETE, ROW), audit_logs_guard_truncate (TRUNCATE, STATEMENT), enabled 'O'

-- 7. Guard function hardening
select proname, proconfig, proacl::text from pg_proc
where proname = 'sandbox_audit_logs_guard' and pronamespace = 'public'::regnamespace;
--   expect: proconfig = {search_path=""}; proacl has no anon/authenticated/service_role/PUBLIC entries

-- 8. Default privileges hardened
select defaclobjtype, defaclacl::text from pg_default_acl
where defaclnamespace = 'public'::regnamespace and pg_get_userbyid(defaclrole) = 'postgres';
--   expect: no entries naming anon/authenticated/service_role

-- 9. Migration history
select migration_name, finished_at is not null as finished, rolled_back_at is not null as rolled_back
from _prisma_migrations order by started_at;
--   expect: one row, 20261113000000_s1_foundation, finished = true

-- 10. Tables empty, no data written by the migration
select (select count(*) from api_credentials) as credentials, (select count(*) from audit_logs) as audit_rows;
--   expect: 0, 0
```
Behavioral checks (INSERT/UPDATE/DELETE/TRUNCATE rejections, FK cascade) write data, so they run only on the disposable test database, never on hosted.

**Post-migration step (the only write after the migration; operator script):** protect Prisma's own table.
```sql
ALTER TABLE public."_prisma_migrations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."_prisma_migrations" FROM anon, authenticated, service_role;
```
Effect: closes the Data API on a table Prisma created. Privilege: its owner (`postgres`). The REVOKE is a no-op if the pre-migration hardening already ran, kept as belt-and-braces. Run immediately after `migrate deploy`.

## 7. Account deletion and audit policy (to be written to `docs/account-deletion-and-audit.md`)

**Account deletion.** Deleting a user in Supabase Auth (dashboard or Admin API; the app has no delete-account feature in scope) cascades to `api_credentials` automatically. Deliberate policy for every future user-owned table (sessions, transactions, events, webhook endpoints and deliveries): they hold only sandbox test data with no retention value, so each gets `user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE`, and child tables cascade from their parent as well so the chain deletes cleanly. A new owned table without that FK needs an explicit written exception in its migration. A verification query in each phase's checklist lists every `public` table with a `user_id` column lacking a cascading FK to `auth.users`, excluding only `audit_logs`.

**Audit rows after deletion.** `audit_logs.user_id` is a plain uuid with no FK, so rows survive and keep that value.
- What the retained value is: an opaque random UUID. After the Auth row is deleted nothing in our systems maps it back to an email or person (we store no email, name or IP in S1 audit rows; `metadata` is restricted by rule to non-personal fields: ids and action names, never secrets, emails or IPs).
- Assessment: that is pseudonymous, not directly identifying, and an orphaned id is useful for security forensics. **Recommendation: no automatic anonymization on deletion in S1.**
- Why not anonymize now: it would require UPDATE on `audit_logs`, which the immutability guard (correctly) forbids; doing it later needs the deliberate operator path designed in S6 together with retention. S6 must decide whether a formal erasure procedure (nulling `user_id` for a deleted account) is required for compliance, and if so build it under the same controls as purge.
- If you want stricter behavior now, the cheapest option is to also stop writing `user_id`-linked rows for low-value events; I don't recommend it.

## 8. Updated UI routes and page structure

| Route | Purpose | Notes |
|---|---|---|
| `/login`, `/register`, `/forgot-password`, `/reset-password` | Auth | Unchanged |
| `/auth/callback` | Email verification / recovery code exchange | Unchanged |
| `/healthz` | Liveness | Unchanged |
| `/credentials` | Dashboard home for S1: current active credential (client ID, secret hint, created, last used) with **Rotate**, **Revoke**, or **Create** if none; one-time secrets panel; short history of revoked pairs (last 20) | New |
| `/` | `redirect` to `/credentials` via `next.config.ts` redirects (S3 replaces it with the overview) | Changed |
| ~~`/projects/[projectId]`~~ | | Deleted |

Structure (per your page → SSR → CSR rule):
```
src/app/credentials/page.tsx                     thin wrapper (Suspense + module)
modules/credentials/overview/ssr/CredentialsOverview.tsx   fetches via Actions.Credentials.getCredentials(), null-safe
modules/credentials/overview/csr/CredentialsView.tsx       UI + mutations (create/rotate/revoke via Actions)
modules/credentials/overview/csr/IssuedSecrets.tsx         one-time display (kept from current code)
modules/credentials/overview/index.ts
modules/credentials/index.ts, modules/index.ts             exports: Auth, Credentials
src/lib/types/credential.ts                                CredentialView {id, clientId, clientSecretHint, createdAt, lastUsedAt, revokedAt}; IssuedCredential
```
Sign-out header stays inside `CredentialsView` for S1.

## 9. Exact files to change

| File | Action |
|---|---|
| `packages/db/prisma/schema.prisma` | Rewrite (§2) |
| `packages/db/prisma/migrations/20261113000000_s1_foundation/migration.sql` | Rewrite (§3) |
| `packages/db/src/generated/*` | Regenerated (gitignored) |
| `packages/core/src/slug.ts`; `slugify` export in `index.ts`; slug test in `credentials.test.ts` | Delete / trim |
| `apps/web/src/server/authz.ts` | Delete |
| `apps/web/src/server/services/workspaces.ts` | Delete |
| `apps/web/src/server/services/credentials.ts` | Rewrite: `{id, userId}` filters, partial-index conflict mapping, no counts |
| `apps/web/src/server/session.ts` | Remove `ensureProfile`/profile upsert |
| `apps/web/src/server/audit.ts` | `{ userId, action, targetType, targetId, metadata }` |
| `apps/web/src/actions/workspaces.ts`; `apps/web/src/lib/types/workspace.ts` | Delete |
| `apps/web/src/actions/credentials.ts` | Rewrite: `getCredentials()`, `createCredentialAction()`, `rotateCredentialAction({credentialId})`, `revokeCredentialAction({credentialId})` |
| `apps/web/src/actions/namespaces.ts` | Drop `Workspaces` |
| `apps/web/src/lib/types/credential.ts` | Rewrite |
| `apps/web/modules/workspaces/**`, `apps/web/modules/projects/**` | Delete |
| `apps/web/modules/credentials/**`, `modules/index.ts` | Add / update (§8) |
| `apps/web/src/app/page.tsx`, `apps/web/src/app/projects/[projectId]/page.tsx` | Delete; add `src/app/credentials/page.tsx` |
| `apps/web/next.config.ts` | Add `/` → `/credentials` redirect |
| `apps/web/tests/tenant-isolation.test.ts` | Replace with `user-isolation.test.ts` |
| `apps/web/tests/harness.ts` | Disposable-DB guard + `auth.users` stub |
| `packages/db/scripts/inspect-db.ts` | Collision list updated to the 2 tables; optionally add the §6 checks as a read-only `verify` script |
| `docs/S1-revised-plan.md` (this file), `docs/S0-report.md`, `docs/S1-hosted-supabase.md`, `docs/S1-migration-proposal.md`, `arch-plan.md` (banner), new `docs/account-deletion-and-audit.md`, `.env.example` (comment) | Update |

Unchanged: auth actions/pages, Supabase clients, proxy, env validation, UI primitives, `packages/core` credentials and crypto.

## 10. Test plan

All integration tests need the disposable PostgreSQL (§11). They are written during implementation but stay skipped (no `TEST_DATABASE_URL`) until you approve a test DB. Unit tests run now.

Unit (run immediately, no DB): secret generation/hash/verify, AES-GCM round trip and tamper rejection; Zod schemas for every action contain no user-id field and strip a spoofed `userId`.

Integration (disposable Postgres, migration applied via the real migration file):
1. **Cross-user isolation:** B cannot read, rotate or revoke A's credential (`not_found`; row unchanged), including when passing A's credential id; B's list never contains A's rows.
2. **One active per user:** second create → `conflict`; after revoke, create succeeds.
3. **Concurrent create:** N parallel creates for one user → exactly one fulfilled; exactly one active row. Also confirms the DB-level error mapping.
4. **Concurrent rotate:** parallel rotates of the same credential → exactly one succeeds; exactly one active row; old row revoked.
5. **Create racing rotate and revoke racing rotate:** never leaves 0 or 2 inconsistent states beyond "one active or none"; never 2 active.
6. **Direct SQL bypass:** inserting a second active row for a user fails at the index even bypassing app code (proves the DB is the final guard); two active rows for different users are allowed.
7. **Secrets:** raw row contains no client-secret plaintext, no webhook-secret plaintext; webhook ciphertext decrypts only with the key; read paths don't select secret columns; responses after issuance omit them.
8. **Audit immutability:** UPDATE, DELETE and TRUNCATE all fail (including as the table owner via SQL), INSERT works; no secrets in audit metadata; trigger function has `search_path=""`.
9. **Account deletion:** delete the stub `auth.users` row → that user's credentials gone; their audit rows remain with `user_id` unchanged; other users' rows untouched.
10. **Schema assertions:** partial unique index definition, FK `ON DELETE CASCADE`, no FK on `audit_logs`, RLS enabled, migration applies cleanly to an empty database and its failure rolls back as one unit.
11. **Auth boundary:** unauthenticated actions → `unauthenticated`; unverified email cannot create/rotate/revoke.

Execution order after approval (implementation): (1) schema + migration, regenerate client, typecheck; (2) core code removal + unit tests; (3) services/actions/modules/routes, `next build`, typecheck; (4) write integration tests + harness (skipped); (5) docs; (6) report. Then separate approvals, in order: disposable test DB → run integration tests; pre-migration SQL (§4) → `migrate deploy` → post-migration step and verification (§6) on hosted.

## 11. ~~Disposable test database requirement~~ (VOID: superseded by rule R-DB-1; kept only as history)
Options: (a) a second Supabase project used only for tests; (b) a throwaway local Postgres 17 container on a non-default port (not Supabase; needs about 0.4 GB of disk and you have ~11 GiB free). The harness will: require `TEST_DATABASE_URL`; refuse to run if the host contains `supabase.co`/`supabase.com` unless an explicit `ALLOW_SUPABASE_TEST_DB=1` is set (for option a) or the string `yxyhgelnenqeulzxukrc` appears; create a stub `auth` schema/table (`auth.users(id uuid primary key)`) only if it does not exist; apply the real migration file; drop only schemas/objects it created. Nothing runs against the hosted project.
