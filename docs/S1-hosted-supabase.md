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

## Historical verification record (2026-11-13)
These are results reported by the operator from the S1 completion work on 2026-11-13. They are **historical verification results, not a new live database inspection**; S2 re-verifies live state read-only before any write.

| Item | Result |
|---|---|
| PostgreSQL | 17.11 |
| Auth users | 1 (the operator's real account; must never be modified or deleted) |
| `api_credentials` | 0 rows |
| `audit_logs` | 45 rows (immutable historical S1 test artifacts) |
| Orphaned audit user ids | 26 (test users already deleted; audit rows keep their `user_id` by design) |
| S1 migration `20261113000000_s1_foundation` | Applied |
| Default-privilege hardening (pre-migration SQL) | Applied |
| `_prisma_migrations` RLS and Data API revocations | Applied |
| S1 schema verification (`verify:s1`) | 10/10 passed |
| PostgreSQL integration tests | 10/10 passed |

## Procedure (historical; this is how S1 was to be applied)
> **Status correction.** This section originally said nothing had been applied. That is obsolete: S1 is complete and applied (see the historical record below).

1. `pnpm --filter @sandbox/db inspect` (read-only; forced `default_transaction_read_only`).
2. After explicit approval: pre-migration default-privilege SQL (`docs/S1-revised-plan.md` §4).
3. After explicit approval: `pnpm --filter @sandbox/db migrate:deploy` (never `migrate dev`/`reset`).
4. Immediately after: protect `_prisma_migrations` and run the post-migration verification SQL (§6).

## Tests
All database integration tests run against this Hosted project only (rule R-DB-1), never against a local or containerized database. The required safeguards (identity verification, explicit target, isolated records, cleanup limited to the current run, no broad destructive SQL) are specified in `docs/S2-plan.md` §9, together with the gaps the current harness still has. Until those gaps are closed in S2, treat integration tests as not yet cleared to run. Read-only verification (`verify-s1`) is separate from write tests. The older text that described a `TEST_DATABASE_URL` disposable database, `ALLOW_SUPABASE_TEST_DB` and a second test project is void.
