> **Rule R-DB-1 (see `arch-plan.md`, "Hosted Supabase Only — No Local Supabase") overrides everything below about local Supabase, the Supabase CLI, Docker/Compose or Testcontainers databases, and local test databases (Environment notes, §2 environments, §11, §12, §13 risks 1-2, and decision 2 in the approval list). Those passages are historical and struck through or void; the Hosted Supabase project is the only database.**
>
> **Partly superseded by `docs/S1-revised-plan.md`.** §3 (multi-tenant design) and the workspace/project tables in §5 are replaced by direct user-level ownership (`user_id` = Supabase Auth user id). The rest of this report still applies.

# S0 Report — Architecture & Repository Review

Status: inspection only. No application code, dependencies, or schemas were created or changed. This file is the only artifact written.

## 1. Repository assessment

| Item | Finding |
|---|---|
| Contents | One file: `arch-plan.md`. Not a git repo. No `package.json`, source, migrations, tests, Docker files, or env config. |
| Frontend / backend / DB / auth / API / workers / UI / tests / security | None exist. |
| Reuse / retain | Nothing to retain. |
| Remove / redesign | Nothing to remove. |
| Rebuild | N/A: this is a greenfield build. |

Environment:
- Node v24.22.1, pnpm 12.14.0, npm 11.19.1, git 2.50.0, Docker 29.4.2 + Compose v5.1.3 (daemon running).
- **Supabase CLI is broken**: `/opt/homebrew/bin/supabase` (2.115.0) points to a Node interpreter that no longer exists (`/opt/homebrew/opt/node/bin/node`). Fix: `brew reinstall supabase/tap/supabase` (or install via `pnpm dlx supabase` / a project devDependency). Needed before local Supabase.
- `psql` is not installed (not required; Prisma and the `pg` driver are used against the Hosted database).
- **Port conflicts**: 3000 (something listening), 5432 (another Postgres), plus 3306/5000/7000. Docker is running containers from an unrelated project (`elapsed-dev-*`). Our compose setup must use non-default ports (e.g. web 3100, Supabase local stack on its own port block via `supabase/config.toml`) and must never attach to those containers or DBs.
- Disk: only ~11 GiB free (98% full). The Supabase local stack plus images is several GB; worth cleaning Docker images first.
- `git init` is needed (needs your approval; nothing committed without it).

## 2. Recommended target architecture

pnpm monorepo, three deployables, one shared domain package:

```
apps/web        Next.js (App Router): dashboard, hosted checkout, /api/v1, docs
apps/worker     Node process: webhook delivery worker (+ /healthz)
packages/core   Domain: state machines, money, signing, retry, scenarios, SSRF guard (pure TS, no framework)
packages/db     Prisma schema, migrations, client, repositories
supabase/       config.toml, SQL for RLS/roles/extensions that Prisma can't express
docs/, openapi/ Specs and guides
```

Principles: the domain logic lives in `packages/core` and is framework-free, so the worker and web share the exact same state machine and signer. Route handlers are thin (auth → validate with Zod → service call → map to public DTO). Public API DTOs are separate from Prisma models. Follow your `nextjs-architecture` skill's module layout inside `apps/web` when S1 starts.

Stack stays as specified (Next.js, React, TS strict, Tailwind, shadcn/ui, Supabase Auth + Postgres, Prisma, Zod, Vitest). Additions I'd justify: **Zod** (boundary validation, OpenAPI generation via `zod-to-openapi`), **Playwright** (E2E; Vitest alone can't drive the browser checkout). No Redis, queues, Edge Functions, Realtime, or Storage.

## 3. Multi-tenant design

Hierarchy: `User → Workspace (via workspace_members) → Project → {credentials, sessions, transactions, events, endpoints, deliveries}`.

- Every tenant-owned row carries a **denormalised `project_id` NOT NULL** (and children reference it via composite FKs, e.g. `(project_id, checkout_session_id)`), so a transaction can never point at a session in another project at the DB level.
- Dashboard access: Supabase Auth session → server resolves `workspace_members` → checks project belongs to a workspace the user is a member of. One central `requireProjectAccess(userId, projectId)` helper; every repository function takes `projectId` (no un-scoped queries by id alone).
- API access: Client ID + Client Secret → resolves to exactly one project. Dashboard sessions never authorize `/api/v1`.
- **Roles:** initial release = `owner` only (membership table exists so adding roles later is non-breaking). No invite flow in v1. This avoids enterprise permission complexity with no requirement.
- RLS: enabled with deny-all on all tables for `anon`/`authenticated` as defense in depth (we never use the Supabase data API for these tables). Prisma connects as a dedicated least-privilege role, which **bypasses RLS unless it is subject to it**, so authorization is enforced in the app layer and tested explicitly. Verify actual role (`select current_user`) in an integration test.

## 4. Supabase architecture

- Dedicated projects: `dev` and `prod` (separate credentials). ~~local via Supabase CLI~~ (void: R-DB-1).
- **Connections** (recommendation):
  - Migrations: **direct connection** (or session pooler when direct is IPv6-only and the CI/host lacks IPv6) via `DIRECT_URL`.
  - Web runtime (serverless-style or many instances): **transaction pooler** (port 6543) with `?pgbouncer=true&connection_limit=1`; Prisma is compatible.
  - Worker (long-lived, needs `FOR UPDATE SKIP LOCKED` and possibly advisory locks): **session pooler or direct**, since transaction pooling breaks session-level features.
- Auth: Supabase Auth (email/password, password recovery, email verification on in hosted; unverified users cannot create workspaces). Use `@supabase/ssr` cookies; server validates with `getUser()`, not `getSession()`.
- `service_role` key: not needed by the web app at all in this design (Prisma handles data; Auth uses the anon key + user JWT). Keep it unused/absent unless an admin task demands it. Never in `NEXT_PUBLIC_*`.
- `public.users` is a profile mirror keyed to `auth.users.id`, created lazily on first login (avoids a DB trigger crossing the auth schema).

## 5. Database schema proposal

All ids: `uuid` internal PK + prefixed public id (`cs_…`, `pay_…`, `evt_…`, `we_…`, `del_…`) stored in a unique column. Timestamps `timestamptz`. Money: `bigint amount_minor` + `char(3) currency`.

| Table | Key columns / constraints | Delete behavior |
|---|---|---|
| users | `id` = auth uid, email | soft/anonymise |
| workspaces | id, name, owner_id | restrict if projects exist |
| workspace_members | (workspace_id, user_id) unique, role | cascade with workspace |
| projects | id, workspace_id, name, `status`, `merchant_display_name`, `retry_limit`, unique(workspace_id, slug) | soft-delete (`archived_at`); data retained then purged by job |
| api_credentials | project_id, `client_id` unique, `secret_hash` (SHA-256 of a ≥256-bit random secret; Argon2 unnecessary for high-entropy secrets), `webhook_secret` (encrypted at rest, AES-256-GCM with app key, because it must be recoverable to sign), status, created/last_used/revoked/expires_at | never hard-deleted (revoked) |
| checkout_sessions | project_id, `token_hash` unique, amount_minor, currency, external_reference, metadata jsonb, status, expires_at, **amount/currency immutable via trigger** | retention purge after N days |
| transactions | project_id, checkout_session_id (unique active), status, version int, failure_code, timestamps | retention |
| payment_events | project_id, `event_id` unique, type, payload jsonb (immutable via trigger), unique(transaction_id, type, transition_seq) for dedupe | retention |
| webhook_endpoints | project_id, url, status, event filter, retry config, `secret_version` | soft-delete; deliveries keep endpoint snapshot |
| webhook_deliveries | event_id, endpoint_id, attempt_no, status, `next_attempt_at`, `locked_by`, `locked_until`, response_status, duration_ms, error_code, response snippet (truncated, no headers with secrets) | retention (e.g. 30 days) |
| idempotency_keys | project_id, key, request_hash, response snapshot, status; unique(project_id, key); TTL 24h | purge |
| audit_logs | actor, project/workspace, action, target, metadata, ip | **never cascade-deleted**; FKs are plain ids without cascade |

Indexes: tenant-first composite indexes (`project_id, created_at desc`), partial index on `webhook_deliveries(next_attempt_at) WHERE status IN ('pending','retrying')`. Rationale for changes to your entity list: added `deliveries` split into one row per (event, endpoint) with attempts as child rows `webhook_delivery_attempts` (so attempt history is immutable and the delivery row holds the claimable state); `payment_events` is renamed conceptually to `events` in the public API.

## 6. API proposal

Auth: `Authorization: Basic base64(client_id:client_secret)` over HTTPS (or `Bearer <client_id>.<secret>`). Recommend Basic: familiar to payment developers. Errors: `{ "error": { "type", "code", "message", "param?", "request_id" } }`. Pagination: cursor (`limit`, `starting_after`, max 100). Rate limit headers `X-RateLimit-*`, `429` + `Retry-After`. `Idempotency-Key` header on all POSTs. Versioning by path `/api/v1` plus an `API-Version` field in events.

Changes to your proposed surface:
- Keep all proposed endpoints.
- Add `POST /api/v1/payments/{id}/…` **not** needed; payments are created by hosted checkout, not by the API. Scenario outcomes are chosen on the hosted page or preset at session creation via `scenario` field (sandbox only).
- Add `POST /api/v1/webhook-endpoints/{id}/rotate-secret`.
- Add `GET /api/v1/checkout/sessions` (list) and `GET /api/v1/payments` (list).
- Dashboard actions (rotate credentials, retry delivery, force scenario) use internal `/api/dashboard/*` routes with Supabase session auth, not the public API. `POST /webhook-deliveries/{id}/retry` is kept on the public API too.
- Public checkout page uses `/checkout/{token}` with server actions (no amount is ever accepted from the browser).

OpenAPI 3.1 generated from Zod schemas; docs rendered in-app.

## 7. Webhook & event specification

Envelope:
```json
{ "id":"evt_…", "type":"payment.succeeded", "created_at":"…ISO8601", "api_version":"2026-11-01",
  "project_id":"prj_…", "data":{ "payment_id":"pay_…","checkout_session_id":"cs_…","external_reference":"…",
  "amount":14900,"currency":"USD","status":"succeeded","metadata":{} } }
```
Types: `checkout.session.completed|expired|cancelled`, `payment.pending|succeeded|failed|cancelled`.

Headers: `X-Sandbox-Event-Id`, `X-Sandbox-Timestamp` (unix seconds), `X-Sandbox-Signature: v1=<hex>`, plus `X-Sandbox-Delivery-Attempt`.
Signature: `HMAC_SHA256(webhook_secret, timestamp + "." + raw_body)` (hex). Receivers must verify against the raw bytes, compare in constant time, and reject timestamps outside a 5-minute tolerance. During secret rotation, send `v1=` for both current and previous secret for a grace window. Payload bytes are serialized once at event creation and stored, so retries send identical bytes (stable signature input, only the timestamp/signature change per attempt).

Retry: exponential 30s·2^n with jitter, capped at 1h, default 8 attempts, configurable per endpoint (max 12). Retry on timeout, network error, 408/429/5xx. Do not retry other 4xx, SSRF block, or invalid URL (mark `failed_permanent`). Manual retry creates a new attempt on the same delivery and event.

## 8. State machines

Checkout session: `open → completed | expired | cancelled`; all three terminal. Transaction: `pending → succeeded | failed | cancelled`; terminal states immutable. A session is created `open` with **no** transaction; the first outcome selection creates the transaction (`pending` or terminal) atomically.

Enforcement: single transition function in `packages/core` (pure, table-driven), applied via **optimistic update** `UPDATE … SET status=$new, version=version+1 WHERE id=$id AND status=$expected` inside a transaction that also inserts the event + deliveries (outbox pattern, so events cannot be lost or duplicated). Zero rows updated → re-read, then return the existing result for a duplicate of the same outcome (idempotent) or `409 invalid_state_transition`. Checkout expiry is evaluated lazily on read (`expires_at < now()`) and swept by a worker job. Pending → success/failure scenarios are driven by a scheduled `scenario_jobs` step that calls the same transition function; out-of-order event scenarios only affect *delivery order*, never state.
Timeout scenario: transaction stays `pending` and no resolution occurs until the session expires; expiry of a session with a pending transaction cancels the transaction.

## 9. Security design (summary)

- Secrets: client secrets = 32 random bytes, shown once, stored as SHA-256; lookup by `client_id`, constant-time compare. Webhook secrets AES-GCM encrypted with `SECRETS_ENCRYPTION_KEY` (env). Revocation immediate (checked every request, no cache longer than a few seconds, or none).
- Checkout token: 32 random bytes base64url, only hash stored, TTL default 30 min, bound to the session.
- Rate limiting without Redis: Postgres-backed fixed-window counters (adequate at this scale), documented as a swap point. Request body limit 64 KB.
- SSRF: scheme allowlist (https only in hosted), resolve DNS ourselves, block private/loopback/link-local/CGNAT/metadata ranges (v4+v6, IPv4-mapped), **connect to the validated IP** with `servername`/Host preserved (defeats rebinding), no redirects followed by default (3xx = failure), 10s timeout, 256 KB response cap, response body stored truncated to 1 KB. `ALLOW_PRIVATE_WEBHOOK_TARGETS=true` allowed only when `APP_ENV=local`; the app refuses to boot if set elsewhere.
- Sandbox integrity: banner on all checkout pages, no card inputs, no production mode flag exists.
- Audit logs for credential, endpoint, project, and manual-retry actions; secrets and tokens redacted by a central logger.
- CSRF: server actions/same-site cookies; dashboard API routes require same-origin.

## 10. Background worker design

Node process, no framework. Loop: claim up to N deliveries with
`UPDATE webhook_deliveries SET locked_by=$w, locked_until=now()+lease WHERE id IN (SELECT id … WHERE status IN ('pending','retrying') AND next_attempt_at<=now() ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT N) RETURNING *`. Leases expire so crashed workers' jobs are reclaimed. Each attempt is persisted; a unique `(delivery_id, attempt_no)` constraint blocks duplicate attempts. Also runs: session expiry sweep, scenario resolution jobs, idempotency/retention cleanup. `GET /healthz` reports DB connectivity, last loop time, queue depth. Scales horizontally with no coordination.

## 11. Deployment topology

Web (Next.js, any Node host/serverless/container) + Worker (container or long-running process; same Dockerfile target) + Supabase project. Provider-agnostic: Dockerfiles for both, ~~`docker-compose.yml` for local (worker + web; Supabase via CLI on non-conflicting ports)~~ (void: R-DB-1; web and worker run locally against the Hosted database). Options to document: (a) Vercel + Fly/Railway/Render worker, (b) all-container on one VPS, (c) Kubernetes. Trade-offs: serverless web needs the transaction pooler; the worker must be long-running. Backups: Supabase PITR (paid) or daily dumps; restore drill is an S6 item.

## 12. Testing strategy

Vitest workspace: unit tests for `packages/core`; integration tests against the **real Hosted Supabase PostgreSQL** only (~~Supabase local stack or a Testcontainers/compose Postgres~~ void: R-DB-1; safeguards in `arch-plan.md` and `docs/S2-plan.md` §9); a local HTTP receiver for webhook tests (simulating 500, timeouts, bad signatures); explicit concurrency tests (`Promise.all` on same idempotency key, concurrent transitions, concurrent claiming with multiple worker instances); cross-tenant matrix test over every route; Playwright E2E for the full lifecycle. CI: GitHub Actions with a Postgres service. I will only claim tests passed after running them.

## 13. Risks & trade-offs

1. ~~Supabase CLI currently broken (Node link) and low disk (11 GiB) could block local stack: fix before S1.~~ Void: no local stack or CLI is used (R-DB-1).
2. Port collisions with existing local services (3000, 5432); must configure alternates.
3. Prisma bypasses RLS: authorization is app-layer only; mitigated by single access helper + cross-tenant tests + deny-all RLS.
4. Transaction pooler limits worker features: worker uses session/direct.
5. DNS-pinning SSRF defense needs a custom HTTP agent (undici `Agent` with `connect.lookup`); needs careful tests, including IPv6 and mapped addresses.
6. Postgres rate limiting is coarse: acceptable for a sandbox, documented limitation.
7. Hosted abuse (open public signups): need email verification, per-user project/endpoint caps, and quota on webhooks/sec.
8. Lazy expiry + sweeper means state can briefly lag; reads always evaluate expiry so it is never user-visible.
9. Webhook secret must be recoverable (encrypted), so a leaked `SECRETS_ENCRYPTION_KEY` plus DB read exposes webhook secrets; key rotation procedure needed.

## 14. Implementation plan

- **S1** Foundation: git init (with approval), monorepo scaffold, strict TS/ESLint, Prisma schema + first migration + triggers, Supabase local config, Supabase Auth flows, workspace/project CRUD, `requireProjectAccess`, credential generate/rotate/revoke, Vitest + Postgres test harness, cross-tenant tests.
- **S2** API auth, Zod/error/idempotency/rate-limit middleware, checkout sessions, transaction domain + state machine, scenario engine, events via outbox.
- **S3** Hosted checkout, dashboard (overview, transactions, sessions, credentials, settings, scenario controls).
- **S4** Endpoints, signing, worker, retries, manual retry, failure injection, SSRF guard.
- **S5** OpenAPI, interactive docs, TS examples, getting started, troubleshooting.
- **S6** Hardening, full test run, security review, deployment/backup verification, release report.

## Decisions I need from you before S1

1. Approve `git init` in this folder (no commits without approval).
2. ~~Approve fixing the Supabase CLI and freeing Docker/disk space~~ Void: the Supabase CLI and Docker are not used for the database (R-DB-1).
3. Confirm: owner-only roles for v1; Basic auth for the API; added dependencies Zod + Playwright.
4. Do you already have dedicated Supabase dev/prod projects, or should S1 start local-only?
