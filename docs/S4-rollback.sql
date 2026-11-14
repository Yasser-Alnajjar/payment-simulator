-- S4 ROLLBACK. Documentation only: kept outside prisma/migrations so no tool can run it. Never run without explicit approval.
-- Destroys all webhook endpoints, deliveries and attempt history. Forward fixes are preferred.
--
-- Mandatory order:
--   1. Supabase: SELECT cron.unschedule('sandbox-scheduler-tick');  (and optionally 'sandbox-cron-history-cleanup')
--   2. Vercel: deploy a web build WITHOUT the S4 fan-out (emitEvent inserts into webhook_deliveries; with the tables gone every
--      payment transaction would fail).
--   3. Then run the statements below in one transaction.
--   4. Remove the 20261114120000_s4_webhooks row from _prisma_migrations only if the migration will be re-applied later
--      (separate approval; otherwise leave history as is and write a forward migration instead).

BEGIN;

-- Refuse if test events exist: restoring the old events_type_check would fail on them. They must be reviewed, not silently deleted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.events WHERE type = 'webhook_endpoint.test') THEN
    RAISE EXCEPTION 'events of type webhook_endpoint.test exist; review them before rolling back (the events table is append-only)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.api_idempotency_keys WHERE scope = 'webhook_endpoint.create') THEN
    RAISE EXCEPTION 'api_idempotency_keys rows with scope webhook_endpoint.create exist; review them before rolling back';
  END IF;
END $$;

DROP TABLE public.webhook_delivery_attempts;
DROP TABLE public.webhook_deliveries;
DROP TABLE public.webhook_endpoints;
DROP TABLE public.scheduler_leases;
DROP FUNCTION public.sandbox_webhook_attempts_guard();
DROP FUNCTION public.sandbox_webhook_deliveries_guard();
DROP FUNCTION public.sandbox_webhook_endpoints_guard();
DROP INDEX public.events_id_user_id_key;

ALTER TABLE public.events DROP CONSTRAINT events_type_check;
ALTER TABLE public.events ADD CONSTRAINT events_type_check CHECK (type IN (
  'checkout.session.completed','checkout.session.expired','checkout.session.cancelled','payment.pending','payment.succeeded','payment.failed','payment.cancelled',
  'payment_method.created','payment_method.updated','payment_method.default_updated','payment_method.disabled','payment_method.deleted'));
ALTER TABLE public.api_idempotency_keys DROP CONSTRAINT api_idempotency_keys_scope_check;
ALTER TABLE public.api_idempotency_keys ADD CONSTRAINT api_idempotency_keys_scope_check CHECK (scope IN ('payment_method.create','setup_session.create','charge.create'));

COMMIT;
