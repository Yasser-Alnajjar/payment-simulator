# API overview (S5)

Reference for everything the OpenAPI document cannot say well. The endpoints, schemas and every error code are in `$BASE/docs` (source: `apps/web/public/openapi.json`, generated from the code and checked against it by tests). Start with [`getting-started.md`](getting-started.md).

## Conventions
| Topic | Behaviour |
|---|---|
| Base path / version | `/api/v1`. The data version is `2026-11-01` and is written into every event as `api_version`. Responses may gain fields: ignore unknown ones. |
| Authentication | HTTP Basic with an API credential (client id : client secret), HTTPS only. Cookies and dashboard sessions are never accepted. Revoked and expired credentials are rejected on the next request. |
| Content | `application/json` in and out, request body at most 64 KiB. Unknown request fields are rejected. Only the **first** problem in a request is reported. |
| Money | `amount` decimal string + `amount_minor` integer + `currency` (ISO 4217, curated list). |
| Ids | Prefixed: `cs_` checkout session, `seti_` setup session, `pay_` payment, `pm_` payment method, `evt_` event, `we_` webhook endpoint, `whd_` webhook delivery. A wrong prefix is `404 resource_not_found`. |
| Ownership | Everything belongs to one account. Another account's resource is indistinguishable from a missing one (`404`). |
| Timestamps | ISO 8601 UTC. |
| Pagination | Lists are newest first. `limit` 1-100 (default 10), `starting_after` = the last id of the previous page, `has_more` says whether to continue. A cursor that is not one of your items is `400 invalid_cursor`. No total counts, no sort options. |
| Filters | `GET /checkout/sessions`: `status`, `external_reference`. `GET /payments`: `status`, `checkout_session_id`, `payment_method`, `customer`. `GET /payment-methods`: `customer`, `status`. `GET /events`: `type`. `GET /webhook-deliveries`: `endpoint_id`, `event_id`, `status`. |
| Rate limit | 100 requests per minute per account, fixed one-minute window. Every response carries `X-RateLimit-Limit/Remaining/Reset`; `429` adds `Retry-After`. |
| Request id | Every response, success or error, has a `Request-Id` header (also `error.request_id`). |
| Caching / CORS | `Cache-Control: no-store`; **no CORS headers**: call the API from a server, never from a browser page. |

## Errors
```json
{ "error": { "type": "invalid_request_error", "code": "invalid_parameter", "message": "amount must be a decimal string such as \"149.00\"", "param": "amount", "request_id": "req_..." } }
```
Branch on `code` (stable); `message` can change. Types: `authentication_error` (401), `invalid_request_error` (400, 404, 413, 415), `card_error` (402), `conflict_error` and `idempotency_error` (409, 422), `rate_limit_error` (429), `api_error` (500). The catalogue of every code, with its status, is in the OpenAPI document (each response lists its possible codes) and in [`troubleshooting.md`](troubleshooting.md).

## Idempotency
Send `Idempotency-Key` (1-255 of `A-Za-z0-9_.:-`) on creates you may retry. Same key + same body: the original response again, with `Idempotent-Replayed: true`, for checkout sessions even the `url` (rebuilt) and for webhook endpoints the same `secret`. Same key + different body: `422 idempotency_key_reused`. Same key while the first call is still running: `409 idempotency_key_in_progress` (retry shortly). **Required** on `POST /payments`. Only these four creates (`POST` checkout sessions, payments, payment-methods, webhook-endpoints) use the header; the other endpoints are safe to repeat (reads) or state-guarded (cancel, disable, delete, retry).

## Objects and lifecycles
- **Checkout session** `open -> completed | expired | cancelled` (terminal). `mode: "setup"` sessions (`seti_`) save a card for a `customer` and never charge. Settlement (expiry, delayed `pending_then_*` resolution) is applied lazily when you read, and by the scheduler within about a minute.
- **Payment** `pending -> succeeded | failed | cancelled` (terminal), or created directly in a final status. At most one pending/succeeded payment per session.
- **Payment method** (test card) `active`, `expired` (derived from the expiry date), `disabled` (final). One default per customer at most.
- **Webhook delivery** `pending -> retrying -> succeeded | failed`, or `cancelled` when its endpoint is deleted.
Full transition rules: [`state-machines.md`](state-machines.md).

## Events
Immutable, created in the same transaction as the change. `GET /events` returns exactly the bytes that webhooks send.

| Type | When |
|---|---|
| `payment.pending` / `payment.succeeded` / `payment.failed` / `payment.cancelled` | A payment is created in, or moves to, that status (checkout or saved-card charge). |
| `checkout.session.completed` / `.expired` / `.cancelled` | A session (payment or setup) reaches that status. `data.mode` is `"setup"` for setup sessions. |
| `payment_method.created` / `.updated` / `.default_updated` / `.disabled` / `.deleted` | Saved-card lifecycle. |
| `webhook_endpoint.test` | Only from `POST /webhook-endpoints/{id}/test`, only to that endpoint; not subscribable. |

Envelope: `{ id, object: "event", type, created, api_version, data }`. The `data` shape of every type is in the OpenAPI `Event` schema.

## Webhook delivery
HTTPS POST of the event; headers `Sandbox-Signature`, `Sandbox-Event-Id`, `Sandbox-Delivery-Id`, `Sandbox-Delivery-Attempt`, `Sandbox-Timestamp`. Success = any `2xx` within 10 s. Retries: 30 s x 2^(n-1) capped at 1 h, +/-20 % jitter, `Retry-After` honoured (cap 1 h), up to `max_attempts` (default 8). `408`, `429`, `5xx` and network errors retry; other `4xx` and redirects (never followed) are permanent. At least once, no ordering. Signatures, rotation and verification: [`webhooks.md`](webhooks.md) and `examples/webhooks/`.

## Known behaviours worth knowing (not bugs, but not obvious)
See [`S5-report.md`](S5-report.md) section "API observations" for the full list, including: setup sessions cannot be listed (only retrieved by id); a declined saved-card charge is `201` while a card declined at save time is `402`; webhook URL rule violations are reported as `invalid_url` (private/internal hosts as `url_not_allowed`); a delivery's attempt history is capped at its latest 100 attempts.
