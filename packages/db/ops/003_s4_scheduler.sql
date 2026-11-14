-- S4 scheduler setup on Supabase (Supabase Cron -> Vercel). NOT a Prisma migration and NOT run by any script in this repository.
-- Run it by hand in the Supabase SQL editor, only after explicit approval, and only after:
--   1. the S4 migration is applied and `verify:s4` passes,
--   2. SCHEDULER_TICK_SECRET is set on Vercel (Production) and the app with /api/scheduler/tick is deployed.
-- Replace the two <...> placeholders before running. Never commit the real values.
--
-- The tick job is created INACTIVE. Enabling it is a separate step (section 5) after the required tests pass.

-- ---------------------------------------------------------------- 1. extensions (skip if `verify:s4 -- --baseline` shows them installed)
-- Supabase recommends enabling these from Dashboard -> Integrations -> Cron / Database -> Extensions; the SQL equivalent:
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ---------------------------------------------------------------- 2. secrets in Supabase Vault (encrypted at rest; never in cron.job text)
SELECT vault.create_secret('https://<YOUR-PRODUCTION-DOMAIN>/api/scheduler/tick', 'sandbox_tick_url', 'Payment sandbox scheduler tick URL');
SELECT vault.create_secret('<SAME VALUE AS SCHEDULER_TICK_SECRET ON VERCEL>', 'sandbox_tick_secret', 'Bearer secret for the scheduler tick route');

-- ---------------------------------------------------------------- 3. the tick job: every minute, async HTTP POST via pg_net
-- pg_net's default timeout is 2 s. The tick works for at most ~25 s inside a function capped at 60 s (maxDuration), so 55 s is
-- set explicitly (the request is sent after the cron statement commits). A pg_net timeout does not stop the tick itself.
SELECT cron.schedule(
  'sandbox-scheduler-tick',
  '* * * * *',
  $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sandbox_tick_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sandbox_tick_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $job$
);
-- Keep it disabled until the required tests are complete (operator decision).
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'sandbox-scheduler-tick'), active := false);

-- ---------------------------------------------------------------- 4. cron history cleanup (Supabase-documented; cron.job_run_details is never purged automatically)
SELECT cron.schedule(
  'sandbox-cron-history-cleanup',
  '17 3 * * *',
  $job$ DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days' $job$
);

-- ---------------------------------------------------------------- 5. operations (run individually, each on approval)
-- Enable the tick:      SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'sandbox-scheduler-tick'), active := true);
-- Pause the tick:       SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'sandbox-scheduler-tick'), active := false);
-- Recent runs:          SELECT status, return_message, start_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
-- Recent HTTP results:  SELECT id, status_code, timed_out, error_msg, left(content, 300) FROM net._http_response ORDER BY created DESC LIMIT 10;
-- Rotate the secret:    SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'sandbox_tick_secret'), '<NEW VALUE>');
--                       (set SCHEDULER_TICK_SECRET_PREVIOUS=<old> and SCHEDULER_TICK_SECRET=<new> on Vercel first, redeploy, then update Vault)
-- Remove entirely:      SELECT cron.unschedule('sandbox-scheduler-tick'); SELECT cron.unschedule('sandbox-cron-history-cleanup');
