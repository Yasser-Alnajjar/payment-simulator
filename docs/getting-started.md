# Getting started with the Payment Sandbox

A test-mode payment provider. You create hosted checkouts, simulate every outcome (success, decline, pending, timeout, ...), save and charge **test** cards, and receive signed webhooks. **No real money, no real cards, no real provider.**

Everything below uses a base URL, written `$BASE`. For a deployment that is its `https://...` address; for a local run it is `http://localhost:3100`. The interactive API reference is at `$BASE/docs` and the machine-readable spec at `$BASE/openapi.json`.

Runnable code: [`examples/`](../examples) (TypeScript, Node 22+, no dependencies; run a file with `npx tsx <file>`).

## 1. Get an account and an API credential
1. Open `$BASE/register`, create an account, sign in.
2. Open **Credentials** in the dashboard and create a credential. You get a **client id** (`sbx_...`) and a **client secret** (`sbx_sk_...`). The secret is shown **once**; store it now.
3. Export them:
   ```bash
   export SANDBOX_BASE_URL=http://localhost:3100   # or your deployment
   export SANDBOX_CLIENT_ID=sbx_...
   export SANDBOX_CLIENT_SECRET=sbx_sk_...
   ```
Authentication is HTTP Basic (`client id : client secret`) on every `/api/v1` call. Revoke a credential in the dashboard at any time; revocation is immediate.

## 2. Your first checkout (about 2 minutes)
```bash
curl -s -u "$SANDBOX_CLIENT_ID:$SANDBOX_CLIENT_SECRET" -X POST "$SANDBOX_BASE_URL/api/v1/checkout/sessions" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: first-checkout-1' \
  -d '{"amount":"149.00","currency":"USD","external_reference":"order-1"}'
```
You get a session (`cs_...`, status `open`) and a `url`. Open the `url` in a browser: this is the hosted checkout. Pick a simulated outcome (for example **Success**) and confirm.

Now read the result:
```bash
curl -s -u "$SANDBOX_CLIENT_ID:$SANDBOX_CLIENT_SECRET" "$SANDBOX_BASE_URL/api/v1/checkout/sessions/cs_..."     # status: completed
curl -s -u "$SANDBOX_CLIENT_ID:$SANDBOX_CLIENT_SECRET" "$SANDBOX_BASE_URL/api/v1/payments?limit=5"            # the payment, status: succeeded
curl -s -u "$SANDBOX_CLIENT_ID:$SANDBOX_CLIENT_SECRET" "$SANDBOX_BASE_URL/api/v1/events?limit=5"              # payment.succeeded, checkout.session.completed
```
The same in TypeScript: [`examples/typescript/01-create-checkout.ts`](../examples/typescript/01-create-checkout.ts) then [`02-wait-for-payment.ts`](../examples/typescript/02-wait-for-payment.ts).

Things to know right away:
- **Amounts are decimal strings** (`"149.00"`) with an integer twin `amount_minor` (14900). Zero-, two- and three-decimal currencies are handled (`JPY`, `USD`, `KWD`, ...). Unsupported currencies are refused with `unsupported_currency`.
- **The `url` is returned only once** and contains a secret token. Treat it like a credential.
- **Idempotency-Key**: send one on every create you might retry. The same key and body returns the original response (`Idempotent-Replayed: true`); the same key with a different body is `422 idempotency_key_reused`.
- **Unknown request fields are rejected** (`unknown_parameter`), not ignored.

## 3. Choosing the outcome
Either let the payer pick on the hosted page, or fix it when you create the session with `"scenario"` (then the page cannot change it):

| `scenario` | Payment is | Then |
|---|---|---|
| `success` | `succeeded`, session `completed` | |
| `decline` | `failed` (`declined`) | session stays open, the payer can retry |
| `cancel` | `cancelled` (`payment_cancelled`) | session stays open |
| `pending` | `pending` | stays pending until you resolve it in the dashboard, or the session expires or is cancelled |
| `timeout` | `pending` | as `pending`, but expiry records `failure_code: timeout` |
| `pending_then_success` | `pending` | becomes `succeeded` after a delay (default 5 s) |
| `pending_then_failure` | `pending` | becomes `failed` after a delay |

To test expiry, create a session with a short `"expires_in"` (minimum 300 seconds) and wait. A session allows at most 10 payment attempts. Details: [`state-machines.md`](state-machines.md).

## 4. Test cards (saved cards and card payments)
The simulator accepts **only** these numbers; any other number, including a real card, is refused with `not_a_test_card`. Use any future expiry and a 3-digit security code (4 digits for Amex).

| Number | Brand | Behaviour |
|---|---|---|
| `4242424242424242` | Visa | saves and charges successfully |
| `5555555555554444` | Mastercard | saves and charges successfully |
| `378282246310005` | Amex | saves and charges successfully (4-digit code) |
| `6011111111111117` | Discover | saves and charges successfully |
| `5078030000000003` | Meeza | saves and charges successfully |
| `4000000000000002` | Visa | every charge fails: `card_declined` |
| `5105105105105100` | Mastercard | every charge fails: `card_declined` |
| `4000000000009995` | Visa | every charge fails: `insufficient_funds` |
| `4000002500003155` | Visa | every charge fails: `authentication_required` |
| `4000000000000119` | Visa | every charge fails: `processor_error` |
| `4000000000000341` | Visa | refused when saved (`402 card_declined`); never stored |

Save a card for a customer and charge it with no checkout page: [`examples/typescript/03-saved-card-charge.ts`](../examples/typescript/03-saved-card-charge.ts). Two behaviours differ on purpose, see the API overview: a declined **charge** is a successful call returning a payment with `status: "failed"`; a card that is declined **when saved** is `402`.

## 5. Webhooks
1. Run a receiver reachable from the internet over **HTTPS** (private, loopback and internal addresses are refused to protect against SSRF). Locally, use a tunnel (cloudflared, ngrok). Starter: [`examples/webhooks/node-receiver.ts`](../examples/webhooks/node-receiver.ts) or the Next.js route [`nextjs-route.ts`](../examples/webhooks/nextjs-route.ts).
2. Register it ([`05-webhook-endpoint.ts`](../examples/typescript/05-webhook-endpoint.ts) does steps 2-4):
   ```bash
   curl -s -u "$SANDBOX_CLIENT_ID:$SANDBOX_CLIENT_SECRET" -X POST "$SANDBOX_BASE_URL/api/v1/webhook-endpoints" \
     -H 'Content-Type: application/json' -H 'Idempotency-Key: endpoint-1' \
     -d '{"url":"https://YOUR-TUNNEL/webhooks","enabled_events":["payment.succeeded","payment.failed"]}'
   ```
   The response contains the signing `secret` (`whsec_...`) **once**.
3. Start the receiver with that secret: `WEBHOOK_SECRET=whsec_... npx tsx examples/webhooks/node-receiver.ts`.
4. Send a test event: `POST /api/v1/webhook-endpoints/{id}/test`, then read `GET /api/v1/webhook-deliveries/{id}`. **Deliveries are sent by a scheduler that runs once a minute**, so expect up to about a minute.
5. Complete a checkout with the `success` scenario and watch `payment.succeeded` arrive.

**Verify every signature**, on the raw body, before trusting a delivery (the examples do): [`webhooks.md`](webhooks.md) has the algorithm; [`examples/webhooks/verify.ts`](../examples/webhooks/verify.ts) is a copy-paste verifier with replay protection and rotation support. Delivery is **at least once** and unordered: deduplicate on the event id.

Practice failure handling without breaking your receiver: set the endpoint's `failure_mode` (`http_500`, `timeout`, `invalid_signature`, `delay`, `duplicate`, `out_of_order`) with `PATCH /api/v1/webhook-endpoints/{id}` or in the dashboard; simulated attempts are marked `simulated: true` in the delivery history. Use `POST /api/v1/webhook-deliveries/{id}/retry` to retry now.

## 6. Limits you will meet
| What | Limit |
|---|---|
| API requests | 100 per minute per account (`X-RateLimit-*` headers, `429 rate_limited` with `Retry-After`) |
| Failed authentications | 30 per minute per address and per credential id, then `429 too_many_failed_attempts` |
| Request body | 64 KiB |
| Webhook endpoints | 16 per account; 1-12 attempts each (default 8) |
| Saved cards | per-customer maximum (`payment_method_limit_reached`) |
| Test events / manual retries | 10 per endpoint per minute / 10 per account per minute |

## 7. Running the sandbox yourself
You need the operator's deployment URL for the sections above. To run your own copy you need Node 22+, pnpm, and a **hosted Supabase project** (there is no local database mode): copy `.env.example` to `.env`, fill it in, apply the migrations in `packages/db/prisma/migrations` to your project, then `pnpm install && pnpm dev` (port 3100). The scheduler that sends webhooks and settles expired sessions is described in [`scheduler-setup.md`](scheduler-setup.md); without it, webhooks are queued but never sent.

## 8. Where next
- Every endpoint, schema and error code: `$BASE/docs` or [`api-overview.md`](api-overview.md).
- Something failed: [`troubleshooting.md`](troubleshooting.md).
