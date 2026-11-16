# S5 plan: developer experience (revision 2: APPROVED with conditions 2026-11-16; IMPLEMENTED, see S5-report.md)

> Rule R-DB-1 still applies. S5 needs **no database migration and no hosted database write**. Tests that already run against the hosted database stay as they are.


## Revision 2: approval conditions (operator, 2026-11-16)

Approved with Scalar. Conditions, all binding:

1. `@scalar/api-reference` is a **regular production dependency** of `@sandbox/web` (imported by a production page). Pinned exactly at `1.76.4` (released 2026-10-30, more than two weeks old when chosen); its install script for `vue-demi` is not approved to run.
2. **Contract tests** cover every HTTP method of every route, every documented status code, every successful response and every error response; response DTOs are validated with Zod (§4.2, §6).
3. **Route inventory corrected and classified** (§2.1). The draft said "17 `/api/v1` routes"; that was my miscount. There are 20 route files: 19 public `/api/v1` files carrying 26 operations, plus 1 internal scheduler route.
4. **Scalar privacy**: no third-party runtime request, and user-entered credentials never reach Local Storage, Cookies, IndexedDB or other persistent storage (§4.3, verified in a real browser, §6).
5. **Webhook examples are verified against the real signer** in `packages/core`, including signature rotation, tampering and stale timestamps (§6).

Non-negotiable: R-DB-1; no migrations; **no additional hosted database writes** (all S5 tests are pure or use an in-memory fake database; the hosted-database suites are not run for S5); no API behaviour changes (inconsistencies are documented in `docs/S5-report.md`, not fixed); no commit or push without separate approval; no scope expansion or next phase without approval.

### 2.1 Route inventory and classification (20 files, 26 operations)

| Class | Files | Operations | Documented in OpenAPI |
|---|---|---|---|
| Public merchant API (`/api/v1`, API-credential auth) | 19 | 26 | all 26 |
| Internal infrastructure (`/api/scheduler/tick`, bearer secret, called by Supabase Cron) | 1 | 1 (`POST`) | no; described in `docs/scheduler-setup.md` |
| Dashboard pages, auth callbacks, hosted checkout, `/healthz` | not route handlers under `/api` | n/a | no (not API) |

The contract test classifies every `route.ts` under `src/app/api` and fails on any file that is in neither class.

## 1. Goal

An independent developer, with only the repo and the deployed URL, can: create an account, get API credentials, create a checkout session, complete it, receive and verify a signed webhook, and debug common failures, with no internal help.

## 2. Current state (from the code)

- 20 route files: 19 under `/api/v1` (26 operations: checkout sessions, payments and saved-card charges, payment-methods, events, webhook-endpoints, webhook-deliveries) plus the scheduler tick (internal, not public). See §2.1.
- Request validation: zod schemas in `apps/web/src/server/api/validation.ts`; response shapes in `dto.ts`; error envelope in `errors.ts`; Basic auth with API credentials; `Idempotency-Key`; cursor pagination; rate limits.
- Docs today: `docs/webhooks.md`, `docs/state-machines.md`, `docs/scheduler-setup.md`. No OpenAPI file, no getting-started, no examples, no troubleshooting.

## 3. Deliverables

| # | Deliverable | Location |
|---|---|---|
| D1 | OpenAPI 3.1 spec covering all 26 public `/api/v1` operations: schemas, errors, auth, idempotency, pagination, filters, rate-limit headers, webhook event payloads (as `webhooks` + component schemas) | `apps/web/public/openapi.json` (generated), source in `apps/web/src/server/openapi/` |
| D2 | Interactive API reference page at `/docs` (try-it needs a user's own credentials, entered in the browser, never stored by us) | `apps/web/src/app/docs/` |
| D3 | TypeScript examples, runnable with `npx tsx`, no SDK dependency: create session, poll/read payment, saved-card charge, list events | `examples/typescript/` |
| D4 | Webhook verification examples: Node (`node:crypto`) and Next.js route handler, both using raw body, constant-time compare, 5-minute tolerance, multi-`v1` rotation; plus a tiny local receiver and tunnel instructions | `examples/webhooks/` |
| D5 | Getting-started guide (account → credential → first payment → webhook → go through every scenario) | `docs/getting-started.md` |
| D6 | Troubleshooting guide keyed by error code / symptom (401/403, validation errors, idempotency conflict, 429, signature mismatch, delivery stuck/failed, SSRF-refused URL, scheduler stale) | `docs/troubleshooting.md` |
| D7 | API reference notes not expressible in OpenAPI (versioning, event catalogue, test cards, scenarios) | `docs/api-overview.md` |
| D8 | Independent-developer verification (§6) and `docs/S5-report.md` | `docs/` |

## 4. Design decisions (recommendations, please confirm)

1. **Spec generation: generate from the existing zod schemas** (zod 4 has `z.toJSONSchema`) and assemble paths in one typed registry, rather than hand-writing JSON. Rationale: zero drift on request bodies; no new dependency. Response schemas are written once next to `dto.ts`.
2. **Drift protection (contract tests, §4.2 of revision 2):** fail if (a) any route file/method has no spec operation or any operation has no route, (b) a documented status has no response schema or a status in the code is undocumented, (c) any success DTO, built by the real DTO functions from fixtures, fails Zod validation (response schemas are strict, so an undocumented field fails), (d) any error response produced by the real handler pipeline or `errorResponse` fails the error schema, or any error code in the source is missing from the spec. Handler-level checks use an in-memory fake database, never the hosted one.
3. **Interactive docs:** `/docs` renders **Scalar** from the production dependency `@scalar/api-reference`, bundled by Next (no CDN). Page structure follows the project architecture: thin `page.tsx` -> SSR component -> CSR component.
   - §4.3 Privacy hardening: enforced `Content-Security-Policy` on `/docs` (`connect-src 'self'`, `img-src 'self' data:`, `font-src 'self' data:`, `frame-ancestors 'none'`) so a third-party request is blocked by the browser, not merely avoided; Scalar configured with `persistAuth:false`, `telemetry:false`, no proxy, no default web fonts, agent/MCP/cloud features off; and, before Scalar loads, in-memory replacements for `localStorage`, `sessionStorage`, `indexedDB` and a no-op `document.cookie` writer on that page, so credentials typed into Try-it live only in page memory and vanish on reload. Verified in a real browser (network list, CSP violations, storage and cookie inspection) after typing a dummy credential.
4. **Public docs are static and unauthenticated** (`/docs`, `/openapi.json`); they contain no secrets. Add both to the proxy matcher exclusions and to the API-boundary test.
5. **Examples are not part of the app build**; they get their own `tsconfig`, are typechecked in CI-style command `pnpm examples:check`, and run against a configurable `SANDBOX_BASE_URL`.
6. **No SDK package** in S5 (out of scope; examples show the thin `fetch` pattern). Can be proposed later.

## 5. Work breakdown

1. Inventory: list every operation, parameter, status code and error code from the handlers (source of truth = code, not docs).
2. Response schemas + registry + generator → `openapi.json`; contract test (D1, §4.2).
3. `/docs` page and proxy/boundary-test updates (D2).
4. Examples + `examples:check` (D3, D4).
5. Written docs D5-D7; reconcile `docs/webhooks.md` and `state-machines.md` with the spec (single source per fact, cross-linked).
6. Verification (§6), report (D8).

## 6. Verification ("independent developer" test)

- Automated: contract tests; `pnpm typecheck`; the non-database test files (the hosted-database suites are not run: no additional hosted writes); examples typecheck; OpenAPI validated with an off-the-shelf linter run via `npx` (not added as a dependency); the webhook examples are executed against signatures produced by the real signer in `packages/core` (`buildSignatureHeader`, `verifyWebhookSignature`), including a tampered body, a stale timestamp, a future timestamp, a wrong secret, a malformed header and a two-`v1` rotation header (old or new secret each accepted).
- Browser: `/docs` loaded in a real browser with a dummy credential typed into Try-it; network requests all same-origin, zero CSP violations, `localStorage`/`sessionStorage`/IndexedDB/cookies contain no credential.
- Manual, against the deployed Vercel app with throwaway test data: follow `getting-started.md` literally in a clean directory, using only the docs and examples. Every place I had to consult source code or guess is logged as a docs defect and fixed. I will say plainly that this is a self-test by the implementer, not a true independent person; I recommend you (or someone else) repeat it once.
- Hosted database: only the same test-data creation the existing e2e test does; no schema operation. Any hosted write beyond that gets its own approval.

## 7. Out of scope

Retention purge, security review, load/concurrency verification, backups (all S6); an SDK; localisation of docs; changes to API behaviour. If the spec inventory reveals an API inconsistency, I will **document it and list it in the report**, not silently change behaviour; fixes need your approval.

## 8. Risks

- Spec drift if the contract test is weak: mitigated by §4.2, but response examples can still be stale; examples are executed in verification.
- Scalar adds a front-end dependency and bundle weight to the deployment: confined to `/docs`. Its code references scalar.com hosts (proxy, registry, dashboard); the CSP and configuration in §4.3 are what keep them unreachable, and are tested in a browser.
- Interactive try-it sends the user's credentials from their browser to our own API only; the page has no third-party calls.

## 9. Approvals needed

1. Approve this plan (or the changes you want).
2. (Done) `@scalar/api-reference` as a production dependency.
3. Nothing is committed or pushed without separate approval.
