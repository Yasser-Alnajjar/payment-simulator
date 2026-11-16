# S6 report: Parts A and B executed. Release readiness: conditional, not signed off

Rule R-DB-1 respected. Sections 1-5 were produced with no hosted database access (public requests to the deployed URL only). Section 6 (Part B, approved by you) did use the hosted database: read-only verification, a temporary pause of the scheduler cron job (re-enabled), and the hosted test suite with its own cleaned-up test users. No migration or DDL. Nothing is committed.

## 1. Executed (results)
| Check | Result |
|---|---|
| `pnpm typecheck` (web, core, db) | clean |
| `@sandbox/core` tests | 128 passed |
| `@sandbox/web` tests | 113 passed, **99 skipped** (hosted-database suites, **not run**, not counted as passed), 0 failed (108 + 5 new) |
| `pnpm examples:check` | clean |
| `next build` | succeeds |
| `pnpm audit` | no known vulnerabilities (as reported by the registry audit at run time; prod and dev together, not separated) |
| Client bundle (`.next/static`) grep for `SECRETS_ENCRYPTION_KEY`, `DATABASE_URL`, `SCHEDULER_TICK_SECRET` | no matches |
| Deployed `/login` headers | HSTS (2 years, preload), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`; no `X-Powered-By` |
| Deployed `/healthz` | `{"status":"ok"}` (liveness only, does not check the database) |
| Deployed `/api/v1/events` unauthenticated | `401`, `WWW-Authenticate: Basic`, `no-store` |

## 2. New tests (`apps/web/tests/hardening.test.ts`, 5 tests, no database)
Auth callback open-redirect guard (8 hostile `next` values all fall back to `/`), streaming body cap (413 with no `Content-Length`; declared oversize refused up front), media-type/array/invalid-JSON rejection, Basic header parsing limits. **Mutation check:** loosening the callback regex to `/^\//` made the redirect test fail; original restored (verified by `git diff`).

## 3. Reviewed by reading code (not executed against a database)
- **Tenant scoping:** I read the list of Prisma calls in `apps/web/src/server` (services, lifecycle, engine, auth). Every read/update of a user-owned row is scoped by `userId` directly, or by an id already loaded under `userId` in the same transaction. Exceptions that are intentional: lookup by secret token hash (checkout/setup public pages, then scoped by the found `userId`), credential lookup by `clientId` (then authenticated), and the global `schedulerLease` row, which the dashboard displays to every user (system health only; low). **Not done:** the raw SQL files (`lifecycle`, `fanout`, `scheduler`, `engine`, `rate-limit`, and services) were located but not individually audited for `user_id` scoping; RLS/grants in migration SQL not reviewed.
- **API authentication:** SHA-256 hash plus `timingSafeEqual`; dummy comparison for unknown ids; revoked/expired reported only after the secret verifies; per-IP and global failure counters; 401 vs 429 oracle closed.
- **Body size limit:** 64 KiB, enforced while streaming.
- **Cookies:** proxy forces `httpOnly` on session cookies. Dashboard routes are behind the proxy; API routes are excluded from it by design.
- **Open redirect:** callback only follows `^/(?!/)[\w\-/]*$` (tested).

## 4. Findings
1. **(Medium, deployment-dependent) Client IP is taken from the first `X-Forwarded-For` entry** (`clientIp`, `server/api/auth.ts`). On Vercel the platform sets this header, so it is trustworthy there; on any host that does not overwrite it, a client can choose its own value and sidestep the per-IP failed-auth limit (the global and per-client-id buckets still apply). Documented, not changed. Recommend: document the requirement, or take the last trusted hop.
2. **(Low) `/healthz` is liveness only**: a database or scheduler outage still reports `ok`. Arch-plan §18 lists health checks; a readiness check needs a DB read and a decision from you.
3. **(Low) No HSTS set by the application** (Vercel adds it on its domains; a custom domain or other host needs it configured).
4. **(Low) Scheduler health row is visible to all dashboard users** (see §3).
5. Open from S5 (unchanged): no root README; OpenAPI has no `license`; `vue-demi: false` approval pending.

## 5. A4-A8 (completed afterwards, by reading; no database access)
**A4 SQL and grants.** Every raw SQL statement in `lifecycle`, `fanout`, `scheduler`, `engine` and the services is a parameterized tagged template (no `*RawUnsafe` anywhere outside generated code). User-facing statements carry `user_id = ${userId}` (row locks, idempotency, manual retry, endpoint delete, fan-out). The only global statements are the scheduler's lease, sweep and claim queries, which are system-wide by design and join endpoints on `w.user_id = d.user_id`. All 15 tables created by the four migrations have `ENABLE ROW LEVEL SECURITY` (checked by script: 15 created, 15 enabled, none missing), `REVOKE ALL` from `anon`/`authenticated`/`service_role` on tables, sequences and the 8 guard functions, and `ops/001`/`002` cover default privileges and `_prisma_migrations`. Not verified against the live database.
**A5 Concurrency/recovery.** Present in code: row locks (`FOR UPDATE`/`FOR SHARE`) before every state change, advisory locks for per-user endpoint and per-customer card limits, `ON CONFLICT DO NOTHING` idempotency claims (checkout and API scopes), atomic rate-limit upserts on the database clock, `FOR UPDATE SKIP LOCKED` claiming, fenced delivery updates (`lease_token` must match, otherwise the attempt is recorded as `stale`), expired-lease reaper that records `lease_lost` attempts and fails exhausted deliveries, 90 s scheduler lease greater than `maxDuration` 60 s. These were exercised by the S2-S4 hosted suites; **I did not re-run them**, so S6 provides no new execution evidence.
**A6 Migrations.** Four migrations in order, `migration_lock.toml` present, S4 rollback documented outside `prisma/migrations`. `verify:s1/s2/s4` set `default_transaction_read_only = on` and check RLS/privileges; `dry-run-migration.ts` runs the migration inside `BEGIN ... ROLLBACK` (it writes transiently, so it needs approval: B2). `ops/003` is not re-runnable as is (`vault.create_secret` on existing names fails). Not executed.
**A7 Deployment config.** See `docs/operations.md` §4. Fail-closed: Supabase vars and encryption key (names-only error), tick secret (404), private-target flag (refused outside development, on Vercel and in production). **Not fail-closed:** unset `APP_ENV` defaults to `development`; unset `APP_URL` defaults to `http://localhost:3100` off Vercel. `maxDuration = 60` set on the tick route. Vercel settings themselves unverifiable here.
**A8 Backups.** `docs/operations.md` written (data inventory, backup checklist, restore runbook, RPO/RTO placeholders, release order). Backup plan, retention and PITR **unverified**; no restore drill.

Additional findings from A4-A8:
6. **(Medium) `SECRETS_ENCRYPTION_KEY` has no rotation path and is not recoverable from the database.** Losing it makes stored webhook secrets and idempotent-replay tokens unreadable. Documented as part of the backup set.
7. **(Low) Defaults that fail open to dev values** (`APP_ENV`, `APP_URL`; see A7). Recommend requiring both when `NODE_ENV=production`; behaviour change, awaiting your decision.
8. **(Low) `ops/003_s4_scheduler.sql` is not idempotent** (restore step in the runbook accounts for it).
9. **(Info) Backups, retention, plan tier, Vercel project settings, preview-deployment isolation: unknown.**

## 6. Part B executed (approved: B1, B2)
**Hosted database writes made:** (1) paused the cron job `sandbox-scheduler-tick` (`cron.alter_job active := false`), waited 200 s as the harness requires, and **re-enabled it afterwards (verified `active = true`)**; (2) the hosted test suite wrote and cleaned up its own tagged test users (`sbx-test-*@sbx-test.invalid`). No migration, no DDL. The cron job was inactive for about 12 minutes; no ticks ran, so due sessions and deliveries (none existed) were not swept in that window.
**B1 hosted suite:** `SANDBOX_TEST_TARGET` and expected project ref set, `e2e-deployed.test.ts` excluded (needs a live tunnel and active cron): **22 files, 211 tests passed, 0 failed, 0 skipped**, 520 s (includes S2-S4 hosted concurrency, idempotency, isolation, webhook, retry and lease tests, and the 5 new hardening tests). Afterwards: no `sbx-test-*` users remain; row counts equal the earlier baseline (events 58, sessions 6, payments 24, credentials 3); the 6 payment methods and 1 webhook endpoint present were all created before this run (latest 2026-11-16 10:20 UTC), so they are the operator's data, not test leftovers.
**B2 migrations and schema (read-only, `default_transaction_read_only = on`):** `migrate:status`: 4 migrations, "Database schema is up to date". `verify:s4`: **all checks passed** (identity, RLS, no API-role privileges, no policies, cascades, composite tenant FKs, indexes, constraints, guard functions, single `tick` lease). Independent query: 16/16 public tables have RLS (15 app tables plus `_prisma_migrations`), 0 table or sequence privileges for `anon`/`authenticated`/`service_role`, 0 policies, all 9 guard functions with `search_path=''` and no PUBLIC/API-role EXECUTE, every `user_id` table cascades from `auth.users` except `audit_logs` (documented exception, deliberately has no FK). The last 50 cron runs all `succeeded`.
**`verify:s1` and `verify:s2` report 5 failures each. These are stale assertions, not database defects:** they hard-code S1/S2 table sets, role-by-table counts (9), guard-function count (4) and the exact migration list, and later migrations added tables, functions and an index change (`events_user_id_subject_id_type_key` was replaced). Where the assertions are about security properties (privileges, RLS, FKs, triggers) the same facts pass in `verify:s4` and in my query above. Recommended follow-up: update or retire those two scripts.
**Dry-run (`dry-run-migration.ts`) not run:** all four migrations are already applied, so replaying one would fail on existing objects and prove nothing. It is only meaningful for a future unapplied migration.

## 6b. Gap tests written and run (hosted): `apps/web/tests/saved-cards.test.ts`
9 hosted tests through the real handlers (no mocks): no card number or security code in any `payment_methods` row or event payload (and exactly one `payment_method.created` event); a second user gets `404 resource_not_found` on get/default/disable/delete of another user's payment method, on get/cancel of their setup session, on charging their method, and sees empty lists, with the owner's data unchanged; a setup session completes exactly once under 6 concurrent attempts (one method, one event; reuse and cancel afterwards refused/no effect); a card refused at setup is never saved; cancelled and expired setup sessions cannot save a card; concurrent set-default (8 calls over 4 cards) leaves exactly one default; 6 concurrent creates of the same card save once; charges: success, decline (`201` with `failed`/`card_declined`), idempotent replay (same payment id, `Idempotent-Replayed`), key reuse with another body `422`, missing key `400`, 8 concurrent identical requests produce exactly one payment (3 rows in total); disabled method refused, a charge racing a delete leaves consistent state and the deleted method cannot be charged; a mismatched customer reference is refused.
**Result: 9 passed (first run, cron paused, then re-enabled).** **Mutation check:** I removed the `user_id` scoping from `lockMethod` (SQL and ORM) and re-ran the cross-tenant test: it failed (`expected 500 to be 404`); the change was reverted (`git diff` is empty for `src/`) and cron re-enabled. Cleanup verified: 0 `sbx-test-*` users left; counts back to baseline.
Limits: the saved-card path was tested at API level only; worker-restart recovery and OpenAPI-vs-live-handler shapes (the other items in the plan) are still not covered by new tests. The cron job was paused twice more for about 4 minutes each.

## 7. Still NOT done
- **Remaining gaps after §6b:** worker-restart recovery (lease expiry is covered by existing S4 tests, a full restart scenario is not), OpenAPI response shapes against live handlers, cross-tenant checks for the events/payments/checkout-session routes beyond what S2/S3 suites cover. Saved-card, setup-session and charge paths are now covered (§6b).
- Deployed end-to-end test (tunnel + live cron) not re-run.
- Backup/restore drill, Vercel dashboard checks (operator).
- Security review gaps: SSRF re-review beyond S4 tests, log leakage, server-action authorization, dashboard output sanitization.

## 8. Release-readiness status
**Conditionally supported, not signed off.** Now demonstrated by execution: full local suite and the full hosted suite (211/211), schema and security posture of the live database, migration state, cron health. Not demonstrated: dedicated tests for saved-card/setup-session concurrency, backups and restore, Vercel configuration, encryption-key recovery. Open findings 1, 6, 7 remain decisions for you.

## 9. Decisions needed
1. Findings 1, 2, 7: document only, or change code?
2. Remaining gaps (see §7): cover them in a further hosted step, or accept?
3. Operator tasks: backups/restore, Vercel (`docs/operations.md`), and the `SECRETS_ENCRYPTION_KEY` backup.
4. Update or retire `verify-s1/s2`.
5. Review, then say whether to commit (nothing is committed): `docs/S6-plan.md`, `docs/S6-report.md`, `docs/operations.md`, `apps/web/tests/hardening.test.ts`, `apps/web/tests/saved-cards.test.ts`.
