# S5 report: developer experience (2026-11-16)

Status: **implemented, awaiting your review.** Nothing is committed or pushed. R-DB-1 respected; no migration; **no hosted database write was made in S5** (see §7). No API behaviour was changed. S6 has not been started.

## 1. Your five conditions

| # | Condition | Result |
|---|---|---|
| 1 | `@scalar/api-reference` as a **production** dependency | Done: `apps/web/package.json` `dependencies`, exact `1.76.4` (released 2026-10-30). A static test fails if it moves to `devDependencies` or becomes a range. **Side effect to approve:** pnpm refused to install while the transitive `vue-demi` postinstall was undecided (`ERR_PNPM_IGNORED_BUILDS`, which would also fail a Vercel install), so I added `vue-demi: false` to `allowBuilds` in `pnpm-workspace.yaml`, next to the existing `dotenv: false`. The script only switches Vue 2/3 builds; the page was verified working without it. `pnpm install --frozen-lockfile` now exits 0. The lockfile grew by ~2,800 lines (264 packages). |
| 2 | Contract tests: every method, documented status, success and error response; Zod for DTOs | Done, `apps/web/tests/openapi-contract.test.ts` (30 tests). Coverage and its limits are in §3. |
| 3 | Route inventory resolved and classified | Done, §2. The "17" in my draft was my miscount. |
| 4 | Scalar: no third-party runtime requests; credentials never persisted | Done and verified in a real browser, development **and production** build, §4. |
| 5 | Webhook examples verified against the real signer | Done, `apps/web/tests/webhook-examples.test.ts` (10 tests), §5. |

## 2. Route inventory (20 files, 26 operations)
| Class | Files | Operations | In OpenAPI |
|---|---|---|---|
| Public merchant API `/api/v1` (API-credential auth) | 19 | 26 | all 26 |
| Internal: `POST /api/scheduler/tick` (bearer secret, Supabase Cron) | 1 | 1 | no (documented in `scheduler-setup.md`) |
| Unclassified | 0 | | |

Operations: checkout sessions 4 (create, list, get, cancel), payments 3 (list, **charge a saved card**, get), payment methods 7 (create, list, get default, get, delete, set default, disable), events 2, webhook endpoints 7 (create, list, get, update, delete, rotate-secret, test), webhook deliveries 3 (list, get, retry). The test enforces: 20 files / 19 public / 1 internal; the set of `METHOD path handler` triples in the route files equals the documented set exactly (both directions); no undocumented method (no PUT/HEAD/OPTIONS); path-parameter names match; the scheduler is absent from the public document.

## 3. Contract-test coverage, honestly
**Verified by execution**
- **Success responses (all 26 operations, every documented success status, 201/200/202):** the real DTO functions (`sessionDto`, `paymentDto`, ...) and the **real event builders** (`createPayment`, `transitionPayment`, `transitionSession`, run against a recording transaction) produce samples; each is parsed by the strict Zod response schema **and** by the published JSON Schema converted back to Zod (so the generated document itself is checked, not only its source). Strict means an undocumented extra field fails. Documented success status is checked against `handlers.ts` and the services (201 on create, 202 on test/retry).
- **Error responses, real pipeline, all 26 operations** (in-memory fake database; the real `authenticate`, rate limiter, body reader, Zod validation and `errorResponse` run): `401 invalid_credentials` (no header, wrong scheme, wrong secret, unknown id, with `WWW-Authenticate`), `401 credential_revoked`, `401 credential_expired`, `429 too_many_failed_attempts` and `429 rate_limited` (with `Retry-After`, `X-RateLimit-*`). For every operation with a body: `415`, `413`, `400 invalid_json` (empty, malformed, array), `400 unknown_parameter`, `400 invalid_parameter`. For every operation with query parameters: `unknown_parameter`, `invalid_parameter`. Money errors (`unsupported_currency`, `invalid_amount_format`, `too_many_decimals`, `amount_too_small`, `amount_too_large`) on both money endpoints; `idempotency_key_required`, `invalid_idempotency_key`. Each response is validated against the `Error` schema, must carry `Request-Id` equal to `error.request_id`, `no-store`, no CORS, and its status **and code must be listed in that operation's documented responses**.
- **Error catalogue (all 57 codes):** every code literal in the server source, plus the money/card validators in `packages/core`, must be catalogued with the same status and type; no catalogued code may be stale; every `(status, code)` pair serialises through `errorResponse` into a body the `Error` schema accepts; every operation lists only catalogued codes under the matching status.
- **Document:** OpenAPI 3.1, unique operationIds, no dangling `$ref`, query parameters equal the validation schemas' keys, request bodies are the exact schemas the handlers validate with (strict), idempotency header required only on `POST /payments`, and `public/openapi.json` equals the generated output byte for byte (`pnpm --filter @sandbox/web openapi:generate` regenerates it). Linted with Redocly 2.4.0: valid, 1 warning (no `license` field: that is your decision, not mine).

**Not verified by execution (stated plainly)**
- **State-dependent errors** (`404 resource_not_found`, every `409`, `402 card_declined`, `422`, `invalid_cursor`, customer/card field errors, URL rules, `429 too_many_requests`) need real rows. In S5 they are checked only for catalogue consistency and for being listed on operations under the right status; that **the specific operation can produce the specific code** comes from my reading of the code and of the S2-S4 hosted suites, which I did **not** re-run (that would write to the hosted database).
- **Success bodies through the handlers.** Samples are built by the real DTO/event code, not returned by a live handler call (needs a database). Hand-shaped event payloads (`payment_method.*`, setup-session events, `webhook_endpoint.test`) mimic private builders. This matters: my first schema for `payment_method.updated` missed the real field `change: "default_cleared"`; the tests could not catch it (the fixture mirrored my schema), I found it reading the service, and fixed schema and fixture. Remaining risk of the same kind exists for hand-shaped events; running the hosted suite against the spec is the way to close it.
- Per-operation error lists are best-effort from the source and may omit a rare code.

## 4. Scalar privacy (condition 4)
Design: (a) enforced CSP on `/docs` only: `default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; frame-ancestors 'none'; ...` (`unsafe-eval` only outside production, React dev mode needs it); (b) Scalar configured with `telemetry:false`, `persistAuth:false`, no `proxyUrl`, `withDefaultFonts:false`, `agent`/`mcp` disabled, same-origin spec URL; (c) before the library loads, `localStorage`, `sessionStorage`, `indexedDB` and `document.cookie` writes are replaced by in-memory stand-ins, verified by a write probe, restored on unmount, and **fail closed** (library not loaded, message shown) if any store cannot be replaced; (d) the library is bundled, not fetched from a CDN. Scalar's code does contain references to `scalar.com` hosts (proxy, registry, dashboard, fonts, agent): the CSP is what keeps them unreachable.

Verified in the Browser pane, **development build (port 3100) and production build `next build` + `next start` (port 3199, no `unsafe-eval`)**: page renders; resource origins = `[own origin]` only; no CSP violation and no console error at load; a deliberate `fetch("https://proxy.scalar.com/")` was blocked by the CSP (control: proves enforcement); after typing a fake client id and secret into Try-it (nothing was sent), a hidden same-origin iframe, which sees the **real** stores, showed `localStorage`, `sessionStorage`, cookies and `indexedDB.databases()` all empty and no trace of the typed values (they exist only in the page's memory).
Caveats: Scalar's "Ask AI" buttons are still shown (the agent is inert here and any request would be blocked by the CSP); I did not click **Send** in Try-it, because that would hit the real API and write a failed-authentication counter row in the hosted database; Try-it against a real credential therefore remains untested by me. Browser coverage: the embedded Chromium pane only; the storage override is standard `defineProperty` and fails closed elsewhere.

## 5. Webhook examples vs the real signer (condition 5)
`examples/webhooks/verify.ts` (copy-paste verifier, `node:crypto` only), `node-receiver.ts` (framework-free, deduplicating), `nextjs-route.ts`. The test signs with core's **`buildSignatureHeader`** (what the delivery engine calls), compares verdicts with core's **`verifyWebhookSignature`** case by case, and delivers through the real **`sendWebhook`** transport to the example receiver. Covered: valid; **rotation** (two `v1`, new first; receiver holding new only, old only, both, neither; post-rotation single-signature with old secret rejected); **tampering** (changed value, added whitespace, re-serialised plus newline, truncated, appended, empty, flipped signature byte, signature for another timestamp); **stale/future timestamps** at the boundary (+-299/300 accepted, 301 rejected, 1 h, 24 h, widened tolerance); malformed headers (14 shapes), unknown `v2=` ignored; multibyte body as bytes and text; end-to-end 200/400 with deduplication; the Next.js handler. Mutation check: weakening the tolerance comparison and removing the constant-time comparison each made the suite fail (both restored to the original).

## 6. Other deliverables
| | |
|---|---|
| D1 OpenAPI | `apps/web/src/server/openapi/{schemas,errors,operations,spec}.ts` -> `apps/web/public/openapi.json` (26 operations, 24 component schemas, webhook request documented under `webhooks`) |
| D2 `/docs` | `apps/web/src/app/docs/page.tsx` -> `modules/docs/api-reference/{ssr,csr}` (page -> SSR -> CSR); public, in the proxy's public list; static in the production build |
| D3 TypeScript examples | `examples/typescript/` (client + 5 scripts); `examples/package.json` (ESM); `pnpm examples:check` typechecks them |
| D4 webhook examples | `examples/webhooks/` |
| D5-D7 docs | `docs/getting-started.md`, `docs/troubleshooting.md`, `docs/api-overview.md`; cross-links added to `docs/webhooks.md`; two stale S2 sentences corrected in `docs/state-machines.md` |

## 7. Hosted database
S5 made **no** hosted database write, migration or schema read. The hosted-database suites (99 tests) were **skipped, not run** (the test target variable is unset). The dev server I loaded `/docs` in connects to the hosted project only through the pre-existing proxy's anonymous `auth.getUser()` call (no cookies, no write); no `/api/v1` request was ever sent to it.

## 8. "Independent developer" verification: NOT done as planned
Following the guide end to end against the deployed app means registering, creating credentials, sessions, cards and webhooks: **hosted writes, which you excluded**. What I did instead: all five examples load and fail with a clear message when unconfigured (`npx tsx`); the receiver ran and answered 400 to an unsigned request; the Node examples typecheck. This caught one real defect: `npx tsx` outside an ESM package failed on top-level `await` (fixed with `examples/package.json`).
Gaps an independent developer will hit (not fixed, outside S5 scope):
1. The repo has **no root README**; `getting-started.md` section 7 is the only run-it-yourself guide, and self-hosting needs a hosted Supabase project plus migrations applied by the operator.
2. The guide cannot give a deployment URL; the operator must supply it.
3. Nobody has run the guide who did not write it. I recommend one person does, against the deployment, and that those findings are fixed in docs.

## 9. API observations (documented, **not** changed)
1. **Setup sessions cannot be listed**: `GET /checkout/sessions` returns payment sessions only; `seti_` ids work only on get/cancel.
2. **Two decline conventions:** a declined saved-card **charge** is `201` with `status: "failed"`; a card declined **when saved** is `402 card_declined`.
3. **Only the first validation problem is reported** (the first Zod issue); an "unknown field" can be hidden behind a missing field.
4. **Webhook URL rules collapse** into `invalid_url` (https, credentials, fragment, port, length, FQDN) except private/internal hosts (`url_not_allowed`); the finer reason is only in `message`.
5. **Delivery attempt history is capped** at the latest 100 attempts per read, undocumented in the API.
6. **Rate-limit headers are absent on `401` and `too_many_failed_attempts`** (only after successful authentication); the spec now says so.
7. `payment_method.updated` has an extra `change` field and `default_updated`/`disabled`/`deleted` have `previous_default`/`was_default`: additive event fields now documented in `Event`.
8. `DELETE` returns `200` with a `deleted: true` body, not `204`.
9. **Docs drift fixed** (documentation only): `state-machines.md` still listed 7 event types and said settlement waits for reads.
10. Hosted-checkout-only error codes (`scenario_locked`, `scenario_required`, `scenario_with_card`, `customer_required`, `too_many_payment_attempts`) appear in the catalogue but are not returned by any `/api/v1` operation I could attribute them to.

## 10. Files
New: `apps/web/src/server/openapi/*` (4), `apps/web/public/openapi.json`, `apps/web/src/app/docs/page.tsx`, `apps/web/modules/docs/**` (4), `apps/web/src/lib/{isolate-browser-storage.ts,types/docs.ts}`, `apps/web/tests/{openapi-contract,openapi-fixtures,webhook-examples,docs-page}`, `examples/**` (11 incl. `tsconfig.json`, `package.json`), `docs/{S5-plan,S5-report,getting-started,troubleshooting,api-overview}.md`.
Modified: `apps/web/{package.json,next.config.ts,src/proxy.ts,modules/index.ts}`, root `package.json` (`examples:check`), `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `docs/{webhooks,state-machines}.md`.

## 11. Results
Web: 108 tests passed, 99 skipped (hosted-database suites), 0 failed; of these 47 are new. Core: 128 passed. `tsc --noEmit` clean for `@sandbox/web` and `@sandbox/core`; examples typecheck clean; `next build` succeeds (`/docs` static). Redocly: valid.

## 12. Needs your decision
1. Approve `vue-demi: false` in `pnpm-workspace.yaml` (§1).
2. OpenAPI `license` field (lint warning): which licence, if any.
3. Whether to close §8 gaps (root README, one external walk-through) and §3's hosted-suite check of the spec in a later, separately approved step.
4. Review, then say whether to commit. Nothing is committed.
