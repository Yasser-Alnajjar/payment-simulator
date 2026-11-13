# S2 plan: payment simulator backend (PROPOSAL, revision 2; nothing implemented)

Status: planning only. No code, schema, migration, SQL, dependency, environment, Docker or Git change has been made for S2. Implementation waits for explicit approval.

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

## 2. Verified S1 state (from project records; nothing was queried for this revision)

| Item | Status | Source |
|---|---|---|
| Hosted project | One dedicated Supabase project, ref `yxyhgelnenqeulzxukrc`; PostgreSQL 17.11 observed at S1 inspection (re-verify at runtime) | `docs/S1-hosted-supabase.md` |
| S1 migration `20261113000000_s1_foundation` | **Applied** to the hosted `public` schema: tables `api_credentials`, `audit_logs`, plus `_prisma_migrations` | Operator statement that S1 is complete (2026-11-13); the hosted-dev harness mode requires both tables to exist. `docs/S1-hosted-supabase.md` previously said "nothing applied"; it is stale and has been corrected |
| Pre-migration default-privilege hardening and `_prisma_migrations` protection | Part of the S1 procedure; applied state **not recorded** in any document | Confirm with the read-only `verify-s1` script before S2 |
| Real Auth data | At least the operator's own account(s) from the real signup and email-verification test. Count not recorded | Operator statement |
| Test artifacts | The hosted-dev harness mode writes test users into `auth.users` (id only), credentials (cascade-deleted with those users) and **immutable `audit_logs` rows that cannot be removed**. The harness expects the operator to state the exact audit row count (`SANDBOX_TEST_EXPECT_AUDIT_ROWS`, default 0). Whether and how many such rows exist is **not recorded** | `apps/web/tests/harness.ts` header |
| Row counts of `api_credentials` / `audit_logs` / `auth.users` | **Unknown from documents.** Do not assume empty | Measure read-only first |

First S2 step after approval (read-only): run `verify-s1` and a counts/fingerprint query to record the baseline in `docs/S2-report.md`. That requires the operator's go-ahead since it connects to the hosted database.

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

### 9.4 Harness gaps (verified by reading `apps/web/tests/harness.ts`; required S2 implementation items)
The current harness does **not** fully enforce §9.2. Do not assume these protections exist.

| # | Gap in current harness | Required change |
|---|---|---|
| G1 | A disposable mode exists (`TEST_DATABASE_URL`; creates and `DROP SCHEMA ... CASCADE` throwaway schemas, creates/drops an `auth` stub). Contradicts R-DB-1 and uses schema drops | Remove the mode and its env var; no schema creation or drops |
| G2 | Hosted-dev mode is enabled by an environment variable alone (`SANDBOX_TEST_TARGET`) | Add the second, independent confirmation and identity checks (9.2 items 1-2) |
| G3 | No positive identity check: only port 5432 and presence of two tables. The primary project ref is used to *refuse* in the disposable path, not to confirm | Verify project ref, database name, PG 17, expected objects before writes |
| G4 | Aborts unless `api_credentials` is empty and `audit_logs` has an exact stated count; real credentials in the hosted DB would block every run, and the count is not recorded | Replace with baseline snapshot and fingerprint comparison of pre-existing rows; allow runs when real data exists |
| G5 | Only `api_credentials`/`audit_logs` are known; S2 tables absent | Extend baseline/fingerprint to S2 tables |
| G6 | Test users are inserted as bare `auth.users(id)` with no run tag; only in-memory tracking, so a crash orphans them untraceably | Run-id manifest; optionally a recognizable non-routable email (D13) |
| G7 | No separation of read-only verification from write mode inside the harness | Split entry points and enforce 9.2 item 4 |
| G8 | No unit test asserting the absence of `TRUNCATE`/`DROP`/unbounded `DELETE` | Add a static guard test |
| G9 | No pool/parallelism cap | Add cap |
| G10 | `.env.example` still documents `TEST_DATABASE_URL` and a throwaway-schema flow | Remove after approval to touch env files |

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
| D13 | Marking test users | Give harness-created `auth.users` rows a run-tagged non-routable email so orphans are identifiable for targeted, approved cleanup. Alternative: id-only rows with the local run manifest as the sole record |

## 11. Assumptions
- The roadmap in `arch-plan.md` §20 and S0 §§6-8, as amended by user-level ownership, defines S2.
- The S1 hosted state is as in §2; counts are unmeasured.
- No new dependencies are needed.
- The checkout URL (`APP_URL/checkout/{token}`) returns 404 until S3.
