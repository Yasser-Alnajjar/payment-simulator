import { EVENT_TYPES } from "./state-machine";

/**
 * Event types an endpoint can subscribe to. "*" means all, including types added later. `webhook_endpoint.test` is not subscribable:
 * a test event is delivered only to the endpoint it was sent to.
 */
export const WEBHOOK_SUBSCRIBABLE_EVENTS: readonly string[] = EVENT_TYPES.filter((t) => t !== "webhook_endpoint.test");
export const WEBHOOK_MAX_ENABLED_EVENTS = 32;
export const WEBHOOK_MAX_ENDPOINTS_PER_USER = 16;

/**
 * Per-endpoint failure simulation (owner-set, default none). There is deliberately no global or environment switch.
 *  - http_500 / timeout: the attempt is recorded as that failure WITHOUT contacting the receiver, then retried by policy.
 *  - invalid_signature: the real request is sent, signed with a random key.
 *  - delay: the first attempt of each new delivery is scheduled failure_delay_seconds later.
 *  - duplicate: the same request (same bytes, same signature) is sent twice within one attempt.
 *  - out_of_order: the first attempt of each new delivery is scheduled a random 0..failure_delay_seconds later.
 */
export const FAILURE_MODES = ["none", "http_500", "timeout", "invalid_signature", "delay", "duplicate", "out_of_order"] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];
export const FAILURE_DELAY_MIN = 1;
export const FAILURE_DELAY_MAX = 300;

export const DELIVERY_STATUSES = ["pending", "retrying", "succeeded", "failed", "cancelled"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const matchesEnabledEvents = (type: string, enabled: readonly string[]): boolean => enabled.includes("*") || enabled.includes(type);

/** Validates and normalizes a subscription list: "*" alone, or 1-32 distinct known event types. */
export function normalizeEnabledEvents(list: readonly string[]): { ok: true; value: string[] } | { ok: false; message: string } {
  const uniq = [...new Set(list)];
  if (uniq.length === 0) return { ok: false, message: "enabled_events must contain at least one event type or \"*\"" };
  if (uniq.includes("*")) return uniq.length === 1 ? { ok: true, value: ["*"] } : { ok: false, message: "\"*\" cannot be combined with other event types" };
  if (uniq.length > WEBHOOK_MAX_ENABLED_EVENTS) return { ok: false, message: `enabled_events may list at most ${WEBHOOK_MAX_ENABLED_EVENTS} event types` };
  const unknown = uniq.find((t) => !WEBHOOK_SUBSCRIBABLE_EVENTS.includes(t));
  if (unknown !== undefined) return { ok: false, message: `Unknown event type: ${unknown.slice(0, 64)}` };
  return { ok: true, value: uniq.sort() };
}
