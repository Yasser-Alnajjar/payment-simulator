# Operations: deployment, backups and recovery

Status: written from the repository and from Supabase's and Vercel's public documentation as I understand it; **backup settings, plan tier and retention could not be verified** (no dashboard access, R-DB-1). Items marked **[operator]** must be checked by whoever owns the Supabase and Vercel projects. Provider limits change; confirm them on the provider's pages before relying on them.

## 1. What data matters
Everything is in the hosted Supabase project: PostgreSQL (application data, 15 tables, `_prisma_migrations`), Supabase Auth users, Vault secrets (`sandbox_tick_url`, `sandbox_tick_secret`), `pg_cron` jobs. Nothing else is stateful: the web app on Vercel is stateless and rebuilt from git. All data is **test data**, but accounts, API credentials and webhook endpoints are users' configuration and cost effort to recreate. Secrets are kept as hashes (API secrets) or encrypted with `SECRETS_ENCRYPTION_KEY` (webhook endpoint secrets, idempotent-replay tokens).

**`SECRETS_ENCRYPTION_KEY` is part of the backup.** A database restore without it leaves encrypted webhook secrets unreadable. There is no key-rotation tool in the code today; losing the key means endpoints must be recreated or their secrets rotated. Store it in a password manager, separate from the database. **[operator]**

## 2. Backups **[operator]**
1. Supabase dashboard → Database → Backups: record the plan, whether daily backups are on, retention, and whether Point-in-Time Recovery is enabled. Free-tier projects have no downloadable/PITR guarantees as far as I know; verify.
2. Decide the target and write it here: **RPO** (how much data loss is acceptable; daily backups mean up to ~24 h, PITR means minutes) and **RTO** (how long to be back).
3. Independent logical copy (recommended, not automated): `pg_dump` of the `public` schema from a machine you control, using the direct connection, stored encrypted off-platform. Run before any migration. Never print the connection string.
4. The Auth users live in the `auth` schema; a restore of the whole project includes them, a dump of `public` alone does not.

## 3. Restore runbook (to rehearse **[operator]**, never rehearse on the live project)
1. Stop writers: pause the cron job `SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='sandbox-scheduler-tick'), active := false);`.
2. Restore from the dashboard (backup or PITR) into a **new** project when possible; otherwise in place.
3. Check: `pnpm --filter @sandbox/db migrate:status` (all four migrations applied, no drift), `pnpm --filter @sandbox/db verify:s1`, `verify:s2`, `verify:s4` (read-only).
4. Re-check `ops/001` and `ops/002` privileges and RLS (see §5): restores into a new project can reset default privileges.
5. Point `DATABASE_URL`, `DIRECT_URL`, Supabase URL/keys and `SECRETS_ENCRYPTION_KEY` in Vercel at the restored project; redeploy.
6. Recreate Vault secrets and cron jobs with `ops/003_s4_scheduler.sql` (**not idempotent**: `vault.create_secret` fails if the names already exist and `cron.schedule` replaces by name; remove or update first). Enable the job.
7. Smoke test: `/healthz`, an authenticated `GET /api/v1/events`, one checkout, one webhook delivery.
8. Expect: deliveries that were `retrying` at backup time resume; deliveries sent after the backup point may be **sent again** (receivers must deduplicate by event id; the docs already say so).

## 4. Deployment checklist
Environment (Vercel, Production) **[operator]**: `APP_ENV=production`, `APP_URL` (the public https URL), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_URL` (transaction pooler), `DIRECT_URL` (migrations only; not needed at runtime), `SECRETS_ENCRYPTION_KEY`, `SCHEDULER_TICK_SECRET` (≥ 32 chars). Must be **unset** on Vercel: `ALLOW_PRIVATE_WEBHOOK_TARGETS`, `SANDBOX_TEST_*`. Never set the Supabase `service_role` key (the app does not use it).

Fail-closed behaviour (from code): invalid or missing Supabase URL/key or encryption key throws at first use with the variable **names** only; `SCHEDULER_TICK_SECRET` unset or short makes the tick route answer `404`; `ALLOW_PRIVATE_WEBHOOK_TARGETS` is refused outside `APP_ENV=development` and on Vercel/production. **Not fail-closed:** an unset `APP_ENV` defaults to `development` and an unset `APP_URL` defaults to `http://localhost:3100` outside Vercel, so a non-Vercel deployment that forgets them would emit localhost checkout links. Set both explicitly.

Order for releases that change the schema: back up, migrate (`migrate:deploy`), `verify:*`, then deploy the web build. The S4 code inserts delivery rows in every event transaction, so code before migration breaks payments. Rollback: forward fix preferred; `docs/S4-rollback.sql` is documentation only and destroys webhook history.

Also check **[operator]**: Vercel Root Directory `apps/web`, production commit matches `main`, function `maxDuration` 60, domain HTTPS, preview deployments do not share the production database or secrets, Supabase Auth redirect URLs and email settings, Supabase project not paused (free projects pause after inactivity and stop cron), alerting on `/healthz` (liveness only) and on the dashboard's "last scheduler run" warning.

## 5. Periodic checks
- Weekly: Webhooks page shows a recent scheduler run; `cron.job_run_details` recent runs succeeded; `net._http_response` has no repeated errors.
- After any restore or project change: RLS enabled on all 15 tables, no grants to `anon`/`authenticated`/`service_role` (`verify:s1/s2/s4` check this).
- Rotate `SCHEDULER_TICK_SECRET` using `SCHEDULER_TICK_SECRET_PREVIOUS` (steps in `ops/003_s4_scheduler.sql`).
