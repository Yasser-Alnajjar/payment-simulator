import { effectiveStatus, formatAmount, minorToNumber, toPublicId } from "@sandbox/core";
import type { CheckoutSession, Event, PaymentMethod, SetupSession, Transaction, WebhookDelivery, WebhookDeliveryAttempt, WebhookEndpoint } from "@sandbox/db";

/** Public DTOs. Internal columns (user_id, seq, token_hash, version) are never exposed. Amounts: decimal string plus a JSON-safe integer. */
export function sessionDto(s: CheckoutSession, extra: { url?: string } = {}) {
  return {
    id: toPublicId("session", s.id),
    object: "checkout.session" as const,
    status: s.status,
    amount: formatAmount(s.amountMinor, s.currency),
    amount_minor: minorToNumber(s.amountMinor),
    currency: s.currency,
    external_reference: s.externalReference,
    metadata: s.metadata,
    scenario: s.presetScenario,
    customer: s.customerReference,
    expires_at: s.expiresAt.toISOString(),
    created: s.createdAt.toISOString(),
    ...(extra.url ? { url: extra.url } : {}),
  };
}

/** `s` is null for a saved-card charge (no checkout session). Card fields are additive: null for payments made with a simulated outcome. */
export function paymentDto(p: Transaction, s: Pick<CheckoutSession, "externalReference" | "metadata"> | null) {
  return {
    id: toPublicId("payment", p.id),
    object: "payment" as const,
    checkout_session_id: p.checkoutSessionId ? toPublicId("session", p.checkoutSessionId) : null,
    payment_method: p.paymentMethodId ? toPublicId("paymentMethod", p.paymentMethodId) : null,
    customer: p.customerReference,
    card: p.cardBrand && p.cardLast4 ? { brand: p.cardBrand, last4: p.cardLast4 } : null,
    status: p.status,
    amount: formatAmount(p.amountMinor, p.currency),
    amount_minor: minorToNumber(p.amountMinor),
    currency: p.currency,
    scenario: p.scenario,
    failure_code: p.failureCode,
    external_reference: s?.externalReference ?? p.externalReference,
    metadata: s?.metadata ?? p.metadata,
    resolve_at: p.resolveAt?.toISOString() ?? null,
    created: p.createdAt.toISOString(),
    updated: p.updatedAt.toISOString(),
  };
}

/** The stored payload text is the response, byte for byte. */
export const eventRaw = (e: Pick<Event, "payload">) => e.payload;

/** Marker for a pre-serialized JSON string, so exact event bytes survive the response pipeline. */
export class RawJson {
  constructor(public readonly text: string) {}
}

export const listDto = <T>(data: T[], hasMore: boolean) => ({ object: "list" as const, data, has_more: hasMore });
export const rawList = (items: string[], hasMore: boolean) => new RawJson(`{"object":"list","data":[${items.join(",")}],"has_more":${hasMore}}`);

/**
 * Safe display view of a TEST card. Contains no full number and no security code (neither is ever stored). `fingerprint` is a keyed
 * HMAC, usable only to recognise the same card within your account. `status` is the status as of `now` (expiry is derived).
 */
export function paymentMethodDto(m: PaymentMethod, now: Date) {
  return {
    id: toPublicId("paymentMethod", m.id),
    object: "payment_method" as const,
    type: "card" as const,
    test_mode: true as const,
    customer: m.customerReference,
    card: { brand: m.brand, last4: m.last4, exp_month: m.expMonth, exp_year: m.expYear, fingerprint: m.fingerprint },
    cardholder_name: m.cardholderName,
    status: effectiveStatus(m.status, m.expMonth, m.expYear, now),
    is_default: m.isDefault,
    test_behavior: m.testBehavior,
    created: m.createdAt.toISOString(),
    updated: m.updatedAt.toISOString(),
  };
}

export function setupSessionDto(s: SetupSession, extra: { url?: string; paymentMethod?: PaymentMethod | null } = {}) {
  return {
    id: toPublicId("setupSession", s.id),
    object: "checkout.session" as const,
    mode: "setup" as const,
    status: s.status,
    customer: s.customerReference,
    external_reference: s.externalReference,
    metadata: s.metadata,
    payment_method: s.paymentMethodId ? toPublicId("paymentMethod", s.paymentMethodId) : null,
    failure_code: s.lastFailureCode,
    expires_at: s.expiresAt.toISOString(),
    created: s.createdAt.toISOString(),
    ...(extra.url ? { url: extra.url } : {}),
  };
}

/** Webhook endpoint. The signing secret is never part of this view: it is returned once, by create and rotate-secret only. */
export function webhookEndpointDto(e: WebhookEndpoint, extra: { secret?: string } = {}) {
  return {
    id: toPublicId("webhookEndpoint", e.id),
    object: "webhook_endpoint" as const,
    url: e.url,
    description: e.description,
    enabled_events: e.enabledEvents,
    status: e.status,
    max_attempts: e.maxAttempts,
    failure_simulation: { mode: e.failureMode, remaining: e.failureModeRemaining, delay_seconds: e.failureDelaySeconds },
    previous_secret_expires_at: e.previousSecretExpiresAt?.toISOString() ?? null,
    created: e.createdAt.toISOString(),
    updated: e.updatedAt.toISOString(),
    ...(extra.secret ? { secret: extra.secret } : {}),
  };
}

export function webhookAttemptDto(a: WebhookDeliveryAttempt) {
  return {
    attempt: a.attemptNo,
    trigger: a.trigger,
    outcome: a.outcome,
    status_code: a.statusCode,
    error_code: a.errorCode,
    duration_ms: a.durationMs,
    response_excerpt: a.responseExcerpt,
    response_headers: a.responseHeaders,
    simulated: a.injected,
    stale: a.stale,
    signature: a.signatureKind,
    started: a.startedAt.toISOString(),
    next_retry_at: a.nextRetryAt?.toISOString() ?? null,
  };
}

export function webhookDeliveryDto(d: WebhookDelivery, attempts?: WebhookDeliveryAttempt[]) {
  return {
    id: toPublicId("webhookDelivery", d.id),
    object: "webhook_delivery" as const,
    event_id: toPublicId("event", d.eventId),
    endpoint_id: toPublicId("webhookEndpoint", d.endpointId),
    status: d.status,
    attempt_count: d.attemptCount,
    next_attempt_at: d.nextAttemptAt?.toISOString() ?? null,
    manual_retry_pending: d.manualPending,
    last_status_code: d.lastStatusCode,
    last_error_code: d.lastErrorCode,
    completed_at: d.completedAt?.toISOString() ?? null,
    created: d.createdAt.toISOString(),
    updated: d.updatedAt.toISOString(),
    ...(attempts ? { attempts: attempts.map(webhookAttemptDto) } : {}),
  };
}
