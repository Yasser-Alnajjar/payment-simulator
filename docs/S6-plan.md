# S6 plan: hardening and release readiness (DRAFT, awaiting approval)

> Rule R-DB-1 applies. Nothing below runs until you approve it. Anything that writes to the hosted database, applies a migration, or touches the Vercel/Supabase dashboards is listed separately in Part B and needs its own explicit yes.

Scope (arch-plan §20, S6): complete automated tests, security review, tenant isolation, concurrency, worker recovery, migration verification, deployment configuration, backups and recovery, final release-readiness report. No new features, no API behaviour changes. Defects found are reported; fixes that change behaviour wait for your decision, except clear security defects, which I will propose with a test.

## Part A: no hosted writes (I run these on approval of this plan)

| # | Work | Output |
|---|---|---|
| A1 | Full local run: `pnpm typecheck`, `pnpm test` (core + web), `pnpm examples:check`, `next build`. Report passed/skipped separately; hosted suites (99 tests) are shown as **skipped**, never as passed | numbers in report |
| A2 | Dependency review: `pnpm audit` (prod + dev), pinned versions, lockfile integrity, unapproved install scripts | §Dependencies |
| A3 | Security review against arch-plan §17 (21 mandatory items), one row each with evidence (file + test) or a stated gap: API-key storage and comparison, Basic auth failure counter, idempotency, raw-body signing, SSRF (incl. DNS rebinding, redirects), rate limits, error leakage, request size limits, CSP/headers on dashboard and checkout, session cookies, open redirects in auth callbacks, server actions authorization, secret exposure in bundles/logs (grep of `.next` output and logs) | §Security |
| A4 | Tenant-isolation audit by code: every Prisma query and raw SQL in `apps/web/src/server` and `modules` must be scoped by `user_id`; list each query and its scoping. Plus RLS/privilege review from the migration SQL (anon/authenticated grants, default privileges, `ops/` scripts) | §Isolation |
| A5 | Concurrency and worker-recovery review: read the claim/lease/reaper SQL, state-transition guards, idempotency uniqueness; list which cases the existing hosted tests (S2-S4) cover and which are untested | §Concurrency |
| A6 | Migration verification, read-only: replay order, `prisma migrate status` against hosted (read-only connection, `default_transaction_read_only`), compare against `verify:s1/s2/s4` read-only checks, check `S4-rollback.sql` still matches schema, check ops scripts are idempotent | §Migrations |
| A7 | Deployment configuration review from the repo: env var inventory vs `.env.example`, fail-closed behaviour when each is unset or malformed, `APP_ENV`/`VERCEL` guards, health check (`/healthz`) content, cron setup doc, security headers, `maxDuration`. Public requests only against the deployed URL (headers, `/healthz`, unauthenticated 401/404 behaviour); no authenticated calls | §Deployment |
| A8 | Backups and recovery: document what Supabase plan provides (backup type, retention, PITR) **as far as docs can say**, a written restore runbook, RPO/RTO statement, and what is the app's data that matters. I cannot see the dashboard, so actual backup state is an operator checklist item | `docs/operations.md` |
| A9 | Add missing **local** tests for gaps found (pure or in-memory fake DB only). Mutation-check any security test I add | tests |
| A10 | `docs/S6-report.md`: results, every finding with severity, what was verified by execution vs by reading, known limitations, go/no-go list | report |

## Part B: needs separate explicit approval (hosted writes or operator access)

| # | Work | Why it needs approval |
|---|---|---|
| B1 | Run the hosted integration suite (159 tests in S4; cron job paused first as the harness requires) after S5 changes, plus **new hosted tests** for the deferred gaps: payment-method, setup-session and saved-card charge paths (open since S2), cross-tenant on every route, concurrent charge/cancel races, worker restart recovery (lease expiry then re-claim), OpenAPI response shapes against real handlers (closes S5 §3 risk) | writes test rows to hosted DB; temporarily pauses cron; shares DB with your own use |
| B2 | Migration rehearsal: `dry-run-migration.ts` replay and `verify:s1/s2/s4` | existing scripts; confirm they are read-only or write only inside a rolled-back transaction before running |
| B3 | Backup restore drill | cannot be done without the Supabase dashboard; **operator task**, I supply the checklist |
| B4 | Vercel checks (Root Directory, deployed commit, env vars, function logs, domain/HTTPS) | dashboard access is yours |

If you decline all of Part B, the final report will say release readiness is **not demonstrated** for concurrency, worker recovery, and the unrun hosted suites, rather than claiming it.

## Decisions I need

1. Approve Part A as written (including A9 adding local tests).
2. Part B: approve B1 and B2 now, defer them to a later step, or decline.
3. Unresolved from S5: `vue-demi: false` approval, OpenAPI `license` field, root README. Fold into S6 (I recommend: yes, as documentation-only work in A10/A7), or leave open.

## Non-negotiable

R-DB-1; no migration applied; no hosted write in Part A; no behaviour changes without your decision; no commit or push without approval; no next phase after S6 (it is the last).
