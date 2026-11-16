# State machines, events and bounded behaviour (S2, as implemented)

Source of truth in code: `packages/core/src/state-machine.ts`, `scenarios.ts`; transitions applied in `apps/web/src/server/lifecycle.ts`; backstops in the S2 migration triggers and indexes.

## Checkout session
`open -> completed | expired | cancelled`. All three targets are terminal. Nothing else is allowed (including `open -> open`).
- `completed`: set in the same transaction as a payment becoming `succeeded`.
- `expired`: an open session whose `expires_at` has passed, applied lazily on touch (read, list sweep, cancel, payment attempt) or by the exported `sweepAll` (S4 worker). Any `pending` payment is cancelled in the same transaction first.
- `cancelled`: `POST .../cancel`. A pending payment is cancelled in the same transaction. Repeating the call on an already cancelled session returns the cancelled session (idempotent); cancelling a `completed` or `expired` session is `409 invalid_state_transition`.
- Amount, currency, token hash, owner, preset scenario and expiry never change (trigger). Terminal rows cannot change at all (trigger).

## Payment (transaction)
Created directly in any status; then `pending -> succeeded | failed | cancelled`; the last three are terminal and immutable (trigger). Every change increments `version` by exactly 1 (trigger) and is applied with `UPDATE ... WHERE id AND status = expected AND version = expected`.
- At most one `pending` or `succeeded` payment per session (partial unique index `transactions_one_active_per_session`). A `failed` or `cancelled` payment leaves the session open for another attempt; a `succeeded` one completes it.
- Amount and currency are copied from the session and tied to it by the composite FK `(checkout_session_id, user_id, amount_minor, currency)`.

## Scenarios (`scenario` on session creation presets and locks it; otherwise the hosted page / service caller chooses)
| Scenario | Payment is created as | Later |
|---|---|---|
| `success` | `succeeded` (session `completed`) | |
| `decline` | `failed`, `failure_code = declined` | session stays open |
| `cancel` | `cancelled`, `failure_code = payment_cancelled` | session stays open |
| `pending` | `pending` | stays pending until an operator resolves it (`resolvePendingPayment`) or the session expires/cancels (payment `cancelled`, `failure_code = session_expired` / `session_cancelled`) |
| `timeout` | `pending` | as `pending`, but expiry records `failure_code = timeout` |
| `pending_then_success` | `pending`, `resolve_at = now + delay` | becomes `succeeded` when due |
| `pending_then_failure` | `pending`, `resolve_at = now + delay` | becomes `failed` (`declined`) when due |
Delay: 1 to 3600 seconds, default 5. An expired checkout session is not a selectable scenario: create a session with a short `expires_in`.

## Bounded, documented timing behaviour
- Session lifetime: `expires_in` 300 to 86400 seconds, default 1800. Every payment is therefore resolved or cancelled no later than the session's expiry.
- Due work is applied lazily and in time order inside one locked transaction: a scheduled resolution earlier than `expires_at` is applied first; then expiry. If the resolution time is at or after expiry, the session expires first and the payment is cancelled.
- List endpoints sweep at most 25 due sessions for the calling user before reading. `sweepAll(db, now, limit)` is the bounded global sweep the S4 worker will call. (S2 text) Since S4 the scheduler tick (`docs/scheduler-setup.md`) also applies due resolutions and expiries about once a minute, so settlement no longer depends on someone reading the session.
- Concurrency: every mutation takes `SELECT ... FOR UPDATE` on the session row first, so attempts, resolution, expiry and cancellation are serialized per session; conditional updates and the partial unique index remain as backstops.

## Events (outbox)
Types (S2): `checkout.session.completed|expired|cancelled`, `payment.pending|succeeded|failed|cancelled`. Later phases added `payment_method.created|updated|default_updated|disabled|deleted` (S3) and `webhook_endpoint.test` (S4); the complete list and every `data` shape are in the OpenAPI `Event` schema and `docs/api-overview.md`.
- Exactly one event per successful transition (and one for creation of a payment, named after its initial status), written in the same database transaction as the change, so an event cannot exist without its change or the reverse.
- Uniqueness: `(user_id, subject_id, type)` is unique. `subject_id` is the payment id for `payment.*` and the session id for `checkout.session.*`.
- Ordering: `seq` (identity, creation order); API lists are newest first and paginate with `starting_after`. `seq` is assigned at insert, not at commit, so under concurrency commit order can differ slightly from `seq` order.
- Payload: serialized once into a `text` column and returned byte for byte. Envelope keys in fixed order: `id, object, type, created, api_version, data`.
- Immutability: UPDATE and TRUNCATE are rejected by triggers. DELETE is allowed so deleting an Auth user cascades; a future retention purge needs its own controls (S6).
- Indexes: `(user_id, seq desc)` and `(user_id, type, seq desc)` serve the list and type filter; the unique index serves duplicate prevention.

## Public checkout abuse limits (S3 hardening)
Applied only to the public payment *attempt* (`attemptPaymentByToken`); page loads, status polling, customer cancel and operator resolution are never counted. Constants: `DEFAULT_CHECKOUT_LIMITS` in `apps/web/src/server/services/payments.ts`. No migration: counters reuse `auth_failure_windows` (scope `global`, free-form bucket names `checkout-pay:*`).
| Limit | Default | Enforcement |
|---|---|---|
| Payment attempts per session (all statuses, so retries after decline/cancel count) | 10 | `COUNT` under the session row lock `FOR UPDATE`; concurrent attempts are serialized, so it cannot be exceeded. 429 `too_many_payment_attempts`. |
| Attempt requests per merchant per minute | 300 | one atomic upsert on the database clock; consumed first, so a flooding merchant cannot spend the global budget |
| Attempt requests per minute, whole app | 1200 | same upsert, bucket `checkout-pay:all` |
| Well-formed but unknown tokens per minute | 120 | own bucket, so token-guessing floods cannot starve real customers |
Windows are fixed one-minute windows (a burst straddling a boundary can briefly reach 2x). Rejections are 429 `too_many_requests` with `Retry-After: 60`.
**What a rejected request writes.** A rejection never creates a payment, event or session change, but it is not write-free: each counter is incremented by an autocommitted upsert *before* its limit is checked, so the request that is refused is itself counted (counters keep rising during a flood and reset with the minute window). Concretely: merchant limit exceeded -> only the merchant counter is written (the global counter is not touched); global limit exceeded -> the merchant counter and the global counter are both incremented; unknown-token limit exceeded -> only the unknown-token counter. Per-session cap exceeded -> both window counters were already incremented, and no payment is created. Limits deliberately do not use client IP: the merchant (from a valid token) and the session are trustworthy identities; the first `X-Forwarded-For` hop is only trusted by the API auth path, which still requires a proxy that overwrites that header at deploy time.
