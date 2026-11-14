# S4 plan: webhook infrastructure (revision 4: APPROVED 2026-11-14; IMPLEMENTED in code, not yet applied to the hosted database; see `docs/S4-report.md` and §11)

> **Rule R-DB-1: Hosted Supabase Only — No Local Supabase.** Authoritative text in `arch-plan.md` (top of file). Every database test runs against the existing Hosted database under `docs/S2-plan.md` §9; no database URL, password or key appears in logs, reports, commits or docs.

**Revision 4 (operator decision, 2026-11-14): Supabase Cron (`pg_cron`) is the only scheduler.** Every minute it calls a protected Vercel endpoint that runs bounded batches of webhook deliveries, `sweepAll` and setup-session expiry using the existing server code. No Vercel Cron, no independently hosted worker, no Docker, no Redis or queue, no paid service, no new recurring cost. PostgreSQL remains the source of truth for delivery state, claiming, leases, attempts, retries and recovery. Revision 3's Fly.io worker, Dockerfile and `worker_heartbeats` are withdrawn. Non-negotiable: payment correctness, tenant isolation, idempotency, SSRF protection, and separate approval for every hosted database operation.

## 1. Scope

In: endpoint management (API and dashboard), event-to-delivery fan-out, the scheduled tick (Supabase Cron → Vercel), HMAC-SHA256 signatures, retries with attempt history, manual retry, SSRF protection, per-endpoint failure simulation, dashboard integration, scheduler setup SQL and instructions, end-to-end verification against the deployed Vercel app.

Out: OpenAPI and public docs (S5); retention purge of webhook tables (S6); everything in §3.

## 2. Minimum S3 fixes before S4 (blockers only)

| # | Fix | Why it blocks |
|---|---|---|
| F1 | `tests/api-boundary.test.ts`: assert every route file wraps `handlers.*` instead of a fixed count of 7 (there are 12, all verified thin wrappers). | Suite is red; S4 adds routes. |
| F2 | Verify the payment-methods migration (`20261113200000_payment_methods`) is applied, in the read-only hosted check (§8 step 2), before writing the S4 migration on top of it. If missing, applying it is a separate approval. | S4 alters `events`, which that migration changed. |
| F3 | Harness baseline and leftover checks cover `payment_methods`, `setup_sessions`, `api_idempotency_keys` and the S4 tables. | Hosted write tests must prove real data is untouched. |
| F4 | `sweepAll`: per-session error isolation (catch, log, skip this tick). | Called every minute by the tick; one failing session would otherwise block all settlement forever. |
| F5 | `sweepSetupAll` (same row-lock pattern as `settleSetup`). | Expired setup sessions are only expired when read, so their `checkout.session.expired` webhook would never be sent. |

F4/F5 do not change any state machine; the session row lock plus re-check, and the events unique index, still prevent double events.

## 3. Deferred S3 items (not blocking S4)

- Integration tests for payment methods, setup sessions and saved-card charges (only unit tests in `packages/core/src/cards.test.ts`). Risk: their isolation, idempotency and concurrency are unverified by tests. Recommended right after S4.
- Read-only verify script for the payment-methods migration (F2 is a one-off check).
- `docs/payment-methods.md` (referenced by the migration, missing), state-machine docs for payment methods/setup/charges, `docs/S3-report.md`.
- Dashboard: credential `expires_at` setting (enforced by the API already), payment detail page, events view.

## 4. Platform verification (2026-11-14)

### 4.1 Checked in official documentation

| Platform | Fact | Source |
|---|---|---|
| Vercel Hobby | Function max duration 300 s (default and maximum, Fluid compute); memory 2 GB / 1 vCPU (not configurable on Hobby) | vercel.com/docs/functions/limitations |
| Vercel Hobby | Monthly included: 1,000,000 function invocations; **4 h Active CPU**; **360 GB-hrs provisioned memory**; 10 GB Fast Origin Transfer; 100 GB Fast Data Transfer. Hobby has no pay-as-you-go; usage limits can pause a Hobby project. | vercel.com/docs/limits/fair-use-guidelines, vercel.com/docs/limits |
| Vercel Hobby | Active CPU counts only CPU actually used; waiting on I/O (database, HTTP) does not count | vercel.com/docs/functions/limitations |
| Vercel Hobby | Runtime logs kept 1 hour | vercel.com/docs/limits |
| Supabase Cron | Schedules from every second to once a year; recommended ≤ 8 concurrent jobs and ≤ 10 min per job; jobs can run SQL or make HTTP requests | supabase.com/docs/guides/cron |
| Supabase Cron | `cron.job_run_details` grows with every run and is never cleaned automatically; Supabase recommends a scheduled cleanup | supabase.com/docs/guides/cron/quickstart |
| `pg_net` | Asynchronous; the request is sent only after the calling transaction commits; **default timeout 2000 ms** (configurable per call); ~200 requests/s; responses kept in unlogged `net._http_response` for 6 h; supports custom headers; beta | supabase.com/docs/guides/database/extensions/pg_net |
| Supabase Free | 500 MB database per project; 5 GB egress; 2 active projects; **projects are paused after 1 week of inactivity** (the page does not define activity) | supabase.com/pricing |

### 4.2 Not yet verified (needs your read-only approval, §8 step 2)
- **Whether `pg_cron`, `pg_net` and `supabase_vault` are available and/or already installed on our project, and their versions.** Supabase's own pages above do not state plan availability; third-party guides say `pg_cron` is on all plans including Free. Verified only by a read-only query: `SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name IN ('pg_cron','pg_net','supabase_vault')`. The plan tier itself (Free or paid) is shown in your Supabase dashboard; please confirm it.
- Whether a running cron job counts as "activity" for Free-plan pausing. Treated as a risk (§10), not assumed.
- Vercel Hobby's non-commercial-use restriction is from my knowledge of Vercel's terms, not rechecked today.

### 4.3 Budget at one tick per minute (43,200 ticks/month)

| Resource (Hobby allotment) | Idle tick (~1 s wall, ~50 ms CPU) | Busy tick (25 s budget, ~300 ms CPU) |
|---|---|---|
| Invocations (1M) | 43,200 = 4.3 % | same |
| Active CPU (4 h) | ≈ 0.6 h = 15 % | ≈ 3.6 h if *every* tick were busy |
| Provisioned memory (360 GB-hrs, 2 GB) | ≈ 24 GB-hrs = 7 % | ≈ 600 GB-hrs if *every* tick were busy: **over the allotment** |

Conclusions and decisions: one tick per minute (not sub-minute); a tick exits immediately when there is nothing due; the per-tick work budget is **25 s**, so only sustained, continuous load (deliveries queued every minute all month) could exceed Hobby's memory allotment. The tick returns a summary and the dashboard shows tick duration so usage can be watched; check Vercel's usage page after the first day. Estimates are mine, not Vercel's: Fluid compute instance reuse and cold-start CPU (Prisma client init) may move them either way.

## 5. Final architecture

```
Supabase Cron (pg_cron, every minute)
   └─ net.http_post(URL and secret read from Supabase Vault, timeout 55 s)   [async, after commit]
          │
          ▼
Vercel: POST /api/scheduler/tick      (Node runtime, maxDuration 60 s, secret-protected)
   1. acquire scheduler lease in PostgreSQL (skip if another tick holds it)
   2. sweepAll(≤100) + sweepSetupAll(≤100)        (existing row locks)
   3. loop until 25 s budget: claim ≤10 due deliveries (FOR UPDATE SKIP LOCKED, lease token)
         → SSRF-checked HTTPS POST pinned to the validated IP (concurrency 5, 10 s max each)
         → record attempt + next retry in one transaction (fenced by lease token)
   4. release scheduler lease, store summary, return JSON summary
          │
          ▼
Hosted Supabase PostgreSQL: deliveries, attempts, leases, retries (source of truth)
```

- **Web requests** (API, dashboard, hosted checkout) are unchanged apart from fan-out: when an event is saved, one `INSERT ... SELECT` in the same transaction creates its delivery rows. No request ever sends a webhook.
- **Connection:** the tick uses the existing `DATABASE_URL` (transaction pooler). Every coordination primitive is a single SQL statement or a short transaction with row locks; **no session-level advisory locks**, which are unsafe behind the transaction pooler.
- **Latency:** a webhook is first attempted at the next tick, i.e. within ~60-80 s of the event. Retries are effectively rounded up to the minute. Acceptable for this testing phase; documented.
- **Throughput:** ~20-50 deliveries per tick depending on receiver speed (concurrency 5, 10 s timeout, 25 s budget). Backlogs drain over subsequent ticks.

### 5.1 The tick endpoint
- `POST /api/scheduler/tick`, `runtime = "nodejs"`, `maxDuration = 60`, `dynamic = "force-dynamic"`. Excluded from `proxy.ts` (today's matcher excludes only `api/v1/` and `checkout/`; without this, cron calls would be redirected to `/login`). Not part of the merchant API (no Basic auth, no CORS).
- **Authentication:** `Authorization: Bearer <SCHEDULER_TICK_SECRET>`; secret ≥ 32 random bytes; constant-time comparison of SHA-256 digests; missing or wrong secret → `404` with no body (does not advertise the route). If the env var is unset or too short the route always returns 404. GET and other methods → 405.
- **Only one Vercel env var is added: `SCHEDULER_TICK_SECRET`.** The same value is stored in Supabase Vault for the cron job. Rotation: put the new value in Vault and Vercel; the route accepts `SCHEDULER_TICK_SECRET_PREVIOUS` too while you rotate.
- **Body:** ignored. The endpoint takes no parameters, so a leaked secret can only trigger work that would run anyway within a minute.
- **Response:** JSON summary (`{skipped?, swept, setup_swept, claimed, succeeded, retrying, failed, duration_ms}`), stored by `pg_net` for 6 h for debugging and also written to the scheduler row.

### 5.2 Preventing overlapping executions and duplicate processing
Three independent layers:
1. **Scheduler lease (avoids overlapping ticks).** New single-row table `scheduler_leases(name PK, lease_token, locked_until, last_started_at, last_finished_at, last_summary jsonb)`. A tick acquires with `UPDATE scheduler_leases SET lease_token = gen_random_uuid(), locked_until = now() + interval '90 seconds', last_started_at = now() WHERE name = 'tick' AND (locked_until IS NULL OR locked_until < now()) RETURNING lease_token`. 0 rows → return `{skipped: "busy"}`. Release is fenced by the token. A tick killed by Vercel's timeout leaves the lease to expire after 90 s (> `maxDuration` 60 s), so the next-but-one tick proceeds. pg_cron's own "one run at a time" does not help here because the cron job only enqueues an async HTTP request and finishes in milliseconds.
2. **Delivery claims (prevents duplicate processing even if two ticks or a manual run overlap):** single-statement claim with `FOR UPDATE SKIP LOCKED`, a per-claim `lease_token`, 60 s lease, attempt number fixed at claim time (§5.3).
3. **Settlement:** `sweepAll`/`sweepSetupAll` lock each session row and re-check status; the events unique index is the last line of defence. Concurrent lazy settlement from web requests stays safe.

### 5.3 Delivery claiming, leases and recovery (database clock)
```sql
UPDATE webhook_deliveries d
   SET lease_token = gen_random_uuid(), locked_until = now() + interval '60 seconds',
       attempt_count = d.attempt_count + 1, updated_at = now()
  FROM (SELECT id FROM webhook_deliveries
         WHERE status IN ('pending','retrying') AND next_attempt_at <= now()
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT $n) c
 WHERE d.id = c.id
RETURNING d.*;
```
- The tick stops claiming when less than 15 s of its 25 s budget (raised from 12 s in the final review, when DNS got its own 5 s bound) remains, so every claimed send finishes well inside the function's 60 s and the 60 s lease.
- HTTP sends run outside any transaction. Recording is one transaction: insert the attempt row; update the delivery `WHERE id = $id AND lease_token = $token`. If the lease was lost (0 rows), the attempt is stored with `stale = true` and does not change state.
- **Crash or Vercel timeout mid-send:** the delivery's lease expires; the next claim first writes an `abandoned` attempt row for the unrecorded attempt (outcome unknown; the receiver may have received it), which counts toward `max_attempts`, then retries.
- UNIQUE `(delivery_id, attempt_no)` prevents double recording.
- **Manual retry:** one conditional update to `retrying`, `next_attempt_at = now()`, `manual_pending = true`, allowed from `failed`/`succeeded`/`retrying` when not leased; leased → `409 delivery_in_progress`; already queued → unchanged (idempotent). Sent at the next tick. A failed manual attempt returns the delivery to `failed`. 10 per user per minute.
- Ordering is not guaranteed (documented).

### 5.4 Idempotency contract
Event id `evt_…` stable across endpoints and attempts; delivery id `whd_…` one per event × endpoint (UNIQUE `(event_id, endpoint_id)`); every attempt sends the identical stored `events.payload` bytes; only timestamp and signature change. **At least once:** a receiver can see an event twice when our 10 s timeout fires after it processed the request, when a tick is killed or a lease lost between send and record, on manual retry, or in `duplicate` simulation. Receivers verify the signature, then deduplicate on the event `id` from the verified body (unsigned headers must not be used for dedupe).

### 5.5 Signatures
`Sandbox-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`, `v1 = HMAC_SHA256(secret, t + "." + raw_body)`; headers `Sandbox-Event-Id`, `Sandbox-Delivery-Id`, `Sandbox-Delivery-Attempt`, `Sandbox-Timestamp`, `Content-Type: application/json`, `User-Agent: SandboxPayments-Webhooks/1`. Secret `whsec_` + 32 random bytes, sealed with `sealBound` (purpose `webhook-endpoint-secret`, context `user|endpoint`) using the existing `SECRETS_ENCRYPTION_KEY` already on Vercel; shown once on create and rotate; both secrets sign for 24 h after rotation. Verifier in `packages/core` (constant time, 300 s tolerance).

### 5.6 SSRF protection (create/update and before every attempt)
Unchanged from revision 3; it runs in the Vercel Node runtime, which supports custom `lookup` and TLS `servername`.
- URL: `https` only (plus `http` with the development allowance); no userinfo or fragment; ≤ 2048 chars; port 443, 80 or 1024-65535; hostname not `localhost`/`*.localhost`/`*.local`/`*.internal`/`*.intranet`/`*.home.arpa`/`*.lan`/`*.corp`, not single-label, not a blocked IP literal (after WHATWG normalization of `0x7f.1`, `2130706433`, `127.1`, IDN).
- IPv4 blocked: `0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.31.196/24, 192.52.193/24, 192.88.99/24, 192.168/16, 192.175.48/24, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4, 255.255.255.255`. IPv6 allowed only inside `2000::/3` and outside `2001::/23, 2001:db8::/32, 2002::/16, 3fff::/20, 64:ff9b::/96, 64:ff9b:1::/48`; `::`, `::1`, mapped/compatible IPv4, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, `100::/64` blocked.
- DNS rebinding: `dns.lookup({all:true})` per attempt; any blocked address → refused; connect via a custom `lookup` returning only the validated address; TLS `servername` = hostname with full verification.
- No redirects (3xx = permanent `redirect_not_followed`); dedicated agent, no keep-alive; refuse to send if `NODE_USE_ENV_PROXY` is set; connect 5 s, total 10 s; `maxHeaderSize` 16 KB; response read ≤ 256 KB, 1 KB stored; fixed headers; history shows error codes, never resolved internal IPs.
- `ALLOW_PRIVATE_WEBHOOK_TARGETS=true` honoured only with `APP_ENV=development`, refused otherwise; tests inject `allowPrivate` instead.

### 5.7 Retry policy
`min(30 s × 2^(n-1), 1 h)` ±20 % jitter (effective granularity: one tick); default 8 attempts, per endpoint 1-12. Retry: timeout, connect/TLS/DNS error, `abandoned`, 408, 429 (`Retry-After` ≤ 1 h), 5xx. Permanent: other 4xx, 3xx, `ssrf_blocked`, invalid URL. No auto-disable; dashboard warns after 3 consecutive failed deliveries.

### 5.8 Failure simulation (per endpoint, owner-set, audited, default `none`)
`http_500` and `timeout` (recorded without a network call, retried by policy), `invalid_signature` (random key), `delay` (first attempt scheduled 1-300 s later), `duplicate` (same request sent twice in one attempt), `out_of_order` (random 0-N s scheduling delay). Optional `failure_mode_remaining` countdown. No env var or global switch can enable simulation; injected attempts are flagged in history; the endpoint shows a banner.

### 5.9 Schema (one Prisma migration `<ts>_s4_webhooks`, written only; additive)
- `events`: add UNIQUE `(id, user_id)` (tenant-safe composite FKs); widen `events_type_check` with `webhook_endpoint.test` (`NOT VALID` then `VALIDATE`).
- `webhook_endpoints`: `id`, `user_id`, `seq`, `url` (≤ 2048), `description` (≤ 500), `enabled_events text[]` (1-32, `{*}` = all), `status`, `secret_sealed`, `previous_secret_sealed` + `previous_secret_expires_at` (both or neither), `max_attempts` (1-12), `failure_mode`, `failure_mode_remaining`, `failure_delay_seconds`, `version`, timestamps, `deleted_at`. UNIQUE `(id, user_id)`; indexes `(user_id, seq DESC)`, partial `(user_id) WHERE status = 'enabled' AND deleted_at IS NULL`. 16 live endpoints per user.
- `webhook_deliveries`: `id`, `user_id`, `seq`, composite FKs `(event_id, user_id)`, `(endpoint_id, user_id)` with cascade, `status` (`pending`/`retrying`/`succeeded`/`failed`/`cancelled`), `attempt_count`, `next_attempt_at`, `lease_token` + `locked_until` (both or neither), `manual_pending`, `last_status_code`, `last_error_code`, `completed_at`, timestamps. CHECK terminal ⇔ `completed_at` set and `next_attempt_at` null. UNIQUE `(event_id, endpoint_id)`; partial `(next_attempt_at) WHERE status IN ('pending','retrying')`; `(user_id, seq DESC)`, `(endpoint_id, seq DESC)`. Trigger: owner, event, endpoint immutable.
- `webhook_delivery_attempts` (append-only; DELETE only by cascade): composite FK to delivery, `attempt_no` (UNIQUE with delivery), `trigger`, `lease_token`, `started_at`, `duration_ms`, `outcome` (`success`/`retryable`/`permanent`/`abandoned`), `status_code`, `error_code`, `response_excerpt` (≤ 1024), `response_headers` (allowlist), `injected`, `stale`, `signature_kind`, `next_retry_at`.
- `scheduler_leases` (replaces `worker_heartbeats`): `name text PK`, `lease_token`, `locked_until`, `last_started_at`, `last_finished_at`, `last_summary jsonb`; seeded with the row `'tick'`. No `user_id` (operational; documented exception).
- All new tables: RLS on, no policies, Data API roles revoked, trigger functions with `search_path = ''`. Audit actions for endpoint changes, rotations, failure-mode changes, manual retries.
- **Size on the Free plan (500 MB):** an attempt row is ≤ ~1.5 KB, so 100,000 attempts ≈ 150 MB. No purge in S4 (S6); the read-only check reports current database size.
- **Rollback:** `docs/S4-rollback.sql`, outside the migrations folder, never run without approval: unschedule the cron job → redeploy web without fan-out → drop the five new tables, the new `events` index, restore the old check. Forward fixes preferred.

### 5.10 Scheduler setup on Supabase (ops SQL, not a Prisma migration)
Kept out of Prisma migrations because it holds an environment-specific URL and secret and enables extensions. File: `packages/db/ops/003_s4_scheduler.sql`, with placeholders; you (or I, on approval) run it in the Supabase SQL editor. The secret value is typed by you; it never enters the repository, a log or a report.
1. Enable `pg_cron` and `pg_net` if the read-only check shows they are not installed (Dashboard → Integrations → Cron, or `CREATE EXTENSION`).
2. Store two Vault secrets: `sandbox_tick_url` (`https://<production domain>/api/scheduler/tick`) and `sandbox_tick_secret`.
3. Schedule `sandbox-scheduler-tick` every minute: `SELECT net.http_post(url := <vault url>, headers := jsonb_build_object('Authorization', 'Bearer ' || <vault secret>, 'Content-Type', 'application/json'), body := '{}'::jsonb, timeout_milliseconds := 55000)`. The explicit 55 s timeout replaces `pg_net`'s 2 s default; the tick's own work budget is 25 s.
4. Schedule `sandbox-cron-history-cleanup` daily: delete `cron.job_run_details` rows older than 7 days (Supabase's documented recommendation; bounded by a time predicate; touches only cron's own history).
5. Pause/resume: `SELECT cron.alter_job(<jobid>, active := false|true)`. Removal: `SELECT cron.unschedule('sandbox-scheduler-tick')`.

## 6. Implementation sequence
Each step ends with `pnpm -r typecheck` and the database-free tests; nothing touches the hosted database.
1. S3 blockers in code: F1, F3, F4, F5 with unit tests.
2. Core: `packages/core/src/webhooks/{signature,retry,ssrf}.ts` + unit tests; ids `we_`, `whd_`; event type `webhook_endpoint.test`.
3. Prisma migration + schema + `verify-s4.ts` (read-only) + rollback SQL + scheduler ops SQL, written only; `prisma generate`.
4. SSRF-safe sender + unit tests (local receiver with injected `allowPrivate`, stub resolver for rebinding).
5. Delivery engine: fan-out in `emitEvent`, claim/record/lease, retry scheduling, manual retry, failure simulation.
6. Scheduler: lease, tick runner (sweeps + delivery loop with budget), `/api/scheduler/tick` route, `proxy.ts` exclusion, `SCHEDULER_TICK_SECRET` handling (new small env reader; your `env.ts` change stays untouched).
7. Endpoint service, API routes, validation, DTOs.
8. Dashboard Webhooks section, scheduler status (last tick, duration, summary, stale warning after 3 minutes).
9. Integration tests (skipped by default), E2E receiver script, `docs/webhooks.md`, `docs/scheduler-setup.md`, `docs/S4-report.md`. `next build` must pass.

## 7. Testing and end-to-end strategy

### 7.1 Database-free (run during implementation)
Signature (tamper, wrong secret, tolerance, dual secret); retry schedule and classification; SSRF table (every range boundary, mapped forms, URL normalization tricks, ports, hostnames); sender (2xx, 500, timeout, oversized body, 3xx, refused connection, TLS mismatch, rebinding stub, proxy refusal); tick auth (missing, wrong, previous secret, unset env → 404, wrong method → 405, constant-time path); tick budget logic with a fake clock; failure-simulation effects; route boundary; `proxy.ts` matcher excludes the tick route.

### 7.2 Hosted integration tests (after approval; S2 §9 safeguards)
Fan-out atomicity and filtering; **two concurrent ticks** → one runs, one returns `skipped`; scheduler lease expiry after a simulated killed tick; 4 concurrent delivery claimers → each delivery claimed once; crash/lease expiry → `abandoned` then re-attempt, late result stored `stale`; retries to success and to exhaustion; timeout; duplicate; invalid signature; out-of-order; manual retry (failed, succeeded, while leased, double call); soft delete cancels pending deliveries; `sweepAll` poison isolation; `sweepSetupAll` single event under concurrent reads; cross-user isolation on every new route; cascade on deleting a test user; `verify:s4`.
Guards: the harness refuses to run unless the cron job is paused (you pause it with `cron.alter_job` as part of approving the run; the harness checks `scheduler_leases.last_started_at` is older than 3 minutes); test claims are restricted to the run's own delivery ids; test receivers bind to `127.0.0.1`.

### 7.3 Deployment
1. Apply the S4 migration (approved) → `verify:s4`.
2. Add `SCHEDULER_TICK_SECRET` to Vercel (Production), then deploy the web app as you do today.
3. Run the scheduler ops SQL (approved) with the production URL and the same secret.
4. Watch the first ticks: dashboard scheduler status, `cron.job_run_details`, `net._http_response` (status 200 and summary), Vercel function logs (kept 1 h on Hobby).

### 7.4 End to end against the deployed Vercel app
A receiver script (`apps/web/scripts/e2e-receiver.ts`) verifies signatures with the core verifier, dedupes by event id and logs; it runs on your machine behind a free HTTPS tunnel (e.g. `cloudflared tunnel --url`), a public URL the SSRF rules accept. Steps:
1. Create an endpoint in the deployed dashboard with the tunnel URL; give the receiver the secret.
2. "Send test" → delivered at the next tick (≤ ~80 s) → dashboard `succeeded`.
3. API checkout sessions on the Vercel URL → pay on the hosted page (`success`, `decline`, `pending_then_success`) → `payment.*` and `checkout.session.*` events with valid signatures.
4. Failure modes: `http_500` with remaining 2 → two failures then success across ticks; `invalid_signature` → receiver rejects; `duplicate` → receiver dedupes; manual retry from the dashboard.
5. An unread session expires → the tick's sweep emits `checkout.session.expired` → delivered.
6. Stop the receiver → retries accumulate with backoff → restart it → delivery succeeds; history is complete.
7. Overlap: call the tick endpoint manually (with the secret) while a cron tick runs → `skipped: "busy"`.
8. SSRF from production: `https://localhost`, `https://169.254.169.254`, a hostname resolving to a private address → refused at create, blocked at send.
This creates data only in your own account through the public product; it is not a test-harness write.

## 8. Steps requiring your separate approval, in order
1. **Approve this plan** → I implement §6 (code, SQL written not run, hosted tests skipped). No hosted access, no commits.
2. **Read-only hosted check** (`default_transaction_read_only = on`): `pg_cron`/`pg_net`/`supabase_vault` availability and installed versions, applied migrations (incl. `20261113200000_payment_methods`), database size, identity and baseline counts. Can run before or in parallel with step 1's implementation; its result may change the plan (if `pg_cron` or `pg_net` is unavailable, I stop and report).
3. Only if the payment-methods migration is missing: its dry-run and apply.
4. **S4 migration dry-run** (rolled-back transaction).
5. **Apply the S4 migration**, then `verify:s4`.
6. **Hosted integration tests**, with the cron job paused.
7. **Commit** (and push, which deploys to Vercel if your project auto-deploys), after `SCHEDULER_TICK_SECRET` is set on Vercel.
8. **Scheduler ops SQL** on Supabase: enable extensions if needed, Vault secrets, cron jobs.
9. **End-to-end run** against the deployed app (§7.4).

## 9. Decisions taken (change any before approving)
| # | Decision |
|---|---|
| D1 | Only S3 blockers F1-F5 before S4; rest deferred (§3). |
| D2 | Supabase Cron is the only scheduler: one job, every minute, `pg_net` POST to a secret-protected Vercel route. |
| D3 | Tick: lease-guarded, 25 s work budget, `maxDuration` 60 s, sweeps + deliveries in one run. |
| D4 | Fan-out in the event's transaction (outbox). Later endpoints do not receive earlier events. |
| D5 | Tick secret in Vercel env and Supabase Vault only; 404 on failure; previous-secret support for rotation. |
| D6 | Webhook secrets `whsec_`, sealed, shown once, 24 h dual-signing on rotation; `Sandbox-*` headers. |
| D7 | Retry policy §5.7; no auto-disable. |
| D8 | Endpoint soft delete; pending deliveries cancelled. |
| D9 | Failure simulation §5.8, per endpoint only. |
| D10 | Limits: 16 endpoints/user, 32 event types/endpoint, 10 test sends/endpoint/min, 10 manual retries/user/min. |
| D11 | Test event persisted as `webhook_endpoint.test`. |
| D12 | All existing event types deliverable, including `payment_method.*` and setup sessions. |
| D13 | At-least-once, no ordering guarantee; first attempt within ~60-80 s. |
| D14 | No retention purge of webhook tables in S4; cron history cleaned daily. |
| D15 | No new dependencies; one new Vercel env var (`SCHEDULER_TICK_SECRET`). |

## 10. Remaining risks
- **Supabase Free pausing after 1 week of inactivity.** If the project pauses, cron stops and so does all background processing. Whether cron or the tick's database traffic counts as activity is not documented. Mitigation: you are actively testing; the dashboard warns when the last tick is stale.
- **Vercel Hobby allotments:** idle cost is small (§4.3); sustained heavy load could exceed provisioned-memory hours and pause the project. Watch the usage page after day one.
- **Latency:** ≥ one tick (up to ~80 s) per attempt; not suitable as a real-time demo.
- **`pg_net` is beta** and stores requests in unlogged tables (lost on a database crash). A lost tick request is harmless: the next minute runs.
- **Fan-out shares the payment transaction:** a broken webhook table breaks payments (deploy order and `verify:s4` mitigate).
- **Tick secret lives in Vault:** anyone with database owner access can read it; they already have full access.
- Payment-method, setup and charge paths remain without integration tests (deferred).
- The E2E tunnel is a third-party service; only test payloads pass through it.

## 11. Implementation notes (deviations and refinements, 2026-11-14)
- Route is `POST /api/scheduler/tick` (operator clarification), inside the existing Next.js app; `runtime = "nodejs"`, `maxDuration = 60`.
- Tick work budget raised from 20 s to **25 s** (new claims stop when < 12 s remain); `pg_net` timeout set to **55 s** (was 30 s) so the HTTP call outlives the work and stays under `maxDuration`. Lease lengths unchanged (scheduler 90 s, delivery 60 s).
- Delivery claim takes at most **one delivery per endpoint per batch** (batch 10, sent concurrently), so one slow receiver cannot stall a tick; only deliveries of enabled, non-deleted endpoints are claimable (disabled endpoints keep theirs pending).
- `failure_mode_remaining` applies to attempt-time modes only (`http_500`, `timeout`, `invalid_signature`, `duplicate`); `delay` / `out_of_order` last until changed (counting them would write to the endpoint row inside every payment transaction).
- `webhook_endpoint.test` is not subscribable; test events are delivered only to the requesting endpoint. `api_idempotency_keys` scope widened with `webhook_endpoint.create`; an idempotent replay returns the same secret, stored sealed (never plaintext) in `token_enc`.
- `scheduler_leases.name` also accepts `test-<12 hex>` so hosted tests use their own row and never touch the production `tick` row. The harness refuses to run while the production tick ran in the last 3 minutes.
- `sweepAll` now returns `{settled, failed}` and isolates failures per session (F4); `sweepSetupAll` added (F5), with an optional user filter used only by tests.
- If `ALLOW_PRIVATE_WEBHOOK_TARGETS` is misconfigured outside development, API/dashboard validation falls back to strict and the tick answers 500 `configuration_error` (it never loosens SSRF rules).
- `api_credentials.webhook_secret_enc` (S1, shown on the Credentials page as "Webhook secret") is **not** used for signing; each endpoint has its own secret. Left unchanged; see the report.
