# Troubleshooting

Always note the `request_id` (body and `Request-Id` header) of a failing call. Branch on `error.code`, not on `message`. Every code below is in the OpenAPI document; a test fails if the code and this catalogue drift apart.

## Authentication and limits
| You see | Cause | Fix |
|---|---|---|
| `401 invalid_credentials` | No `Authorization` header, not `Basic`, wrong secret, or unknown client id. All look identical on purpose. | Send `Authorization: Basic base64(client_id:client_secret)`. `curl -u id:secret` does it. Check for trailing newlines in the env vars and that you copied the **secret** (`sbx_sk_...`) from creation time: it cannot be shown again, create a new credential if lost. |
| `401 credential_revoked` / `credential_expired` | The credential was revoked or reached its expiry date. | Create a new one in the dashboard and rotate your config. |
| `429 too_many_failed_attempts` | Too many bad credentials from your address or for that client id in a minute. | Stop, fix the credential, wait for `Retry-After` (60 s). Do not loop. |
| `429 rate_limited` | More than 100 requests in the current minute. | Wait `Retry-After`; batch or cache reads; use webhooks instead of polling. |
| `429 too_many_requests` | A per-action limit: webhook test sends (10/endpoint/min), manual retries (10/min), hosted checkout. | Wait `Retry-After`. |
| `429 too_many_payment_attempts` | A checkout session already had 10 payment attempts. | Create a new session. |
| `500 internal_error` | Unexpected server error. | Retry with the same `Idempotency-Key`; if it persists, report the `request_id`. |

## Requests that are refused (400, 413, 415)
| Code | Typical cause |
|---|---|
| `unsupported_media_type` | Missing `Content-Type: application/json` (curl with `-d` sends form encoding unless you set it). |
| `invalid_json` | Empty body, invalid JSON, or an array instead of an object. |
| `unknown_parameter` | A field the endpoint does not accept (typo, or a field from another endpoint). Fields are never silently ignored. |
| `invalid_parameter` | A field failed validation; `param` names it. Only the first problem is reported, so fix and retry. |
| `invalid_amount_format`, `too_many_decimals`, `amount_too_small`, `amount_too_large`, `unsupported_currency` | `amount` must be a **string** like `"149.00"` (no thousands separators), with no more decimals than the currency allows (`JPY` 0, `USD` 2, `KWD` 3). |
| `body_too_large` | Body over 64 KiB (metadata is capped at 50 keys / 4000 bytes). |
| `idempotency_key_required` | `POST /payments` needs an `Idempotency-Key`. |
| `invalid_idempotency_key` | Keys are 1-255 characters of `A-Za-z0-9_.:-`. |
| `invalid_cursor` | `starting_after` is not an id of that list that belongs to you. |
| `invalid_customer`, `customer_required`, `customer_mismatch` | `customer` is 1-128 of `A-Za-z0-9_.:@-`; a saved card belongs to exactly one customer. |
| `not_a_test_card` | Only the published test numbers work (see getting-started). A real card number is never accepted, by design. |
| `invalid_card_number`, `invalid_expiry`, `card_expired`, `invalid_cvc`, `invalid_cardholder_name` | Card field problems; `param` is e.g. `card.exp_year`. |
| `scenario_locked`, `scenario_required`, `scenario_with_card` | Hosted checkout: the creator fixed the scenario, no scenario was chosen, or a scenario was sent together with a card. |

## State conflicts (409) and not found (404)
| Code | Meaning / fix |
|---|---|
| `resource_not_found` | Wrong id, wrong prefix, deleted, or it belongs to another account. Check you are using the credential of the account that created it. |
| `invalid_state_transition` | The action does not fit the current state (cancelling a completed or expired session; changing a final payment). Read the resource first. |
| `session_expired`, `session_cancelled`, `session_already_paid`, `session_already_completed`, `payment_in_progress` | The hosted checkout cannot take another payment/card in that state. Create a new session. |
| `payment_method_disabled`, `payment_method_expired` | The card cannot be charged or made default. Save a new test card. |
| `duplicate_payment_method`, `payment_method_limit_reached`, `payment_method_conflict` | Same card already saved for that customer; per-customer card limit; or a concurrent change (retry). |
| `no_default_payment_method` | The customer has no default card (none saved, or the default was disabled). |
| `idempotency_key_in_progress` | The first request with this key is still running; retry shortly with the **same** key. |
| `idempotency_key_reused` (422) | Same key, different body. Use a new key for a new operation. |
| `card_declined` (402) | The test card is configured to be refused when saved (`4000000000000341`). A declined **charge** is not an error: it is a `201` payment with `status: "failed"`. |

## Webhooks
| Symptom | Check |
|---|---|
| `invalid_url` / `url_not_allowed` creating an endpoint | Must be `https`, no credentials, no `#fragment`, port 443/80/1024-65535, fully qualified public host. `localhost`, `*.local`, `*.internal`, private/loopback/link-local IPs are refused (SSRF protection), also at send time if DNS later resolves privately. Use a tunnel for local development. |
| `endpoint_limit_reached` | 16 endpoints per account; delete unused ones. |
| Nothing arrives | (1) Is the endpoint `enabled` and subscribed to that type (`enabled_events`)? (2) Look at `GET /webhook-deliveries?endpoint_id=...`: no delivery means the event type is not subscribed; `pending` means the next scheduler tick has not run yet (**up to ~1 minute**; dashboard Webhooks shows a warning if the scheduler has not run for 3 minutes). (3) Open the delivery: `attempts[].error_code` / `status_code` say what happened. |
| `error_code: ssrf_blocked`, `invalid_url`, `dns_error`, `connect_error`, `tls_error`, `timeout` | Your URL does not resolve to a public address, nothing listens, the TLS certificate is invalid, or you took longer than 10 s. Answer fast and process asynchronously. |
| `redirect_not_followed` / a `3xx` status | Redirects are never followed and count as permanent failures. Register the final URL. |
| Deliveries stop retrying, status `failed` | A non-retryable `4xx` or `max_attempts` reached. Fix the receiver, then `POST /webhook-deliveries/{id}/retry`. |
| `409 delivery_not_attempted` / `delivery_in_progress` / `delivery_cancelled` / `endpoint_disabled` | Retry only works on an attempted, idle delivery of an enabled, existing endpoint. |
| **Signature mismatch** | 1) Verify against the **raw bytes** (`await req.text()`, not `JSON.parse` then `JSON.stringify`; frameworks that parse the body first break this). 2) Use the endpoint's `whsec_...` secret **string** as the key, including the `whsec_` prefix. 3) Message is `t + "." + body`. 4) Keep the secret from creation or rotation: it is not shown again. 5) Right after a rotation two `v1` values are sent for 24 h: accept any match. 6) Clock skew: timestamps more than 5 minutes off are rejected, check your server clock. Test with `examples/webhooks/verify.ts`. |
| Duplicate deliveries | Expected: at least once. Deduplicate on `Sandbox-Event-Id`. The `duplicate` failure mode sends them on purpose. |
| Out-of-order events | Expected, no ordering guarantee. Use `created` and `GET /events/{id}`, or the `out_of_order` failure mode to rehearse it. |
| Delivery status `retrying` for a long time | Backoff grows up to 1 hour between attempts; use the manual retry for an immediate attempt. |

## Checkout and sessions
| Symptom | Cause |
|---|---|
| Session `expired` before you paid | Default lifetime 30 min (`expires_in` 300-86400 s). Expiry is applied when read or by the scheduler (within ~1 minute), so a session just past its time can briefly look `open` in a list. |
| `pending_then_success` never completes | It needs the scheduler (or a read of that payment/session) after the delay. Check the scheduler status in the dashboard. |
| Lost the checkout `url` | It is shown only at creation. Retry the create with the same `Idempotency-Key` to get it again, or create a new session. |

## Still stuck
Reproduce with `curl -i` (the response headers include `Request-Id`), compare with the schema in `$BASE/docs`, and check [`api-overview.md`](api-overview.md). If you run the sandbox yourself, `/healthz` and the scheduler notes in [`scheduler-setup.md`](scheduler-setup.md) cover the infrastructure side.
