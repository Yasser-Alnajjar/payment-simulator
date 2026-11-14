import {
  FAILURE_MODES, generateWebhookSecret, newUuid, normalizeEnabledEvents, openBound, parsePublicId, requestFingerprint, sealBound, toPublicId,
  validateWebhookUrl, WEBHOOK_MAX_ATTEMPTS_DEFAULT, WEBHOOK_MAX_ENDPOINTS_PER_USER, type FailureMode,
} from "@sandbox/core";
import type { PrismaClient, WebhookDelivery, WebhookDeliveryAttempt, WebhookEndpoint } from "@sandbox/db";
import { writeAudit } from "../audit";
import { ApiError, conflict, invalidRequest, notFound } from "../api/errors";
import { consumeBucket } from "../api/rate-limit";
import { API_VERSION, emitEvent, TX_OPTIONS, type Tx } from "../lifecycle";
import { ENDPOINT_SECRET_PURPOSE, endpointSecretContext } from "../webhooks/config";
import { TEST_EVENT_TYPE } from "../webhooks/fanout";
import { claimIdempotency, finishIdempotency } from "./api-idempotency";
import type { Page } from "./checkout-sessions";

/**
 * Webhook endpoints and deliveries. Every query is scoped by { id, userId }: another user's id is simply "not found".
 * Endpoint secrets are generated here, returned only by create and rotate, and stored sealed (purpose- and owner-bound AES-GCM).
 */
export const SECRET_ROTATION_GRACE_HOURS = 24;
export const TEST_SENDS_PER_ENDPOINT_PER_MINUTE = 10;
export const MANUAL_RETRIES_PER_USER_PER_MINUTE = 10;
const ATTEMPT_TIME_MODES: readonly FailureMode[] = ["http_500", "timeout", "invalid_signature", "duplicate"];
const SCHEDULING_MODES: readonly FailureMode[] = ["delay", "out_of_order"];

export interface WebhookDeps { encKey: string; now: Date; allowPrivate: boolean }

function assertUrl(url: string, allowPrivate: boolean): string {
  const v = validateWebhookUrl(url, { allowPrivate });
  if (!v.ok) throw invalidRequest(v.code === "private_address" || v.code === "host_not_allowed" ? "url_not_allowed" : "invalid_url", v.message, "url");
  return v.target.url.toString();
}

function assertEvents(list: string[]): string[] {
  const r = normalizeEnabledEvents(list);
  if (!r.ok) throw invalidRequest("invalid_parameter", r.message, "enabled_events");
  return r.value;
}

interface Simulation { mode: FailureMode; remaining: number | null; delaySeconds: number | null }
function assertSimulation(s: Simulation): Simulation {
  if (!FAILURE_MODES.includes(s.mode)) throw invalidRequest("invalid_parameter", "Unknown failure_mode", "failure_mode");
  if (s.mode === "none") return { mode: "none", remaining: null, delaySeconds: null };
  if (SCHEDULING_MODES.includes(s.mode)) {
    if (s.delaySeconds === null) throw invalidRequest("invalid_parameter", `failure_delay_seconds is required for ${s.mode}`, "failure_delay_seconds");
    if (s.remaining !== null) throw invalidRequest("invalid_parameter", `failure_mode_remaining is not supported for ${s.mode}`, "failure_mode_remaining");
    return s;
  }
  if (s.delaySeconds !== null) throw invalidRequest("invalid_parameter", `failure_delay_seconds is only used by delay and out_of_order`, "failure_delay_seconds");
  if (!ATTEMPT_TIME_MODES.includes(s.mode)) throw invalidRequest("invalid_parameter", "Unknown failure_mode", "failure_mode");
  return s;
}

const lockUserEndpoints = (tx: Tx, userId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"webhook-endpoints|" + userId}, 0))`;

async function lockEndpoint(tx: Tx, userId: string, id: string): Promise<WebhookEndpoint | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM webhook_endpoints WHERE id = ${id}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL FOR UPDATE`;
  return rows.length ? tx.webhookEndpoint.findFirst({ where: { id, userId, deletedAt: null } }) : null;
}

const sealEndpointSecret = (secret: string, encKey: string, userId: string, id: string) => sealBound(secret, encKey, ENDPOINT_SECRET_PURPOSE, endpointSecretContext(userId, id));
const IDEM_SECRET_PURPOSE = "idempotency-webhook-secret";

// ---------------------------------------------------------------- endpoints

export interface CreateEndpointInput { url: string; description: string | null; enabledEvents: string[]; maxAttempts?: number; rawBody: unknown }

export async function createWebhookEndpoint(db: PrismaClient, deps: WebhookDeps, userId: string, input: CreateEndpointInput, idem: { key: string } | null): Promise<{ status: number; endpoint: WebhookEndpoint; secret: string; replayed: boolean }> {
  const url = assertUrl(input.url, deps.allowPrivate);
  const enabledEvents = assertEvents(input.enabledEvents);
  const id = newUuid();
  const secret = generateWebhookSecret();
  const requestHash = requestFingerprint("POST", "/api/v1/webhook-endpoints", API_VERSION, input.rawBody);
  return db.$transaction(async (tx) => {
    if (idem) {
      const tokenEnc = sealBound(secret, deps.encKey, IDEM_SECRET_PURPOSE, `${userId}|${idem.key}|${id}`);
      const c = await claimIdempotency(tx, userId, "webhook_endpoint.create", { key: idem.key, requestHash }, id, tokenEnc);
      if (!c.claimed) {
        const existing = await tx.webhookEndpoint.findFirst({ where: { id: c.replay.resourceId, userId } });
        if (!existing || !c.replay.tokenEnc) throw new ApiError(409, "idempotency_error", "idempotency_key_in_progress", "A request with this idempotency key is still being processed; retry shortly");
        const old = openBound(c.replay.tokenEnc, deps.encKey, IDEM_SECRET_PURPOSE, `${userId}|${idem.key}|${c.replay.resourceId}`);
        return { status: c.replay.status, endpoint: existing, secret: old, replayed: true };
      }
    }
    await lockUserEndpoints(tx, userId);
    const live = await tx.webhookEndpoint.count({ where: { userId, deletedAt: null } });
    if (live >= WEBHOOK_MAX_ENDPOINTS_PER_USER) throw conflict("endpoint_limit_reached", `At most ${WEBHOOK_MAX_ENDPOINTS_PER_USER} webhook endpoints per account`);
    const endpoint = await tx.webhookEndpoint.create({
      data: {
        id, userId, url, description: input.description, enabledEvents, maxAttempts: input.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS_DEFAULT,
        secretSealed: sealEndpointSecret(secret, deps.encKey, userId, id), createdAt: deps.now, updatedAt: deps.now,
      },
    });
    await writeAudit(tx, { userId, action: "webhook_endpoint.created", targetType: "webhook_endpoint", targetId: id });
    if (idem) await finishIdempotency(tx, userId, "webhook_endpoint.create", idem.key, 201, { id: toPublicId("webhookEndpoint", id) });
    return { status: 201, endpoint, secret, replayed: false };
  }, TX_OPTIONS);
}

export async function getWebhookEndpoint(db: PrismaClient, userId: string, publicId: string): Promise<WebhookEndpoint> {
  const id = parsePublicId("webhookEndpoint", publicId);
  const e = id ? await db.webhookEndpoint.findFirst({ where: { id, userId, deletedAt: null } }) : null;
  if (!e) throw notFound("Webhook endpoint");
  return e;
}

export async function listWebhookEndpoints(db: PrismaClient, userId: string, q: { limit?: number; startingAfter?: string }): Promise<Page<WebhookEndpoint>> {
  const limit = q.limit ?? 10;
  let after: bigint | undefined;
  if (q.startingAfter !== undefined) {
    const id = parsePublicId("webhookEndpoint", q.startingAfter);
    const cur = id ? await db.webhookEndpoint.findFirst({ where: { id, userId, deletedAt: null }, select: { seq: true } }) : null;
    if (!cur) throw invalidRequest("invalid_cursor", "starting_after does not match a webhook endpoint", "starting_after");
    after = cur.seq;
  }
  const rows = await db.webhookEndpoint.findMany({ where: { userId, deletedAt: null, ...(after !== undefined ? { seq: { lt: after } } : {}) }, orderBy: { seq: "desc" }, take: limit + 1 });
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export interface UpdateEndpointInput {
  url?: string;
  description?: string | null;
  enabledEvents?: string[];
  status?: "enabled" | "disabled";
  maxAttempts?: number;
  failureMode?: FailureMode;
  failureModeRemaining?: number | null;
  failureDelaySeconds?: number | null;
}

export async function updateWebhookEndpoint(db: PrismaClient, deps: WebhookDeps, userId: string, publicId: string, p: UpdateEndpointInput): Promise<WebhookEndpoint> {
  const id = parsePublicId("webhookEndpoint", publicId);
  if (!id) throw notFound("Webhook endpoint");
  const url = p.url !== undefined ? assertUrl(p.url, deps.allowPrivate) : undefined;
  const enabledEvents = p.enabledEvents !== undefined ? assertEvents(p.enabledEvents) : undefined;
  return db.$transaction(async (tx) => {
    const e = await lockEndpoint(tx, userId, id);
    if (!e) throw notFound("Webhook endpoint");
    const touchesSim = p.failureMode !== undefined || p.failureModeRemaining !== undefined || p.failureDelaySeconds !== undefined;
    const sim = touchesSim
      ? assertSimulation({
        mode: p.failureMode ?? (e.failureMode as FailureMode),
        remaining: p.failureModeRemaining !== undefined ? p.failureModeRemaining : p.failureMode !== undefined ? null : e.failureModeRemaining,
        delaySeconds: p.failureDelaySeconds !== undefined ? p.failureDelaySeconds : p.failureMode !== undefined ? null : e.failureDelaySeconds,
      })
      : null;
    const next = await tx.webhookEndpoint.update({
      where: { id },
      data: {
        ...(url !== undefined ? { url } : {}),
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(enabledEvents !== undefined ? { enabledEvents } : {}),
        ...(p.status !== undefined ? { status: p.status } : {}),
        ...(p.maxAttempts !== undefined ? { maxAttempts: p.maxAttempts } : {}),
        ...(sim ? { failureMode: sim.mode, failureModeRemaining: sim.remaining, failureDelaySeconds: sim.delaySeconds } : {}),
        version: e.version + 1, updatedAt: deps.now,
      },
    });
    const action = sim && sim.mode !== e.failureMode ? "webhook_endpoint.failure_mode_set"
      : p.status && p.status !== e.status ? `webhook_endpoint.${p.status}` : "webhook_endpoint.updated";
    await writeAudit(tx, { userId, action, targetType: "webhook_endpoint", targetId: id, ...(sim ? { metadata: { failure_mode: sim.mode } } : {}) });
    return next;
  }, TX_OPTIONS);
}

/** Soft delete: history is kept; pending deliveries are cancelled in the same transaction (a lease in flight is revoked). */
export async function deleteWebhookEndpoint(db: PrismaClient, userId: string, publicId: string, now: Date): Promise<{ id: string; cancelledDeliveries: number }> {
  const id = parsePublicId("webhookEndpoint", publicId);
  if (!id) throw notFound("Webhook endpoint");
  return db.$transaction(async (tx) => {
    const e = await lockEndpoint(tx, userId, id);
    if (!e) throw notFound("Webhook endpoint");
    const cancelled = await tx.$executeRaw`
      UPDATE webhook_deliveries SET status = 'cancelled', next_attempt_at = NULL, lease_token = NULL, locked_until = NULL, manual_pending = false,
             completed_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
       WHERE endpoint_id = ${id}::uuid AND user_id = ${userId}::uuid AND status IN ('pending','retrying')`;
    await tx.webhookEndpoint.update({ where: { id }, data: { deletedAt: now, status: "disabled", version: e.version + 1, updatedAt: now } });
    await writeAudit(tx, { userId, action: "webhook_endpoint.deleted", targetType: "webhook_endpoint", targetId: id });
    return { id: toPublicId("webhookEndpoint", id), cancelledDeliveries: cancelled };
  }, TX_OPTIONS);
}

/** New secret now; the previous one keeps signing (second v1) for 24 hours so receivers can switch without dropping events. */
export async function rotateWebhookSecret(db: PrismaClient, deps: WebhookDeps, userId: string, publicId: string): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  const id = parsePublicId("webhookEndpoint", publicId);
  if (!id) throw notFound("Webhook endpoint");
  const secret = generateWebhookSecret();
  return db.$transaction(async (tx) => {
    const e = await lockEndpoint(tx, userId, id);
    if (!e) throw notFound("Webhook endpoint");
    const endpoint = await tx.webhookEndpoint.update({
      where: { id },
      data: {
        secretSealed: sealEndpointSecret(secret, deps.encKey, userId, id), previousSecretSealed: e.secretSealed,
        previousSecretExpiresAt: new Date(deps.now.getTime() + SECRET_ROTATION_GRACE_HOURS * 3600_000), version: e.version + 1, updatedAt: deps.now,
      },
    });
    await writeAudit(tx, { userId, action: "webhook_endpoint.secret_rotated", targetType: "webhook_endpoint", targetId: id });
    return { endpoint, secret };
  }, TX_OPTIONS);
}

/** Persists a `webhook_endpoint.test` event and queues a delivery to this endpoint only (sent by the next scheduler tick). */
export async function sendTestEvent(db: PrismaClient, userId: string, publicId: string, now: Date): Promise<WebhookDelivery> {
  const id = parsePublicId("webhookEndpoint", publicId);
  if (!id) throw notFound("Webhook endpoint");
  await consumeBucket(db, `webhook-test:${id}`, TEST_SENDS_PER_ENDPOINT_PER_MINUTE, () => new ApiError(429, "rate_limit_error", "too_many_requests", "Too many test events for this endpoint; retry in a minute", undefined, { "retry-after": "60" }));
  return db.$transaction(async (tx) => {
    const e = await lockEndpoint(tx, userId, id);
    if (!e) throw notFound("Webhook endpoint");
    if (e.status !== "enabled") throw conflict("endpoint_disabled", "Enable the endpoint before sending a test event");
    const occurrence = (await tx.event.count({ where: { userId, subjectId: id, type: TEST_EVENT_TYPE } })) + 1; // serialized by the row lock
    const eventId = await emitEvent(tx, {
      userId, type: TEST_EVENT_TYPE, subjectId: id, now, occurrence,
      data: { webhook_endpoint: toPublicId("webhookEndpoint", id), message: "Test event from the payment sandbox. No payment was made." },
    });
    return tx.webhookDelivery.create({ data: { userId, eventId, endpointId: id, status: "pending", nextAttemptAt: now, createdAt: now, updatedAt: now } });
  }, TX_OPTIONS);
}

// ---------------------------------------------------------------- deliveries

export async function listWebhookDeliveries(
  db: PrismaClient, userId: string, q: { limit?: number; startingAfter?: string; endpointId?: string; eventId?: string; status?: string },
): Promise<Page<WebhookDelivery>> {
  const limit = q.limit ?? 10;
  const where: Record<string, unknown> = { userId };
  if (q.endpointId !== undefined) {
    const eid = parsePublicId("webhookEndpoint", q.endpointId);
    if (!eid) return { items: [], hasMore: false };
    where.endpointId = eid;
  }
  if (q.eventId !== undefined) {
    const evid = parsePublicId("event", q.eventId);
    if (!evid) return { items: [], hasMore: false };
    where.eventId = evid;
  }
  if (q.status !== undefined) where.status = q.status;
  if (q.startingAfter !== undefined) {
    const id = parsePublicId("webhookDelivery", q.startingAfter);
    const cur = id ? await db.webhookDelivery.findFirst({ where: { id, userId }, select: { seq: true } }) : null;
    if (!cur) throw invalidRequest("invalid_cursor", "starting_after does not match a webhook delivery", "starting_after");
    where.seq = { lt: cur.seq };
  }
  const rows = await db.webhookDelivery.findMany({ where, orderBy: { seq: "desc" }, take: limit + 1 });
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function getWebhookDelivery(db: PrismaClient, userId: string, publicId: string): Promise<{ delivery: WebhookDelivery; attempts: WebhookDeliveryAttempt[] }> {
  const id = parsePublicId("webhookDelivery", publicId);
  const delivery = id ? await db.webhookDelivery.findFirst({ where: { id, userId } }) : null;
  if (!delivery) throw notFound("Webhook delivery");
  const attempts = await db.webhookDeliveryAttempt.findMany({ where: { deliveryId: delivery.id, userId }, orderBy: { attemptNo: "asc" }, take: 100 });
  return { delivery, attempts };
}

/**
 * Manual retry: re-arms the delivery for the next scheduler tick (one conditional statement). Idempotent while queued; refused while
 * an attempt is in flight (live lease), for cancelled deliveries, and when the endpoint is disabled or deleted. A failed manual attempt
 * leaves the delivery `failed` (it does not restart the automatic schedule).
 */
export async function retryWebhookDelivery(db: PrismaClient, userId: string, publicId: string, now: Date): Promise<WebhookDelivery> {
  const id = parsePublicId("webhookDelivery", publicId);
  if (!id) throw notFound("Webhook delivery");
  await consumeBucket(db, `webhook-retry:${userId}`, MANUAL_RETRIES_PER_USER_PER_MINUTE, () => new ApiError(429, "rate_limit_error", "too_many_requests", "Too many manual retries; retry in a minute", undefined, { "retry-after": "60" }));
  const n = await db.$executeRaw`
    UPDATE webhook_deliveries d
       SET status = 'retrying', next_attempt_at = ${now}::timestamptz, manual_pending = true, completed_at = NULL, updated_at = ${now}::timestamptz
     WHERE d.id = ${id}::uuid AND d.user_id = ${userId}::uuid
       AND d.status IN ('failed','succeeded','retrying') AND d.manual_pending = false
       AND (d.lease_token IS NULL OR d.locked_until < now())
       AND EXISTS (SELECT 1 FROM webhook_endpoints w WHERE w.id = d.endpoint_id AND w.user_id = d.user_id AND w.status = 'enabled' AND w.deleted_at IS NULL)`;
  const d = await db.webhookDelivery.findFirst({ where: { id, userId } });
  if (!d) throw notFound("Webhook delivery");
  if (n === 1) {
    await writeAudit(db, { userId, action: "webhook_delivery.retried", targetType: "webhook_delivery", targetId: id });
    return d;
  }
  if (d.manualPending) return d; // already queued: same result, no second attempt
  if (d.status === "cancelled") throw conflict("delivery_cancelled", "This delivery was cancelled because its endpoint was deleted");
  if (d.status === "pending") throw conflict("delivery_not_attempted", "This delivery has not been attempted yet");
  if (d.leaseToken && d.lockedUntil && d.lockedUntil >= now) throw conflict("delivery_in_progress", "An attempt is in progress; retry after it finishes");
  throw conflict("endpoint_disabled", "Enable the endpoint before retrying its deliveries");
}
