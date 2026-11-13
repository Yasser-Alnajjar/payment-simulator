# S2 plan: payment simulator backend (revision 3: IMPLEMENTED; see `docs/S2-report.md`)

Status: approved and implemented on 2026-11-13. This file remains the specification. Where the implementation refined the plan, the changes are listed in "Implementation notes" at the end; `docs/state-machines.md` documents the state machines, scenarios, events and bounded timing as built.

> **Rule R-DB-1: Hosted Supabase Only — No Local Supabase.** The authoritative text is in `arch-plan.md` (section of that name, top of file). In short: no local Supabase, no Supabase CLI local development, no Docker/Compose or any local/disposable database container, ever; every database integration test runs against the existing Hosted Supabase PostgreSQL database under the safeguards in §9; web, worker and scripts may run locally and connect to it; no database URL, password or key appears in logs, reports, commits or docs. This plan must not be read as offering any alternative.

Revision 2 changes: removed the Docker PostgreSQL option and every local-database reference; rewrote D12 and §9; recorded the verified S1 hosted state (§2); added harness gaps as required S2 work items (§9.4); added D13.

## 1. Scope

In scope (roadmap `arch-plan.md` §20 and `docs/S0-report.md` §§6-8, as amended by user-level ownership):
- API authentication (client id and secret, Basic).
- Request pipeline: request id, rate limit, body limit, validation, idempotency, error envelope.
- Checkout sessions, transaction domain, state machines.
- Payment scenario engine.
- Event persistence (outbox) in the same DB transaction as state changes.

Explicit exclusions: hosted checkout page and any dashboard UI (S3); webhook endpoints, signing, deliveries, worker, retries, SSRF guard (S4); OpenAPI and docs (S5); retention jobs, non-owner runtime role (S6); card data, `success_url`/`cancel_url`, refunds; any local/containerized database (forbidden by R-DB-1).

## 2. S1 hosted state (historical record, 2026-11-13; not a live inspection)

PostgreSQL 17.11; one Auth user (the real account); `api_credentials` 0 rows; `audit_logs` 45 rows; 26 orphaned audit user ids; S1 migration, default-privilege hardening and `_prisma_migrations` RLS/revocations applied; `verify:s1` 10/10; S1 integration tests 10/10. See `docs/S1-hosted-supabase.md`. S2 re-verifies the live state read-only (identity and baseline) before any write and records it in `docs/S2-report.md`.

## 3. What S1 provides and what S2 must add

Reusable: `api_credentials` (unique `client_id`, SHA-256 `client_secret_hash`, `revoked_at IS NULL` = active, `last_used_at`), `verifySecret`, append-only `audit_logs`, `AppError`/`fail()`, the migration conventions (RLS on, Data API roles revoked, trigger functions with `search_path=''`), pg adapter on the transaction pooler.

Gaps: no API auth or route handlers; `proxy.ts` would 307-redirect unauthenticated `/api/v1/*` calls to `/login` and calls Supabase `getUser()` on every request (exclude `/api/v1` from the matcher); no `expires_at` on credentials; `isUniqueViolation` only recognizes the S1 constraint name; no money, state machine, scenarios, idempotency, rate limit or events; the test harness does not meet R-DB-1 (§9.4).

## 4. Risks

1. `proxy.ts` intercepts API calls (above).
2. **Cascade vs immutability:** a `BEFORE DELETE` guard on `events` would make deleting an Auth user fail. Immutability triggers guard UPDATE and TRUNCATE only; sessions, payments and events stay deletable by cascade (and by the S6 purge). This also lets tests clean up by deleting only their own test users.
3. **Idempotent replay leaks the checkout token** if the snapshot is plaintext. Store the snapshot with the token field AES-GCM encrypted (same key as webhook secrets).
4. Concurrent same-key creates: put the idempotency insert in the same DB transaction as the session (`INSERT ... ON CONFLICT DO NOTHING`; the loser waits on the unique index then reads the committed snapshot).
5. Double payments and races: partial unique index on `transactions(checkout_session_id) WHERE status IN ('pending','succeeded')`; transitions by `UPDATE ... WHERE status = $expected` plus `version` increment; event insert in the same transaction.
6. `bigint` amounts do not JSON-serialize; convert in the DTO layer and cap at the JS-safe integer.
7. Resource exhaustion: 64 KB body cap, metadata limits, a throttled `last_used_at`, one DB write per request for rate limiting.
8. **Hosted-DB testing hazards (R-DB-1):** tests share the one hosted database with real data. Every test write must be isolated and cleaned up by id; `audit_logs` rows written by tests are permanent. Concurrency tests must respect Supabase pooler connection limits.
9. Clock: injectable `now()` for tests, app clock in production; skew across instances is a known limit.

## 5. Design

### 5.1 Schema (one new migration, written only; applying needs separate approval)

All tables: `user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE`, RLS enabled with no policies, Data API roles revoked, as in S1.

| Table | Key columns and constraints |
|---|---|
| `checkout_sessions` | `id`, `user_id`, `token_hash` unique, `amount_minor` bigint CHECK > 0, `currency` CHECK 3 upper-case letters, `external_reference`, `metadata` jsonb, `preset_scenario`, `status` (open/completed/expired/cancelled), `expires_at`, timestamps. Unique `(id, user_id)`. Trigger rejects UPDATE of `amount_minor`, `currency`, `token_hash`. |
| `transactions` | `id`, `user_id`, composite FK `(checkout_session_id, user_id)` cascade, copied `amount_minor`/`currency`, `status` (pending/succeeded/failed/cancelled), `scenario`, `resolve_at`, `resolve_to`, `failure_code`, `version`, timestamps. Partial unique index (above). Trigger rejects UPDATE of terminal rows and of amount/currency. |
| `events` | `id`, `seq` identity, `user_id`, `type`, `subject_id`, `payload` text (exact serialized bytes), `created_at`. Unique `(user_id, subject_id, type)`. UPDATE/TRUNCATE rejected; DELETE allowed (cascade). |
| `idempotency_keys` | PK `(user_id, key)`, `request_hash`, `status_code`, `response`, `created_at`; 24 h TTL applied lazily. |
| `rate_limit_windows` | PK `(user_id, window_start)`, `count`. |
| `api_credentials` (alter) | `ADD COLUMN expires_at timestamptz NULL` (D8). |

Audit actions added: `checkout_session.created`, `checkout_session.cancelled` (permanent rows; see risk 8).

### 5.2 Domain (`packages/core`, pure, unit-tested)
Money and currency (minor units, curated ISO 4217 list with exponents), table-driven session and transaction state machines, scenario engine (`success`, `decline`, `pending`, `pending_then_success`, `pending_then_failure`, `cancel`, `timeout`), prefixed public ids (`cs_`, `pay_`, `evt_` + uuid), canonical request hash.

### 5.3 Server (`apps/web/src/server`)
- `api/auth.ts`: parse Basic, look up by `client_id`, constant-time verify (dummy compare when unknown), check `revoked_at` and `expires_at` on every request (no cache), throttled `last_used_at`. Generic `invalid_credentials` for all unauthenticated cases; `credential_revoked`/`credential_expired` only after the secret verified.
- Pipeline order: request id, auth, rate limit, body read (64 KB, JSON only), Zod validation, idempotency, handler. Error envelope `{error:{type,code,message,param?,request_id}}` via a new `ApiError`. Headers `Request-Id`, `X-RateLimit-*`, `Retry-After` on 429.
- Services: `checkout-sessions.ts`, `payments.ts`, `events.ts`. Every query filters by `{ id, userId }`.
- Expiry evaluated on touch plus a bounded per-user sweep on list/get; a global sweep function is exported for the S4 worker.
- `db-errors.ts`: `uniqueViolationConstraint(e)` replaces the S1 string match.

### 5.4 API (Basic auth only; dashboard sessions never authorize it; no CORS)
`POST /api/v1/checkout/sessions` (optional `Idempotency-Key`), `GET` list and by id, `POST .../{id}/cancel`, `GET /api/v1/payments` and `/{id}`, `GET /api/v1/events` and `/{id}`. Cursor pagination (`limit` ≤ 100, `starting_after`). A foreign or malformed id returns the same 404.

### 5.5 UI
None. Only `proxy.ts` changes (exclude `/api/v1`). `/checkout/{token}` and scenario controls are S3.

## 6. Test strategy (what is tested; where it runs is §9)

Unit tests (no database, run freely): money/currency, every state transition valid and invalid, scenario plans, id parsing, request-hash canonicalization, Basic parsing, rate-window math, metadata limits, error envelope, and the new harness safety functions (§9).

Integration tests (Hosted Supabase only, under §9): API auth incl. revoked/expired credentials; cross-user isolation on every route; sessions (immutability enforced by the trigger, expiry, cancel cascade); idempotency (replay, mismatch, N parallel creates, no plaintext token in snapshot); every scenario incl. pending resolution and timeout; concurrency (parallel outcomes, cancel vs outcome, resolve) with exactly one winner and one event per (subject, type); event atomicity (rollback leaves no event) and stable bytes; cascade on deleting a test user; rate limit 429 and reset; schema assertions through read-only catalog queries.

End to end: HTTP-level lifecycle through the real route handlers (browser E2E waits for S3).

Tests are claimed as passing only after they were actually run.

## 7. Files expected to change
New: migration `<ts>_s2_payments`; `packages/core/src/{money,currency,ids,state-machine,scenarios,idempotency}.ts` + tests; `apps/web/src/server/api/{auth,pipeline,errors,body,rate-limit,idempotency,dto}.ts`; `apps/web/src/server/services/{checkout-sessions,payments,events}.ts`; `apps/web/src/server/db-errors.ts`; route handlers under `apps/web/src/app/api/v1/`; integration test files; `packages/db/scripts/verify-s2.ts` (read-only); `docs/S2-report.md`, `docs/state-machines.md`.
Modified: `schema.prisma`; `packages/core/src/index.ts`; `apps/web/src/proxy.ts`; `services/credentials.ts` (use `db-errors.ts`); `apps/web/tests/harness.ts` (§9.4); `docs/account-deletion-and-audit.md`; `.env.example` (remove the obsolete `TEST_DATABASE_URL` block, only if you approve touching env files).

## 8. Phases
1. Pure domain in `packages/core` with unit tests.
2. Migration SQL and Prisma schema written (no execution); `prisma generate` for types only.
3. Harness rework to satisfy §9 (unit-tested guards) **before any hosted write test exists**.
4. Server pipeline and services.
5. Route handlers, typecheck, `next build`.
6. Integration tests written, skipped by default.
7. Docs and report.
8. Separate approvals, in order: (a) read-only baseline against Hosted; (b) apply the S2 migration to Hosted, then read-only `verify-s2`; (c) run write tests against Hosted under §9.

## 9. Test environment and safeguards (R-DB-1)

### 9.1 Environment
Existing Hosted Supabase PostgreSQL (expected PostgreSQL 17; the major version is verified at runtime and the run aborts on mismatch). Tests connect through the session pooler or direct URL (port 5432), never the transaction pooler. No local Supabase, no Docker, no disposable database, no second project. Connection strings stay in the gitignored `.env` and are never printed.

### 9.2 Required safeguards
1. **Explicit target.** `SANDBOX_TEST_TARGET` must equal the exact flag value, and in addition the operator supplies the expected project ref in a separate variable. The flag alone is never sufficient authorization.
2. **Identity verification before any write**, using read-only queries on the actual connection: the project ref derived from the connection (pooler user `postgres.<ref>` or host) equals the expected ref; `current_database()` equals the expected name; `server_version_num` major is 17; the S1 objects (and, once applied, S2 objects) exist with the expected columns/constraints. Any mismatch aborts before the first write.
3. **No production or unverified database.** Unknown refs are refused. If a separate production project ever exists, its ref goes on a deny list in the harness and the run aborts on a match.
4. **Read-only verification is separate** from write tests: separate scripts/commands; the read-only path forces `default_transaction_read_only = on` and cannot be combined with write mode.
5. **Isolation.** Each run has a run id; every record belongs to test users created by that run, with unique identifiers (uuids, run-id-tagged external references).
6. **Cleanup only of own records**, by explicit id lists held by the run: delete only the test `auth.users` rows this run inserted (children cascade). Never `TRUNCATE`, `DROP`, schema/table drops, `DELETE` without an id-list predicate, or any reset; the harness contains no such statement and a unit test greps for them.
7. **Never touch existing data**: no UPDATE/DELETE of rows the run did not create; the real user's Auth account is never modified or deleted; before/after fingerprints of pre-existing `auth.users` and pre-existing rows in S1/S2 tables must match or the run reports failure.
8. **Permanent artifacts disclosed.** `audit_logs` rows written by tests are immutable and remain; the run reports how many it created.
9. **Migrations and mutating SQL** against Hosted need separate explicit approval each time; tests never run migrations.
10. **Bounded load**: pool size and parallelism capped so concurrency tests cannot exhaust pooler connections.
11. **Crash recovery without broad deletes**: created user ids are written to a local, gitignored run manifest before use, so an aborted run can be cleaned by a targeted, approved, id-listed script.

### 9.3 Decision D12 (revised)
Test environment: existing Hosted Supabase PostgreSQL only, PostgreSQL 17 subject to runtime verification, under 9.2. The earlier recommendation of a disposable Docker PostgreSQL 17 is **withdrawn** and may not be reintroduced (R-DB-1).

### 9.4 Harness gaps found before S2 (all closed during S2; the old harness did not enforce §9.2)
Resolution is recorded in the last column. The new harness is `apps/web/tests/harness.ts` plus `harness-safety.ts`, covered by `harness-guard.test.ts`.

| # | Gap in old harness | Required change | Resolution |
|---|---|---|---|
| G1 | A disposable mode exists (`TEST_DATABASE_URL`; creates and `DROP SCHEMA ... CASCADE` throwaway schemas, creates/drops an `auth` stub). Contradicts R-DB-1 and uses schema drops | Remove the mode and its env var; no schema creation or drops | Closed: disposable mode, schema creation and every `DROP SCHEMA` removed; `TEST_DATABASE_URL` is rejected |
| G2 | Hosted-dev mode is enabled by an environment variable alone (`SANDBOX_TEST_TARGET`) | Add the second, independent confirmation and identity checks (9.2 items 1-2) | Closed: flag plus `SANDBOX_TEST_EXPECTED_REF` plus live identity verification |
| G3 | No positive identity check: only port 5432 and presence of two tables. The primary project ref is used to *refuse* in the disposable path, not to confirm | Verify project ref, database name, PG 17, expected objects before writes | Closed: `verifyHostedIdentity` (ref from the connection, database name, PG 17, Supabase objects, migrations) |
| G4 | Aborts unless `api_credentials` is empty and `audit_logs` has an exact stated count; real credentials in the hosted DB would block every run, and the count is not recorded | Replace with baseline snapshot and fingerprint comparison of pre-existing rows; allow runs when real data exists | Closed: baseline snapshot and fingerprints instead of empty-table requirements (live baseline: 2 credentials, 47+ audit rows) |
| G5 | Only `api_credentials`/`audit_logs` are known; S2 tables absent | Extend baseline/fingerprint to S2 tables | Closed: leftovers in S2 tables are checked after cleanup |
| G6 | Test users are inserted as bare `auth.users(id)` with no run tag; only in-memory tracking, so a crash orphans them untraceably | Run-id manifest; optionally a recognizable non-routable email (D13) | Closed: tagged test emails and a write-ahead manifest (D13) |
| G7 | No separation of read-only verification from write mode inside the harness | Split entry points and enforce 9.2 item 4 | Closed: verification connection is forced read-only; writes use a separate connection; `verify:s2` is read-only |
| G8 | No unit test asserting the absence of `TRUNCATE`/`DROP`/unbounded `DELETE` | Add a static guard test | Closed: static guard test plus `assertSafeSql` on every raw statement |
| G9 | No pool/parallelism cap | Add cap | Closed: pool capped at 4, one run at a time via a database advisory lock |
| G10 | `.env.example` still documents `TEST_DATABASE_URL` and a throwaway-schema flow | Remove after approval to touch env files | Closed: `.env.example` rewritten |

## 10. Decisions requiring approval

| # | Decision | Recommendation |
|---|---|---|
| D1 | How payments get created before S3 | Service function only; no public route until S3 |
| D2 | Multiple payment attempts per session | Yes; session stays `open` after a decline and completes only on success; at most one pending/succeeded payment |
| D3 | Pending resolution without a worker | Lazy resolution on read plus an exported sweep function the S4 worker reuses |
| D4 | Preset `scenario` at creation | Locks the outcome the hosted page applies; when null the browser picks from the allowed list |
| D5 | Checkout token | Random token, hash stored; URL returned only on create and on replay (encrypted snapshot) |
| D6 | Currency scope | Curated allowlist of about 30 ISO 4217 codes with exponents |
| D7 | Limits | Amount 1 to 99,999,999 minor units; `expires_in` 5 min to 24 h, default 30 min; metadata ≤ 50 string keys (key ≤ 40, value ≤ 500); `external_reference` ≤ 255, not unique; 100 requests/min per user; idempotency key ≤ 255 chars, 24 h |
| D8 | `api_credentials.expires_at` | Add nullable column and enforce in auth; setting it is S3 |
| D9 | Public id format | `cs_`/`pay_`/`evt_` + uuid, no extra column |
| D10 | Event payload storage | Exact serialized text, not jsonb |
| D11 | Event read endpoints in S2 | Include `GET /events` and `/events/{id}` |
| D12 | Test environment | **Revised:** Hosted Supabase PostgreSQL only, under §9; Docker/local options withdrawn permanently |
| D13 | Marking test users | **Resolved:** harness-created `auth.users` rows get the run-tagged non-routable email `sbx-test-<runId>-<n>@sbx-test.invalid`, and the run writes a gitignored manifest of ids before use. Cleanup deletes only rows matching both an id from the manifest and that exact tag; interrupted runs are cleaned by `cleanup-test-run <runId>`, which matches only that run's tag. The real user can never match |

## 11. Assumptions
- The roadmap in `arch-plan.md` §20 and S0 §§6-8, as amended by user-level ownership, defines S2.
- The S1 hosted state is as in §2; counts are unmeasured.
- No new dependencies are needed.
- The checkout URL (`APP_URL/checkout/{token}`) returns 404 until S3.

## 12. Implementation notes (deviations and refinements from this plan)
- Amounts are accepted as decimal strings (`"149.00"`) and returned as `amount` (string) plus `amount_minor` (JSON-safe integer, maximum 10^12).
- D2/D3/D4/D5/D8/D10/D11 were implemented as recommended. Pending payments are resolved lazily and by an exported sweep; `pending` and `timeout` resolve only by operator action (`resolvePendingPayment`, for S3 scenario controls) or session expiry/cancellation.
- Checkout tokens: random, hash stored. Replay copies are sealed with AES-256-GCM using a key derived (HKDF-SHA256) from `SECRETS_ENCRYPTION_KEY` with the purpose `idempotency-checkout-token` and AAD `user|key|session`.
- Idempotency keys are claimed first in the same transaction as the session; the key row's FK to the session is `DEFERRABLE INITIALLY DEFERRED` for that reason. Only successful creations are stored; validation errors do not consume the key.
- Failed-authentication protection (not in the original plan): per-address pre-check, per-client-id and global post-failure counters in `auth_failure_windows` (30, 30 and 600 per minute); over-limit answers are 429.
- `auth_failure_windows` has no `user_id` by design (documented exception).
- Hosted-test hazards found: the operator using the dashboard while a run is active can change baseline rows and fail the post-run check (the harness reports which columns changed and never writes to them).
- Deployment note: client address comes from the first `X-Forwarded-For` hop; deploy behind a proxy that sets it, otherwise all clients share one failure bucket.
- Idempotency behaviour (as built): the key is `Idempotency-Key` (1-255 of `A-Za-z0-9_.:-`), scoped per user, accepted on `POST /api/v1/checkout/sessions` only (cancel is naturally idempotent). The fingerprint is SHA-256 over `METHOD\nendpoint\napi_version\ncanonical JSON body`. Same key and fingerprint replays the original status and body (including the checkout `url`) with `Idempotent-Replayed: true`; same key with a different fingerprint is `422 idempotency_key_reused`. Concurrent duplicates serialize on the unique index and replay. Keys older than 24 hours are treated as absent and replaced. Purging old rows is an S6 retention task.
- API errors: `{error:{type,code,message,param?,request_id}}`; types `authentication_error`, `invalid_request_error`, `conflict_error`, `rate_limit_error`, `idempotency_error`, `api_error`. 401s carry `WWW-Authenticate: Basic`; 429s carry `Retry-After`.
