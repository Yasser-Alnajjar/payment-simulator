# S2 report: payment simulator backend (2026-11-13)

Not committed or pushed. All database work ran against the existing Hosted Supabase project (rule R-DB-1).

## Hosted database
- **Identity** (read-only, before and after): project ref matches, database `postgres`, PostgreSQL 17.11, S1 applied. Verified by `verifyHostedIdentity` from the live connection, not by an environment variable.
- **Live baseline before S2** (read-only, differs from the S1 historical record because the operator kept using the system): 1 Auth user, 2 credentials (both revoked), 47 audit rows, 26 orphaned audit user ids. During one test run the operator revoked their active credential from the dashboard (`revoked_at` 2026-11-13T01:57Z); the harness detected the baseline change, reported it, and wrote nothing to those rows.
- **Migration** `20261113120000_s2_payments`: dry-run in a transaction and rolled back (nothing persisted), then applied with `prisma migrate deploy`. Contents: one nullable column `api_credentials.expires_at`; six new tables; indexes; FKs; RLS enabled; Data API roles revoked; three guard functions and four triggers. No DROP, TRUNCATE or DELETE; no S1 object other than that column was touched.
- **Read-only verification afterwards** (`pnpm --filter @sandbox/db verify:s2`): all checks pass (tables, RLS, no API-role grants, cascading owner FKs, cascade checklist, indexes, one-active-payment index, composite FK, triggers, hardened guard functions, expires_at, migration history).
- **Preserved**: the existing Auth user is unchanged (fingerprint verified after every test run); the 2 credentials and all pre-existing audit rows are unchanged by tests.
- **Permanent artifacts**: audit rows written by tests are immutable by design. The audit table grew from 47 to 454 rows (156 orphaned user ids) across all S2 test runs. Test users, sessions, payments, events, keys and counters were all removed by cascade.

## Test results (Hosted Supabase only)
| Run | Files | Passed | Failed | Skipped |
|---|---|---|---|---|
| Web, full suite with hosted target declared | 13 | 107 | 0 | 0 |
| Core unit tests | 2 | 19 | 0 | 0 |
| Web without the hosted target (default, no database access) | 13 | 41 | 0 | 66 (hosted tests; not counted as passed) |

Earlier full runs had two infrastructure failures (Prisma interactive transaction timeouts after a ~15-19 s stall on the hosted database). Fixes: generous transaction timeouts (also applied to the S1 credential service) and a retry-on-P2028 in the test account helper. The final full run was clean; the stalls are a hosted-latency risk to watch.

Coverage: money and currency; both state machines; scenarios; Basic auth and credential lifecycle (revoked, rotated, expired); failed-authentication abuse limits; per-user rate limit; cross-user isolation on every route; sessions (create, get, list, filters, pagination, cancel, expiry); payments and events API; idempotency (replay, mismatch, expiry, encryption binding, concurrent replay); concurrent attempts, cancel races, resolution and expiry races; event atomicity, exact bytes and uniqueness; account deletion cascade; constraints, triggers, indexes, RLS and grants; API error envelope and request ids; harness safety.

## Typecheck and build
`pnpm -r typecheck`: pass (core, db, web). `next build`: pass, all 7 `/api/v1` routes built. A smoke test of the built server confirmed an unauthenticated `/api/v1/payments` returns the JSON 401 with `WWW-Authenticate: Basic` and `request-id`, while `/credentials` still redirects to `/login`.

## What was built
See `docs/S2-plan.md` §12 and `docs/state-machines.md`. Endpoints: `POST/GET /api/v1/checkout/sessions`, `GET .../{id}`, `POST .../{id}/cancel`, `GET /api/v1/payments` and `/{id}`, `GET /api/v1/events` and `/{id}`. The payment attempt is a service (`attemptPaymentByToken`) for S3's hosted page; no public route exists for it.

## Documentation corrections made first
S1 hosted record restated as a historical verification result (2026-11-13); D13 resolved (tagged test emails, write-ahead manifest, `cleanup-test-run`); stale local/Docker/disposable references removed or struck through; `.env.example` rewritten; harness rebuilt with no disposable mode and no `DROP SCHEMA`.

**Git status question.** At the start of the session the repository had no commits, so every file was untracked (`??`). Git lists untracked files without distinguishing edited from unedited ones, so my documentation edits could not appear as modifications and the status output looked unchanged. The operator has since committed; the current status shows genuine `M` entries for files S2 changed.

## Remaining and deferred
- No worker yet: due pending resolutions and expiries are applied on read/list or by `sweepAll`; S4 should call `sweepAll`.
- Idempotency and rate-limit row purge, and any audit retention, belong to S6.
- Client address trust: first `X-Forwarded-For` hop; deploy behind a proxy that sets it.
- Test runs add permanent audit rows to the shared hosted database; consider a smaller default test volume or a separate hosted test project (operator decision).
- Do not use the dashboard while hosted tests run (baseline check would fail).
- `/checkout/{token}` is a 404 until S3.
