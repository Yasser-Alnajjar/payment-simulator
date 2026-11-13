# S1: Hosted Supabase configuration & database safety

Project ref `yxyhgelnenqeulzxukrc` (hosted). **Rule R-DB-1 (`arch-plan.md`, "Hosted Supabase Only — No Local Supabase") applies: no local Supabase, no Supabase CLI local development, no Docker/Compose or any local database container, ever.** No second project is required by the app.

## Connection strategy
| Consumer | Variable | Connection | Why |
|---|---|---|---|
| Web runtime | `DATABASE_URL` | Transaction pooler, port 6543, `?pgbouncer=true` | Many short-lived instances; Prisma 7 + `@prisma/adapter-pg` |
| Worker (S4) | `WORKER_DATABASE_URL` | Session pooler (5432) or direct | Needs `FOR UPDATE SKIP LOCKED` / long-lived sessions |
| Migrations / inspection | `DIRECT_URL` | Session pooler (5432) (the direct host is IPv6-only and did not resolve from the dev machine) | DDL must not go through transaction pooling |

Browser-exposed: only `NEXT_PUBLIC_SUPABASE_URL` and the anon key. The service-role key is not used. All secrets live in the gitignored repo-root `.env`.

## Schema (S1)
Two tables, both keyed by `user_id` = `auth.users.id`: `api_credentials` (FK to `auth.users` `ON DELETE CASCADE`, partial unique index `WHERE revoked_at IS NULL` = one active pair per user) and `audit_logs` (no FK, append-only via triggers). See `docs/S1-revised-plan.md` §2-§3 and `docs/account-deletion-and-audit.md`.

## Inspection result (read-only, done)
PostgreSQL 17.11, connected as `postgres` (not superuser, `BYPASSRLS`, so Prisma bypasses RLS and the application's `user_id` filters are the isolation). `public` is empty; 0 Auth users; no name collisions. Default privileges grant `anon`/`authenticated`/`service_role` full rights on new objects created by `postgres` in `public`, hence the pre-migration hardening.

## Procedure (historical; this is how S1 was to be applied)
> **Status correction.** This section originally said nothing had been applied. S1 is now complete: the S1 migration is applied to the Hosted project and the real signup and email-verification flow was tested by the operator (statement of record, 2026-11-13; hosted-dev test mode in `apps/web/tests/harness.ts` also requires the S1 tables to exist). Exact row counts and the current contents of `api_credentials`, `audit_logs` and `auth.users` are **not recorded in any document**; measure them with the read-only `verify-s1`/inspect scripts before relying on them. Hosted migrations and SQL mutations still need separate explicit approval each time.
1. `pnpm --filter @sandbox/db inspect` (read-only; forced `default_transaction_read_only`).
2. After explicit approval: pre-migration default-privilege SQL (`docs/S1-revised-plan.md` §4).
3. After explicit approval: `pnpm --filter @sandbox/db migrate:deploy` (never `migrate dev`/`reset`).
4. Immediately after: protect `_prisma_migrations` and run the post-migration verification SQL (§6).

## Tests
All database integration tests run against this Hosted project only (rule R-DB-1), never against a local or containerized database. The required safeguards (identity verification, explicit target, isolated records, cleanup limited to the current run, no broad destructive SQL) are specified in `docs/S2-plan.md` §9, together with the gaps the current harness still has. Until those gaps are closed in S2, treat integration tests as not yet cleared to run. Read-only verification (`verify-s1`) is separate from write tests. The older text that described a `TEST_DATABASE_URL` disposable database, `ALLOW_SUPABASE_TEST_DB` and a second test project is void.
