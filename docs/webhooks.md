# Webhooks (S4): receiver guide and behaviour

## Endpoints
`POST/GET /api/v1/webhook-endpoints`, `GET/PATCH/DELETE /api/v1/webhook-endpoints/{we_…}`, `POST …/{id}/test`, `POST …/{id}/rotate-secret`,
`GET /api/v1/webhook-deliveries` (filters `endpoint_id`, `event_id`, `status`), `GET …/{whd_…}` (with attempts), `POST …/{whd_…}/retry`.
All use API credentials (Basic auth), the usual error envelope and cursor pagination. Also available in the dashboard under **Webhooks**.

- URL: `https` only; no credentials, no fragment; port 443, 80 or 1024-65535; no `localhost`, `*.local`, `*.internal`, single-label hosts or private/reserved IP literals. Hosts that resolve to private addresses are refused at send time.
- `enabled_events`: `["*"]` (all, including future types) or 1-32 event types. `webhook_endpoint.test` is never subscribable: test events go only to the endpoint that requested them.
- Up to 16 endpoints per account. `max_attempts` 1-12 (default 8). `Idempotency-Key` accepted on create (a replay returns the same secret).
- The signing secret (`whsec_…`) is returned **only** by create and rotate-secret. Store it then; it cannot be shown again.
- Delete is a soft delete: pending deliveries are cancelled, history stays readable.

## Request format
```
POST <your url>
Content-Type: application/json
User-Agent: SandboxPayments-Webhooks/1
Sandbox-Event-Id: evt_…
Sandbox-Delivery-Id: whd_…
Sandbox-Delivery-Attempt: 1
Sandbox-Timestamp: 1763121600
Sandbox-Signature: t=1763121600,v1=5f0c…[,v1=…]

{"id":"evt_…","object":"event","type":"payment.succeeded","created":"…","api_version":"2026-11-01","data":{…}}
```
The body is the stored event payload, byte for byte; every attempt of a delivery sends identical bytes.

## Verifying the signature
`v1 = hex(HMAC-SHA256(key = your whsec_ secret string, message = t + "." + raw_body))`. Verify against the **raw bytes**, compare in constant time, accept any `v1` (two are sent for 24 hours after a rotation), and reject timestamps more than 5 minutes from now.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody: Buffer, header: string | undefined, secret: string, toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=", 2) as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  return parts.filter(([k]) => k === "v1").some(([, v]) => {
    const got = Buffer.from(v, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
```
(The reference implementation used by the tests is `verifyWebhookSignature` in `packages/core/src/webhook-signature.ts`.)

## Delivery guarantees
- **At least once.** You can receive the same event more than once: when our 10 s timeout fires after your server already processed the request; when a scheduler run is killed or loses its lease between sending and recording; on a manual retry; or in `duplicate` simulation. **Deduplicate on the event `id` taken from the verified body** (the other headers are not signed).
- **No ordering guarantee.** Use the event `created` time and the object's current state.
- **Timing.** Deliveries are sent by a scheduler that runs about once a minute, so the first attempt happens up to ~80 s after the event.
- Answer 2xx quickly. Redirects are not followed (a 3xx fails permanently).

## Retries
After attempt n the next one is scheduled `min(30 s × 2^(n-1), 1 h)` ±20 % later (effective granularity one minute), up to `max_attempts`. Retried: timeouts, connection/TLS/DNS errors, 408, 429 (honouring `Retry-After` up to 1 h), 5xx, and attempts whose result was lost (`abandoned`). Not retried: other 4xx, 3xx, blocked or invalid URLs. A manual retry sends one more attempt; if it fails the delivery stays `failed`. Disabled endpoints keep their deliveries pending until re-enabled.

## Attempt history
Each attempt records: number, trigger (`scheduled`/`manual`), outcome (`success`/`retryable`/`permanent`/`abandoned`), status code, error code, duration, the first 1 KB of the response (sanitized) and `content-type`/`content-length`/`retry-after`, whether it was **simulated**, whether it was a **late result** after the lease was lost (`stale`), and which signature was sent (`valid`, `valid_dual`, `injected_invalid`).

## Failure simulation (per endpoint, `PATCH … {"failure_mode": …}`)
| Mode | Effect | Receiver contacted |
|---|---|---|
| `http_500` | attempt recorded as HTTP 500, retried by policy | no |
| `timeout` | attempt recorded as a timeout, retried by policy | no |
| `invalid_signature` | real request signed with a random key | yes |
| `duplicate` | the same request is sent twice within one attempt | yes |
| `delay` | new deliveries wait `failure_delay_seconds` (1-300) before the first attempt | yes |
| `out_of_order` | new deliveries get a random 0..`failure_delay_seconds` delay | yes |

`failure_mode_remaining` (1-100, attempt modes only) makes it "fail N times, then recover": the mode returns to `none` automatically. Only the endpoint's owner can set a mode; there is no global or environment switch.
