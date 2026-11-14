import type { Prisma } from "@sandbox/db";

type Tx = Prisma.TransactionClient;

/** Test events are delivered only to the endpoint that asked for them (see sendTestEvent), never fanned out. */
export const TEST_EVENT_TYPE = "webhook_endpoint.test";

/**
 * Creates one `pending` delivery per enabled, non-deleted endpoint of the owner that subscribes to the event type. Runs inside the
 * caller's transaction (outbox). Tenant safety: endpoints are selected by the event's own user_id, and the composite foreign keys
 * (event_id, user_id) and (endpoint_id, user_id) make a cross-tenant pairing impossible at the database level. The unique
 * (event_id, endpoint_id) index plus ON CONFLICT DO NOTHING makes the insert idempotent.
 * Failure simulation `delay` / `out_of_order` only changes when the first attempt becomes due.
 */
export async function fanOutDeliveries(tx: Tx, e: { eventId: string; userId: string; type: string; now: Date }): Promise<number> {
  if (e.type === TEST_EVENT_TYPE) return 0;
  return tx.$executeRaw`
    INSERT INTO webhook_deliveries (user_id, event_id, endpoint_id, status, next_attempt_at, created_at, updated_at)
    SELECT w.user_id, ${e.eventId}::uuid, w.id, 'pending',
           CASE w.failure_mode
             WHEN 'delay' THEN ${e.now}::timestamptz + make_interval(secs => w.failure_delay_seconds)
             WHEN 'out_of_order' THEN ${e.now}::timestamptz + make_interval(secs => floor(random() * (w.failure_delay_seconds + 1)))
             ELSE ${e.now}::timestamptz
           END,
           ${e.now}::timestamptz, ${e.now}::timestamptz
      FROM webhook_endpoints w
     WHERE w.user_id = ${e.userId}::uuid AND w.status = 'enabled' AND w.deleted_at IS NULL
       AND (${e.type} = ANY (w.enabled_events) OR '*' = ANY (w.enabled_events))
    ON CONFLICT (event_id, endpoint_id) DO NOTHING`;
}
