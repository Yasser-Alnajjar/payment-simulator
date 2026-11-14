import { randomBytes } from "node:crypto";
import {
  buildSignatureHeader, classifyHttpStatus, classifySendError, openBound, parseRetryAfter, retryDelaySeconds, toPublicId,
  type AttemptOutcome, type SendErrorCode,
} from "@sandbox/core";
import type { PrismaClient, WebhookEndpoint } from "@sandbox/db";
import { TX_OPTIONS } from "../lifecycle";
import { ENDPOINT_SECRET_PURPOSE, endpointSecretContext } from "./config";
import { sendWebhook, type Resolver, type SendResult } from "./sender";

/**
 * Delivery engine. PostgreSQL is the source of truth: a delivery is claimed with a single atomic statement (FOR UPDATE SKIP LOCKED,
 * fresh lease token per claim, attempt number fixed at claim time), sent OUTSIDE any transaction, and recorded in one transaction
 * that only changes the delivery if the caller still holds that lease token (fencing). Late results of a lost lease are kept as
 * `stale` history. Attempts whose result was never recorded (crash, killed function) are written as `abandoned` on the next claim.
 */
export const DELIVERY_LEASE_SECONDS = 60;
export const USER_AGENT = "SandboxPayments-Webhooks/1";
const ATTEMPT_TIME_MODES = new Set(["http_500", "timeout", "invalid_signature", "duplicate"]);

export interface ClaimedDelivery {
  id: string;
  user_id: string;
  event_id: string;
  endpoint_id: string;
  status: string;
  attempt_count: number;
  lease_token: string;
  manual_pending: boolean;
}

export interface EngineDeps {
  encKey: string;
  allowPrivate: boolean;
  resolve?: Resolver;
  /** App clock for scheduling (next_attempt_at). Leases always use the database clock. */
  now: () => Date;
  rand?: () => number;
  /** Test seam: replaces the network call. */
  send?: typeof sendWebhook;
}

/**
 * Atomically claims up to `limit` due deliveries, at most ONE per endpoint per call (so one slow receiver cannot consume a batch).
 * Only deliveries whose endpoint is enabled and not deleted are claimable. `onlyIds` restricts the claim (tests, never production).
 */
export async function claimDeliveries(db: PrismaClient, opts: { limit: number; now: Date; leaseSeconds?: number; onlyIds?: string[] }): Promise<ClaimedDelivery[]> {
  const lease = opts.leaseSeconds ?? DELIVERY_LEASE_SECONDS;
  const only = opts.onlyIds ?? null;
  // Exhaustion guard: a delivery whose last allowed attempt was claimed but never recorded (killed function) must not be claimed
  // again, otherwise attempt_count would grow without bound (and hit its CHECK, which would break every claim). Manual retries are exempt.
  await db.$executeRaw`
    UPDATE webhook_deliveries d
       SET status = 'failed', next_attempt_at = NULL, lease_token = NULL, locked_until = NULL, completed_at = now(), last_error_code = 'lease_lost', updated_at = now()
      FROM webhook_endpoints w
     WHERE w.id = d.endpoint_id AND w.user_id = d.user_id
       AND d.status IN ('pending','retrying') AND d.manual_pending = false AND d.attempt_count >= w.max_attempts
       AND (d.locked_until IS NULL OR d.locked_until < now())
       AND (${only}::uuid[] IS NULL OR d.id = ANY (${only}::uuid[]))`;
  return db.$queryRaw<ClaimedDelivery[]>`
    WITH cand AS (
      SELECT d.id, d.endpoint_id, d.next_attempt_at
        FROM webhook_deliveries d
        JOIN webhook_endpoints w ON w.id = d.endpoint_id AND w.user_id = d.user_id
       WHERE d.status IN ('pending','retrying')
         AND d.next_attempt_at <= ${opts.now}::timestamptz
         AND (d.locked_until IS NULL OR d.locked_until < now())
         AND w.status = 'enabled' AND w.deleted_at IS NULL
         AND (${only}::uuid[] IS NULL OR d.id = ANY (${only}::uuid[]))
       ORDER BY d.next_attempt_at
       LIMIT 200
       FOR UPDATE OF d SKIP LOCKED
    ), pick AS (
      SELECT DISTINCT ON (endpoint_id) id, next_attempt_at FROM cand ORDER BY endpoint_id, next_attempt_at
    )
    UPDATE webhook_deliveries d
       SET lease_token = gen_random_uuid(), locked_until = now() + make_interval(secs => ${lease}),
           attempt_count = d.attempt_count + 1, updated_at = now()
      FROM (SELECT id FROM pick ORDER BY next_attempt_at LIMIT ${opts.limit}) p
     WHERE d.id = p.id
    RETURNING d.id::text, d.user_id::text, d.event_id::text, d.endpoint_id::text, d.status, d.attempt_count::int, d.lease_token::text, d.manual_pending`;
}

interface Outcome {
  outcome: Exclude<AttemptOutcome, "abandoned">;
  statusCode: number | null;
  errorCode: SendErrorCode | "http_status" | null;
  excerpt: string | null;
  headers: Record<string, string> | null;
  durationMs: number | null;
  injected: boolean;
  signatureKind: "valid" | "valid_dual" | "injected_invalid" | null;
  retryAfter: number | null;
}

function fromSend(r: SendResult, now: Date): Omit<Outcome, "injected" | "signatureKind"> {
  if (r.kind === "error") return { outcome: classifySendError(r.code), statusCode: null, errorCode: r.code, excerpt: null, headers: null, durationMs: r.durationMs, retryAfter: null };
  const cls = classifyHttpStatus(r.status);
  const errorCode = r.status >= 300 && r.status < 400 ? "redirect_not_followed" : cls === "success" ? null : "http_status";
  return { outcome: cls, statusCode: r.status, errorCode, excerpt: r.excerpt || null, headers: Object.keys(r.headers).length ? r.headers : null, durationMs: r.durationMs, retryAfter: parseRetryAfter(r.headers["retry-after"], now) };
}

export interface ProcessResult { deliveryId: string; attemptNo: number; outcome: AttemptOutcome; status: string; stale: boolean }

/** Sends one claimed delivery and records the result. Never throws for receiver problems; throws only for database failures. */
export async function processDelivery(db: PrismaClient, c: ClaimedDelivery, deps: EngineDeps): Promise<ProcessResult> {
  const attemptNo = c.attempt_count;
  const trigger = c.manual_pending ? "manual" : "scheduled";
  const startedAt = deps.now();
  const [endpoint, event] = await Promise.all([
    db.webhookEndpoint.findFirst({ where: { id: c.endpoint_id, userId: c.user_id } }),
    db.event.findFirst({ where: { id: c.event_id, userId: c.user_id }, select: { id: true, payload: true } }),
  ]);

  let o: Outcome;
  if (!endpoint || !event || endpoint.deletedAt || endpoint.status !== "enabled") {
    // The endpoint was disabled or deleted between claim and send: do not send. Recorded as a retryable attempt; a deleted
    // endpoint's deliveries were already cancelled (lease cleared), so this record will be `stale` and change nothing.
    o = { outcome: "retryable", statusCode: null, errorCode: "unknown_error", excerpt: "endpoint unavailable at send time", headers: null, durationMs: 0, injected: false, signatureKind: null, retryAfter: null };
  } else {
    try {
      o = await attempt(endpoint, event, c, attemptNo, startedAt, deps);
    } catch {
      // Deterministic local failure (e.g. the sealed secret cannot be opened). It must be RECORDED: if it escaped, the attempt would
      // stay unrecorded, the lease would expire and the delivery would be re-claimed (attempt_count + 1) every minute forever.
      o = { outcome: "permanent", statusCode: null, errorCode: "unknown_error", excerpt: "internal error preparing the request", headers: null, durationMs: 0, injected: false, signatureKind: null, retryAfter: null };
    }
  }

  const now = deps.now();
  const finished = o.outcome === "success" || o.outcome === "permanent" || trigger === "manual" || attemptNo >= (endpoint?.maxAttempts ?? 8);
  const status = o.outcome === "success" ? "succeeded" : finished ? "failed" : "retrying";
  const delay = finished ? null : Math.max(retryDelaySeconds(attemptNo, deps.rand), o.retryAfter ?? 0);
  const nextAt = delay === null ? null : new Date(now.getTime() + delay * 1000);

  return db.$transaction(async (tx) => {
    // 1. Fill gaps left by attempts that were claimed but never recorded (crash / killed function / lost lease without a record).
    await tx.$executeRaw`
      INSERT INTO webhook_delivery_attempts (user_id, delivery_id, attempt_no, trigger, started_at, outcome, error_code, created_at)
      SELECT ${c.user_id}::uuid, ${c.id}::uuid, n, 'scheduled', ${startedAt}::timestamptz, 'abandoned', 'lease_lost', ${now}::timestamptz
        FROM generate_series(1, ${attemptNo - 1}) n
       WHERE NOT EXISTS (SELECT 1 FROM webhook_delivery_attempts a WHERE a.delivery_id = ${c.id}::uuid AND a.attempt_no = n)
      ON CONFLICT (delivery_id, attempt_no) DO NOTHING`;
    // 2. Fenced state change: only the current lease holder may move the delivery.
    const updated = await tx.$executeRaw`
      UPDATE webhook_deliveries
         SET status = ${status}, next_attempt_at = ${nextAt}::timestamptz, lease_token = NULL, locked_until = NULL, manual_pending = false,
             last_status_code = ${o.statusCode}, last_error_code = ${o.errorCode},
             completed_at = ${finished ? now : null}::timestamptz, updated_at = ${now}::timestamptz
       WHERE id = ${c.id}::uuid AND user_id = ${c.user_id}::uuid AND lease_token = ${c.lease_token}::uuid`;
    const stale = updated === 0;
    // 3. The attempt itself (kept even when stale, so an extra HTTP request is visible in history).
    await tx.$executeRaw`
      INSERT INTO webhook_delivery_attempts
        (user_id, delivery_id, attempt_no, trigger, lease_token, started_at, duration_ms, outcome, status_code, error_code,
         response_excerpt, response_headers, injected, stale, signature_kind, next_retry_at, created_at)
      VALUES (${c.user_id}::uuid, ${c.id}::uuid, ${attemptNo}, ${trigger}, ${c.lease_token}::uuid, ${startedAt}::timestamptz, ${o.durationMs},
        ${o.outcome}, ${o.statusCode}, ${o.errorCode}, ${o.excerpt}, ${o.headers ? JSON.stringify(o.headers) : null}::jsonb,
        ${o.injected}, ${stale}, ${o.signatureKind}, ${stale ? null : nextAt}::timestamptz, ${now}::timestamptz)
      ON CONFLICT (delivery_id, attempt_no) DO NOTHING`;
    // 4. "Fail N times, then recover": count down attempt-time simulation on the endpoint (single conditional statement).
    if (!stale && o.injected && endpoint?.failureModeRemaining != null) {
      await tx.$executeRaw`
        UPDATE webhook_endpoints
           SET failure_mode = CASE WHEN failure_mode_remaining <= 1 THEN 'none' ELSE failure_mode END,
               failure_mode_remaining = CASE WHEN failure_mode_remaining <= 1 THEN NULL ELSE failure_mode_remaining - 1 END,
               version = version + 1, updated_at = ${now}::timestamptz
         WHERE id = ${endpoint.id}::uuid AND user_id = ${c.user_id}::uuid AND failure_mode = ${endpoint.failureMode}
           AND failure_mode_remaining IS NOT NULL AND deleted_at IS NULL`;
    }
    return { deliveryId: c.id, attemptNo, outcome: o.outcome, status: stale ? "stale" : status, stale };
  }, TX_OPTIONS);
}

async function attempt(endpoint: WebhookEndpoint, event: { id: string; payload: string }, c: ClaimedDelivery, attemptNo: number, now: Date, deps: EngineDeps): Promise<Outcome> {
  const mode = ATTEMPT_TIME_MODES.has(endpoint.failureMode) ? endpoint.failureMode : "none";
  // Simulated failures that never contact the receiver.
  if (mode === "http_500") return { outcome: "retryable", statusCode: 500, errorCode: "injected_http_500", excerpt: "(simulated) HTTP 500, receiver not contacted", headers: null, durationMs: 0, injected: true, signatureKind: null, retryAfter: null };
  if (mode === "timeout") return { outcome: "retryable", statusCode: null, errorCode: "injected_timeout", excerpt: "(simulated) timeout, receiver not contacted", headers: null, durationMs: 0, injected: true, signatureKind: null, retryAfter: null };

  const ctx = endpointSecretContext(c.user_id, endpoint.id);
  const secrets = [openBound(endpoint.secretSealed, deps.encKey, ENDPOINT_SECRET_PURPOSE, ctx)];
  if (endpoint.previousSecretSealed && endpoint.previousSecretExpiresAt && endpoint.previousSecretExpiresAt > now) {
    secrets.push(openBound(endpoint.previousSecretSealed, deps.encKey, ENDPOINT_SECRET_PURPOSE, ctx));
  }
  const ts = Math.floor(now.getTime() / 1000);
  const invalid = mode === "invalid_signature";
  const signature = buildSignatureHeader(invalid ? [`whsec_${randomBytes(32).toString("base64url")}`] : secrets, ts, event.payload);
  const headers = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "sandbox-event-id": toPublicId("event", event.id),
    "sandbox-delivery-id": toPublicId("webhookDelivery", c.id),
    "sandbox-delivery-attempt": String(attemptNo),
    "sandbox-timestamp": String(ts),
    "sandbox-signature": signature,
  };
  const send = deps.send ?? sendWebhook;
  const req = { url: endpoint.url, headers, body: event.payload };
  const opts = { allowPrivate: deps.allowPrivate, resolve: deps.resolve };
  const first = fromSend(await send(req, opts), now);
  let result = first;
  if (mode === "duplicate") {
    const second = fromSend(await send(req, opts), now); // identical bytes, identical signature
    // The delivery succeeds only if both copies were accepted; the excerpt shows both statuses.
    result = second.outcome === "success" && first.outcome === "success" ? second : first.outcome !== "success" ? first : second;
    result = { ...result, excerpt: `(duplicate sent twice: ${first.statusCode ?? first.errorCode}, ${second.statusCode ?? second.errorCode}) ${result.excerpt ?? ""}`.slice(0, 1024) };
  }
  return { ...result, injected: invalid || mode === "duplicate", signatureKind: invalid ? "injected_invalid" : secrets.length > 1 ? "valid_dual" : "valid" };
}
