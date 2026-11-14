# Scheduler setup and deployment (S4): Supabase Cron → Vercel

**Every step that touches the hosted database (migration, Vault, Cron) needs separate, explicit approval (rule R-DB-1).**

## How it works
Supabase Cron (`pg_cron`) runs every minute and sends `POST https://<production-domain>/api/scheduler/tick` with `Authorization: Bearer <SCHEDULER_TICK_SECRET>` through `pg_net`. The route (a normal function of the Payment Next.js app on Vercel) takes a lease in PostgreSQL so ticks never overlap, settles due checkout and setup sessions (`sweepAll`, `sweepSetupAll`), then sends due webhook deliveries in batches for at most ~25 s. PostgreSQL holds all delivery state, claims, leases, attempts and retry schedules. No Vercel Cron, no separate worker, no queue service.

### Execution budget vs Vercel limits (checked 2026-11-14, vercel.com/docs/functions/limitations)
| Limit | Value |
|---|---|
| Vercel Hobby max function duration | 300 s |
| Route `maxDuration` | 60 s |
| Tick work budget | 25 s (stops claiming new batches when < 15 s remain; one send is capped at 5 s DNS + 10 s exchange) |
| `pg_net` request timeout (set in the cron job) | 55 s (default would be 2 s) |
| Scheduler lease | 90 s (> 60 s, so a killed tick blocks the next one for at most 90 s) |
| Delivery lease | 60 s |

## 1. Prerequisites (each on approval)
1. Read-only check: `pnpm --filter @sandbox/db verify:s4 -- --baseline` (confirms the payment-methods migration, `pg_cron`/`pg_net`/`supabase_vault` availability, database size).
2. Migration dry-run: `pnpm --filter @sandbox/db exec tsx scripts/dry-run-migration.ts 20261114120000_s4_webhooks` (rolled back).
3. Apply: `pnpm --filter @sandbox/db migrate:deploy`, then `pnpm --filter @sandbox/db verify:s4`.

**Deploy order matters:** the web code inserts webhook deliveries in every event transaction. Deploying it before the migration would make every payment fail.

## 2. Vercel
1. Generate a secret: `openssl rand -base64 48`.
2. Project → Settings → Environment Variables → Production: `SCHEDULER_TICK_SECRET=<value>`. Do **not** set `ALLOW_PRIVATE_WEBHOOK_TARGETS` on Vercel.
3. Deploy (your normal push/deploy). Check: `curl -i -X POST https://<domain>/api/scheduler/tick` → `404` (no secret) and with `-H "Authorization: Bearer <value>"` → `200` with a JSON summary.

## 3. Supabase (SQL editor; on approval)
Run `packages/db/ops/003_s4_scheduler.sql` after replacing the two placeholders (production URL, same secret). It enables the extensions if needed, stores both values in Vault, creates the tick job **inactive**, and a daily cleanup of `cron.job_run_details` (never purged automatically by Supabase).

Enable after the required tests pass (separate approval):
```sql
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'sandbox-scheduler-tick'), active := true);
```

## 4. Watching it
- Dashboard → Webhooks shows the last scheduler run and warns when none finished in 3 minutes.
- `SELECT status, return_message, start_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;`
- `SELECT status_code, timed_out, error_msg, left(content, 300) FROM net._http_response ORDER BY created DESC LIMIT 10;` (kept 6 h)
- Vercel function logs (Hobby keeps them 1 h) and the Usage page after the first day (Hobby includes 1M invocations, 4 h Active CPU, 360 GB-hrs memory per month; one tick per minute is 43,200 invocations).

## Recovery behaviour
- Tick killed mid-run (timeout, deploy): its scheduler lease expires after 90 s; in-flight deliveries' leases expire after 60 s and are re-claimed; the lost attempt is recorded as `abandoned` and counts toward `max_attempts`.
- Cron paused or Supabase project paused: nothing is lost; deliveries wait in PostgreSQL; sessions still settle when read. Supabase Free pauses projects after 1 week of inactivity (activity is not defined by Supabase).
- A failing session in a sweep is logged by id and skipped; it no longer blocks other sessions.

## Hosted integration tests
The harness refuses to run while the production tick has run in the last 3 minutes: pause the job first (`active := false`). Tests claim only their own deliveries by id, never call the global sweeps, and use their own `test-<runId>` scheduler row.
```
SANDBOX_TEST_TARGET=<flag> SANDBOX_TEST_EXPECTED_REF=<ref> pnpm --filter @sandbox/web test
```

## End-to-end check against the deployed app
1. `WEBHOOK_SECRET=whsec_… pnpm --filter @sandbox/db exec tsx ../../apps/web/scripts/e2e-receiver.ts 4545` and `cloudflared tunnel --url http://localhost:4545` (third-party tunnel; only test payloads pass through it).
2. Dashboard → Webhooks → add `https://<tunnel-host>/hook`, copy the secret into `WEBHOOK_SECRET`, restart the receiver.
3. "Send test event" → within ~80 s the receiver logs `signature=valid`; the dashboard shows `succeeded`.
4. API: create checkout sessions on the Vercel URL and pay on the hosted page (`success`, `decline`, `pending_then_success`) → `payment.*`, `checkout.session.*` events arrive signed.
5. Failure simulation: `http_500` with 2 remaining → two simulated failures then success; `invalid_signature` → receiver logs `INVALID`; `duplicate` → receiver logs `DUPLICATE(ignored)`; manual retry from the delivery page.
6. Create a session with `expires_in: 300` and do not open it → after expiry the tick's sweep emits `checkout.session.expired` → delivered.
7. Stop the receiver → attempts fail and back off → start it → the next retry succeeds; history is complete.
8. Overlap: call the tick manually with the secret while the cron job runs → one response is `{"skipped":"busy",…}`.
9. SSRF from production: `https://localhost/x`, `https://169.254.169.254/`, `https://10.0.0.1/` are refused at create; a public host name that resolves to a private address fails at send with `ssrf_blocked`.
