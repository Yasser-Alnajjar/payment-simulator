# S4 report: webhooks and scheduler (2026-11-14)

Status (updated after the hosted phase): migration `20261114120000_s4_webhooks` **applied** to the hosted project and verified (`verify:s4`: all checks pass); hosted integration suite **159 passed, 0 failed, 0 skipped**. Scheduler setup (Vercel secret, `pg_cron`/`pg_net`, Vault, job) is tracked in §9.

## 1. What was built

**Merchant-facing**
- Webhook endpoints (`we_…`): create, list, get, update, soft-delete, rotate secret, send test event. Per-endpoint `whsec_…` secret, shown once (create / rotate / idempotent create replay), stored sealed (AES-GCM bound to purpose + `user|endpoint`). Rotation dual-signs for 24 h.
- Deliveries (`whd_…`): list, get (with attempt history), manual retry. One delivery per (event × endpoint), at-least-once, no ordering guarantee.
- Signed requests: `Sandbox-Signature` (`t=…,v1=…`, one `v1` per active secret), `Sandbox-Event-Id`, `Sandbox-Delivery-Id`, `Sandbox-Delivery-Attempt`, `Sandbox-Timestamp`. Body bytes are the exact stored event payload.
- Retry policy: 30 s × 2^(n-1), capped at 1 h, ±20 % jitter, `Retry-After` honoured (cap 1 h), default 8 attempts (1-12 per endpoint). 2xx success; 408/429/5xx and network errors retry; other 4xx and 3xx are permanent.
- Failure simulation per endpoint (`http_500`, `timeout`, `invalid_signature`, `duplicate`, `delay`, `out_of_order`), optional countdown for attempt-time modes; injected attempts are flagged in history.
- Dashboard: Webhooks list, endpoint detail, delivery detail (attempts, payload), create / controls / simulation / retry / one-time secret components, scheduler status with stale warning (> 3 min).
- Limits: 16 endpoints per user, 32 event types per endpoint, 10 test sends per endpoint per minute, 10 manual retries per user per minute.

**Infrastructure**
- `POST /api/scheduler/tick` (Next.js route, Node runtime, `maxDuration = 60`), called every minute by Supabase Cron through `pg_net`. Bearer secret (`SCHEDULER_TICK_SECRET`, optional `…_PREVIOUS` while rotating), constant-time compare, `404` with no body when unauthenticated or unconfigured.
- Tick: scheduler lease row in PostgreSQL → `sweepAll` (checkout sessions) → `sweepSetupAll` (setup sessions) → delivery loop (batches of 10, one delivery per endpoint per batch, concurrent) within a 25 s work budget.
- Outbox fan-out in `emitEvent`: inside the event's own transaction, one `pending` delivery per enabled, non-deleted, subscribed endpoint of the event owner (single `INSERT … SELECT … ON CONFLICT DO NOTHING`). Sending happens only in the tick.
- SSRF-safe sender (see §4). No new npm dependencies; one new Vercel env var.

## 2. Changed and new files

**Modified (25)**: `.env.example`; `apps/web/modules/dashboard/index.ts`, `…/shell/csr/DashboardShell.tsx`; `apps/web/src/actions/namespaces.ts`, `src/components/ui/form.tsx`, `src/lib/env.ts` (Vercel `APP_URL` fallback), `src/proxy.ts` (matcher excludes `api/scheduler/`), `src/server/api/{deps-default,deps,dto,handlers,validation}.ts`, `src/server/lifecycle.ts` (`emitEvent` fan-out, `sweepAll` per-session isolation returning `{settled, failed}`), `src/server/services/{api-idempotency,dashboard,setup-sessions}.ts` (adds `sweepSetupAll`); `apps/web/tests/{api-boundary.test,api-helpers,harness}.ts`; `packages/core/src/{ids,index,state-machine}.ts`; `packages/db/package.json` (`verify:s4`), `prisma/schema.prisma`, `scripts/dry-run-migration.ts` (allows the one reviewed scope-check widening).

**New**
- Core: `packages/core/src/webhook{s,-retry,-signature,-ssrf}.ts`, `webhooks.test.ts`.
- Server: `apps/web/src/server/webhooks/{config,engine,fanout,scheduler,sender,tick-deps-default,tick-handler}.ts`, `src/server/services/webhooks.ts`, `src/actions/webhooks.ts`, `src/lib/types/webhook.ts`.
- Routes: `src/app/api/scheduler/tick/route.ts`; `src/app/api/v1/webhook-endpoints/{,[endpointId]/,[endpointId]/rotate-secret/,[endpointId]/test/}route.ts`; `src/app/api/v1/webhook-deliveries/{,[deliveryId]/,[deliveryId]/retry/}route.ts`.
- UI: `src/app/webhooks/{page.tsx,[id]/page.tsx,deliveries/[id]/page.tsx}`, `modules/dashboard/webhooks/**`.
- Tests / scripts: `apps/web/tests/{webhooks,webhook-sender,scheduler-tick-route}.test.ts`, `apps/web/scripts/e2e-receiver.ts`, `packages/db/scripts/verify-s4.ts`.
- DB / ops / docs: `packages/db/prisma/migrations/20261114120000_s4_webhooks/migration.sql`, `packages/db/ops/003_s4_scheduler.sql`, `docs/{S4-plan,S4-rollback.sql,scheduler-setup,webhooks,S4-report}`.

## 3. Migration `20261114120000_s4_webhooks` (written, NOT applied)

- Requires `20261113200000_payment_methods`.
- **Existing objects touched (3):** new UNIQUE index `events(id, user_id)`; `events_type_check` re-created with `webhook_endpoint.test` added (`NOT VALID` then `VALIDATE`); `api_idempotency_keys_scope_check` re-created with `webhook_endpoint.create` added. No existing row is modified. No `TRUNCATE`, no `DELETE`, no table drop.
- **New tables (4):** `webhook_endpoints`, `webhook_deliveries`, `webhook_delivery_attempts`, `scheduler_leases` (seeded with row `tick`; name check also allows `test-<12 hex>` for hosted tests).
- **Integrity:** composite FKs `(event_id,user_id)`, `(endpoint_id,user_id)`, `(delivery_id,user_id)` make a cross-tenant link impossible; UNIQUE `(event_id, endpoint_id)`; UNIQUE `(delivery_id, attempt_no)`; lease and terminal-state CHECKs; owner FKs cascade from `auth.users`. Triggers: endpoint identity immutable and `version` +1 per change; delivery identity immutable, cancelled is final, finished only re-armable by manual retry, `attempt_count` cannot decrease; attempts append-only (UPDATE and TRUNCATE rejected).
- **RLS / grants:** RLS enabled on all four tables, no policies, all privileges revoked from `anon`, `authenticated`, `service_role` (tables, sequences, trigger functions), trigger functions `search_path = ''`. Same pattern as S1/S2.
- **Rollback:** `docs/S4-rollback.sql` (outside the migrations folder). Forward fixes preferred.
- **Scheduler ops SQL** (`packages/db/ops/003_s4_scheduler.sql`, not a Prisma migration): `pg_cron`/`pg_net`, two Vault secrets, job `sandbox-scheduler-tick` every minute with `timeout_milliseconds := 55000`, created **inactive**, plus a daily 7-day cron-history cleanup.

## 4. Final review (this session)

### 4.1 Verified as correct
- **Fan-out (`emitEvent`)**: same transaction as the event insert; selects endpoints by the event's own `user_id`; idempotent (`ON CONFLICT DO NOTHING`); never reads endpoint URL, secret or config validity, only `status`, `deleted_at`, `enabled_events`, `failure_mode`, `failure_delay_seconds` (all DB-CHECK-constrained). `webhook_endpoint.test` is never fanned out. Locking: the insert's FK checks take `FOR KEY SHARE` on endpoint rows, which only waits for a concurrent endpoint edit/delete (`FOR UPDATE`, short, transaction-timeout bounded); no lock cycle with the session row lock was found. The engine's own endpoint update uses a non-key update and does not conflict.
- **Claiming**: one atomic statement, `FOR UPDATE SKIP LOCKED`, fresh `lease_token` per claim, attempt number fixed at claim time, at most one delivery per endpoint per batch, only enabled and non-deleted endpoints. Lease uses the database clock.
- **Stale workers**: result recording changes the delivery only `WHERE lease_token = <claimed token>`; a late result is stored as an attempt with `stale = true` and changes nothing; abandoned attempts are back-filled; `(delivery_id, attempt_no)` is unique. Soft delete cancels pending deliveries and clears the lease.
- **SSRF**: https only, port allowlist, no credentials/fragments, WHATWG normalisation of numeric-IPv4 tricks, blocked name suffixes, IPv4 deny-list plus IPv6 allow-only-2000::/3 minus special blocks, **every** DNS answer checked (mixed answers refused), connection pinned to the validated address via a fixed `lookup` (TLS SNI/Host keep the original name), URL re-validated on every attempt, redirects never followed (3xx = permanent failure), 256 KB response read cap, 1 KB excerpt (control characters stripped), 16 KB header cap, no keep-alive, refuses `NODE_USE_ENV_PROXY`.
- **Scheduler auth**: bearer only, SHA-256 digest + `timingSafeEqual` against every configured secret without early exit, secrets < 32 chars treated as unset, header length capped, no body/params used, 404 with empty body on any failure, excluded from the dashboard proxy. Summary response contains counts only.
- **Tenant isolation**: every service query is scoped by `{id, userId}` (another tenant's id is "not found"); dashboard actions take the user from the session only; the engine always joins and filters on matching `user_id`; DB composite FKs enforce it independently of app code; RLS + revoked Data API roles deny all non-server access.
- **Route path**: `POST /api/scheduler/tick` is the only path in code, `proxy.ts`, tests, env example, ops SQL and all docs. A repository-wide search for `internal/scheduler` returns **0** matches.
- **Function limit**: `export const maxDuration = 60` in the route file; the production build's `functions-config-manifest.json` lists `"/api/scheduler/tick": { "maxDuration": 60 }`. No `vercel.json` is needed. Timing chain (see §4.3) is consistent.

### 4.2 Defects found and fixed in this review
1. **Poison-delivery loop (high).** If building a request threw locally (e.g. the sealed secret could not be opened after an `SECRETS_ENCRYPTION_KEY` mistake), the attempt was never recorded; the lease expired and the delivery was re-claimed every minute with `attempt_count + 1`, forever, until the `attempt_count <= 1000` CHECK failed inside the **claim statement and broke claiming for every delivery**. Fix: `processDelivery` now records such an exception as a permanent attempt (`unknown_error`, generic excerpt).
2. **Unbounded attempt counter on crash loops (medium).** A delivery whose last allowed attempt was claimed but never recorded (killed function) could be claimed again beyond `max_attempts`. Fix: `claimDeliveries` first marks such deliveries `failed` (`lease_lost`), manual retries exempt.
3. **DNS lookup had no timeout (medium).** `getaddrinfo` ran before the request timers, so a hanging resolver could exceed the 10 s send limit and the tick budget. Fix: 5 s DNS bound (`dnsMs`) → `dns_error` (retryable). Worst-case send is now 5 s + 10 s, so the tick stops claiming when < **15 s** (was 12 s) of the 25 s budget remains. Docs updated.
4. **Private-target allowance defaulted open on an unset `APP_ENV` (medium).** `APP_ENV` defaults to `development`, so `ALLOW_PRIVATE_WEBHOOK_TARGETS=true` on a hosted deployment that forgot `APP_ENV` would have disabled SSRF protection. Fix: refused whenever `VERCEL` is set or `NODE_ENV=production`.
Tests added for 3 and 4. Items 1 and 2 are database-path changes and are covered only by the hosted integration tests (not yet run).

### 4.3 Timing chain
| Element | Value | Relation |
|---|---|---|
| Delivery send | ≤ 5 s DNS + ≤ 10 s exchange | worst case 15 s |
| Tick work budget | 25 s (no new batch if < 15 s left) | last batch ends ≈ 25 s |
| `pg_net` timeout | 55 s | > 25 s work, < 60 s function |
| Function `maxDuration` | 60 s (explicit, in build manifest) | hard platform kill |
| Delivery lease | 60 s | > 15 s send + recording |
| Scheduler lease | 90 s | > `maxDuration`: a killed tick blocks at most ~1 extra minute |

The sweeps run **before** the delivery loop and are bounded by count (100 + 100 sessions, each its own transaction), not by time. If they take > 10 s the tick simply claims no deliveries that minute (they are picked up next minute); they cannot push a started batch past its budget.

### 4.4 Existing payment flows: can webhook configuration or fan-out make them fail?
- **Endpoint configuration cannot.** Fan-out never parses URLs, decrypts secrets or contacts a receiver; a bad, unreachable, slow or disabled endpoint only changes delivery rows later, in the tick. Endpoint validation (SSRF rules, event list, simulation shape) happens when the endpoint is written, never at payment time.
- **Delivery volume is bounded**: at most 16 endpoints per user, so at most 16 extra rows per event, in one statement.
- **What can still fail a payment**: the fan-out statement shares the payment transaction, so a database-level failure of that statement (statement timeout, connection loss) rolls the payment back, exactly like the event insert beside it. The one deterministic case is **deploy ordering**: if the new application code runs against a database without the S4 migration, `webhook_deliveries` does not exist and **every event-emitting payment flow fails**. The migration must be applied and `verify:s4` must pass **before** this code is deployed (also true for the `events_type_check` widening). I deliberately did not wrap the fan-out in a savepoint that swallows errors: that would silently lose webhooks; I can add it if you prefer availability over delivery guarantees.
- **Not verified**: the fan-out SQL (types of `make_interval`, `ANY (enabled_events)`, `ON CONFLICT` target) has never executed against PostgreSQL, because rule R-DB-1 forbids a local database. See §7.

## 5. Test results (local, no database access)
| Suite | Files | Tests |
|---|---|---|
| `packages/core` unit | 4 passed | **128 passed** |
| `apps/web` default (no hosted target) | 8 passed, 10 skipped | **61 passed**, 98 skipped (hosted tests, **not** counted as passed) |
| `packages/db` | none | n/a |
| `pnpm -r typecheck` | core, db, web | pass |
| `next build` | | pass; `/api/scheduler/tick` and all 7 webhook API route files built; manifest `maxDuration: 60` |

Covered locally: signatures (tamper, wrong secret, tolerance, dual secret), retry schedule and classification, the SSRF table (range boundaries, mapped forms, URL tricks, ports, hostnames), sender (2xx, 500, timeout, oversized body, redirect, refused connection, mixed/private DNS, rebinding stub, DNS failure and DNS timeout, proxy refusal), tick auth (missing/malformed/wrong/rotating secret, unset → 404), private-allowance rules. **Not run**: all hosted integration tests (fan-out atomicity, concurrent claimers, concurrent ticks, lease expiry, stale results, retries to success/exhaustion, soft delete, cross-user isolation on the new routes, cascade), `verify:s4`, migration dry-run, E2E tunnel test.

## 6. Known limitations
- Latency: first attempt happens at the next tick (up to ~60-80 s after the event); not real-time.
- At-least-once with no ordering guarantee; no events for endpoints created later; no replay of earlier events.
- No auto-disable of failing endpoints; failed deliveries stay failed unless manually retried (a failed manual attempt does not restart the schedule).
- A disabled or deleted endpoint between claim and send consumes one recorded attempt.
- `failure_mode_remaining` applies only to attempt-time modes; `delay`/`out_of_order` last until changed.
- No retention purge for webhook tables (S6); ~1.5 KB per attempt row (100 000 attempts ≈ 150 MB on the 500 MB Free plan).
- `api_credentials.webhook_secret_enc` (S1 "Webhook secret" on the Credentials page) is **not** used for signing; each endpoint has its own secret.
- `GET /api/scheduler/tick` returns Next's `405` (reveals the route exists, nothing else); only authenticated `POST` does work.
- Sweeps are bounded by count, not time (§4.3).
- Payment-method, setup-session and charge paths still lack hosted integration tests (deferred since S2).

## 7. Remaining risks and unverified assumptions
1. **Fan-out SQL and the claim/reaper SQL are unexecuted** (`$executeRaw`/`$queryRaw` with `make_interval`, `ANY`, `DISTINCT ON … FOR UPDATE SKIP LOCKED`, the new exhaustion `UPDATE … FROM`). Type or syntax errors would surface only on first hosted run; mitigated by running hosted tests **before** deploying the code to production.
2. **Deploy order is a hard requirement** (migration → `verify:s4` → deploy; §4.4). Rollback by redeploying the previous build is safe only while the S4 tables remain.
3. **Vercel limits**: I rely on the route-level `maxDuration = 60` being honoured on your plan (the comment in the code says Hobby allows up to 300 s; I could not confirm your project's plan or whether Fluid Compute is enabled). Check the first production tick's `duration_ms`.
4. **Supabase Free**: project pausing after inactivity stops cron; `pg_net` is beta and its queue is lost on a database crash (a lost tick is harmless). Whether `pg_cron`/`pg_net` are installed on the hosted project is unknown until `verify:s4 --baseline`.
5. **Secrets**: `SCHEDULER_TICK_SECRET` must be identical on Vercel and in Vault; anyone with database-owner access can read Vault (already full access).
6. **Hosted latency stalls** seen in S2 (15-19 s transaction stalls) could delay ticks or trip transaction timeouts; the lease and per-session isolation tolerate it.
7. **E2E tunnel** (planned) uses a third-party service; only test payloads would pass through it.
8. The tests share the hosted database with the operator's use: do not use the dashboard during hosted test runs, and pause the cron job first (the harness refuses otherwise).

## 8. Proposed first hosted operations (nothing done; awaiting approval, each separately)
1. `pnpm --filter @sandbox/db verify:s4 -- --baseline` (read-only: identity, migration history, extension availability, size, counts).
2. Migration dry-run in a rolled-back transaction (`dry-run-migration.ts 20261114120000_s4_webhooks`).
3. Apply the migration with `prisma migrate deploy`; run `verify:s4` (read-only).
4. Hosted integration tests (cron not yet configured, so nothing else is running).
5. Set `SCHEDULER_TICK_SECRET` on Vercel, deploy; then, by you or on approval, run `003_s4_scheduler.sql` (job inactive), manual tick check, E2E receiver test, then enable the job.

## 9. Hosted phase log (2026-11-14)
1. `verify:s4 --baseline`: identity, prerequisites and extension availability confirmed (pg_cron 1.6.4, pg_net 0.20.4, supabase_vault 0.3.2 installed).
2. Dry-run (`BEGIN … ROLLBACK`): ran cleanly, 12 → 16 → 12 public tables, nothing persisted.
3. `prisma migrate deploy`: applied only `20261114120000_s4_webhooks` (exactly one history row, finished, not rolled back). `verify:s4`: all checks pass.
4. Hosted integration tests (flag `hosted-s2-2026-11-13` + expected project ref; harness verifies live identity; Cron not installed):
   - First `webhooks.test.ts` run: 15 passed, 1 failed. Cause: a **test** defect, the rotation test verified signatures made with the fake test clock against the real clock (`timestamp_out_of_tolerance`). Fixed by passing the same clock to the verifier; the assertions are unchanged in strictness.
   - First full run exposed 3 more failures in older tests, none caused by webhooks: stale expectations from the payment-methods migration (checkout view gained `customer`/`cardAllowed`/`savedCards`; unique index renamed to `events_user_subject_type_occurrence_key`) and my `sweepAll` return type change (`{settled, failed}`). Tests updated to the current behaviour (exact full view shape, new index name, `settled >= 1` and `failed == 0`).
   - A schema test then asserted exactly 4 guard functions; the schema legitimately has 9 (4 + 2 payment-methods + 3 S4, all `search_path=''`). The assertion now lists the 9 names exactly.
   - **Final full run: 18 files, 159 tests passed, 0 failed, 0 skipped.** Every run's harness reported its test users removed and the pre-existing user, 3 credentials and all earlier audit rows unchanged.
5. After the runs (read-only): users 1, credentials 3, sessions 5, payments 18, events 33, payment methods 3, setup sessions 3, idempotency keys 2 (all as before); S4 tables empty; `scheduler_leases` only the free `tick` row (never started); `pg_cron`/`pg_net` not installed. The only permanent test residue is immutable audit rows (by design).
6. Not covered by the hosted suite: the Vercel-hosted route and the Supabase Cron → `pg_net` path (covered by the scheduler end-to-end steps).
