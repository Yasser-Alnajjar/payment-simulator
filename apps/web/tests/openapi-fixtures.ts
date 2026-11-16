import { createPayment, transitionPayment, transitionSession, type Tx } from "@/server/lifecycle";
import { eventRaw, paymentDto, paymentMethodDto, rawList, sessionDto, setupSessionDto, webhookAttemptDto, webhookDeliveryDto, webhookEndpointDto, listDto } from "@/server/api/dto";
import { API_VERSION } from "@/server/lifecycle";

/** Plain-object stand-ins for database rows. No database is involved anywhere in the S5 contract tests. */
const U = "11111111-1111-4111-8111-111111111111";
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = new Date("2026-11-16T10:00:00.000Z");
const T1 = new Date("2026-11-16T10:30:00.000Z");

export const sessionRow = (over: Record<string, unknown> = {}) => ({
  id: uuid(1), userId: U, seq: 1n, status: "open", amountMinor: 14900n, currency: "USD", externalReference: "order-42", metadata: { plan: "pro" },
  presetScenario: null, customerReference: "cust_1", expiresAt: T1, createdAt: T0, updatedAt: T0, ...over,
}) as never;

export const paymentRow = (over: Record<string, unknown> = {}) => ({
  id: uuid(2), userId: U, seq: 1n, checkoutSessionId: uuid(1), paymentMethodId: null, customerReference: null, cardBrand: null, cardLast4: null, status: "succeeded",
  amountMinor: 14900n, currency: "USD", scenario: "success", failureCode: null, externalReference: null, metadata: {}, resolveAt: null, resolveTo: null, version: 1,
  createdAt: T0, updatedAt: T0, resolvedAt: T0, ...over,
}) as never;

export const methodRow = (over: Record<string, unknown> = {}) => ({
  id: uuid(3), userId: U, seq: 1n, customerReference: "cust_1", brand: "visa", last4: "4242", expMonth: 12, expYear: 2031, fingerprint: "fp_abc", cardholderName: "Ada Lovelace",
  status: "active", isDefault: true, testBehavior: "succeed", version: 1, createdAt: T0, updatedAt: T0, deletedAt: null, ...over,
}) as never;

export const setupRow = (over: Record<string, unknown> = {}) => ({
  id: uuid(4), userId: U, status: "open", customerReference: "cust_1", externalReference: null, metadata: {}, paymentMethodId: null, lastFailureCode: null, attemptCount: 0,
  expiresAt: T1, createdAt: T0, updatedAt: T0, ...over,
}) as never;

export const endpointRow = (over: Record<string, unknown> = {}) => ({
  id: uuid(5), userId: U, seq: 1n, url: "https://example.com/hooks", description: "prod", enabledEvents: ["*"], status: "enabled", maxAttempts: 8, failureMode: "none",
  failureModeRemaining: null, failureDelaySeconds: null, previousSecretExpiresAt: null, createdAt: T0, updatedAt: T0, deletedAt: null, ...over,
}) as never;

export const deliveryRow = (over: Record<string, unknown> = {}) => ({
  id: uuid(6), userId: U, seq: 1n, eventId: uuid(7), endpointId: uuid(5), status: "retrying", attemptCount: 1, nextAttemptAt: T1, manualPending: false, lastStatusCode: 500,
  lastErrorCode: null, completedAt: null, createdAt: T0, updatedAt: T0, ...over,
}) as never;

export const attemptRow = (over: Record<string, unknown> = {}) => ({
  attemptNo: 1, trigger: "scheduled", outcome: "failure", statusCode: 500, errorCode: null, durationMs: 120, responseExcerpt: "oops", responseHeaders: { "content-type": "text/plain" },
  injected: false, stale: false, signatureKind: "current", startedAt: T0, nextRetryAt: T1, ...over,
}) as never;

// -------------------------------------------------------------------------------------------------- real event payloads
/** A transaction stand-in that records what `emitEvent` writes. The event payload text is produced by the real production code. */
export function recordingTx() {
  const payloads: string[] = [];
  const tx = {
    event: { create: async ({ data }: { data: { payload: string } }) => { payloads.push(data.payload); return data; } },
    $executeRaw: async () => 0,
    checkoutSession: { updateMany: async () => ({ count: 1 }), findFirst: async () => null },
    transaction: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...(paymentRow() as object), ...data }), updateMany: async () => ({ count: 1 }), findFirst: async () => null },
  } as unknown as Tx;
  return { tx, payloads };
}

export async function realEventPayloads(): Promise<string[]> {
  const { tx, payloads } = recordingTx();
  const s = sessionRow();
  await createPayment(tx, s, "success", 5, T0); // payment.succeeded + checkout.session.completed
  await createPayment(tx, s, "decline", 5, T0); // payment.failed
  await createPayment(tx, s, "pending", 5, T0); // payment.pending
  await createPayment(tx, s, "cancel", 5, T0); // payment.cancelled
  await createPayment(tx, s, "success", 5, T0, { outcome: { status: "succeeded", failureCode: null } as never, paymentMethodId: uuid(3), customerReference: "cust_1", brand: "visa", last4: "4242" }); // card keys
  await transitionPayment(tx, s, paymentRow({ status: "pending" }), "failed", "declined", T0);
  await transitionSession(tx, s, "expired", T0);
  await transitionSession(tx, s, "cancelled", T0);
  return payloads;
}

/** Event types whose payload builders are private to their services; shaped exactly as in `services/setup-sessions.ts`, `payment-methods.ts` and `webhooks.ts`. */
export function handBuiltEventPayloads(): string[] {
  const env = (n: number, type: string, data: unknown) => JSON.stringify({ id: `evt_${uuid(n)}`, object: "event", type, created: T0.toISOString(), api_version: API_VERSION, data });
  const pm = paymentMethodDto(methodRow(), T0);
  const setup = (status: string, withPm: boolean) => ({
    checkout_session_id: `seti_${uuid(4)}`, mode: "setup", customer: "cust_1", external_reference: null, status, payment_method: withPm ? pm.id : null, payment_method_details: withPm ? pm : null, metadata: {},
  });
  return [
    env(20, "checkout.session.completed", setup("completed", true)), env(21, "checkout.session.expired", setup("expired", false)), env(22, "checkout.session.cancelled", setup("cancelled", false)),
    env(23, "payment_method.created", { payment_method: pm }), env(24, "payment_method.updated", { payment_method: pm, change: "default_cleared" }),
    env(25, "payment_method.default_updated", { payment_method: pm, previous_default: null }), env(26, "payment_method.disabled", { payment_method: pm, was_default: true }),
    env(27, "payment_method.deleted", { payment_method: pm, was_default: false }),
    env(28, "webhook_endpoint.test", { webhook_endpoint: `we_${uuid(5)}`, message: "Test event from the payment sandbox. No payment was made." }),
  ];
}

// -------------------------------------------------------------------------------------------------- one sample per handler
const now = T0;
const sessionBody = () => sessionDto(sessionRow(), { url: "http://localhost:3100/checkout/tok" });
export async function successSamples(): Promise<Record<string, unknown[]>> {
  const events = [...(await realEventPayloads()), ...handBuiltEventPayloads()];
  const parsedEvents = events.map((e) => JSON.parse(e));
  const rawEvent = JSON.parse(eventRaw({ payload: events[0]! }));
  const secretEndpoint = webhookEndpointDto(endpointRow(), { secret: "whsec_abc123" });
  return {
    createSession: [sessionBody(), setupSessionDto(setupRow(), { url: "http://localhost:3100/checkout/tok" })],
    listSessions: [listDto([sessionDto(sessionRow())], true)],
    getSession: [sessionDto(sessionRow()), setupSessionDto(setupRow())],
    cancelSession: [sessionDto(sessionRow({ status: "cancelled" })), setupSessionDto(setupRow({ status: "cancelled" }))],
    listPayments: [listDto([paymentDto(paymentRow(), sessionRow()), paymentDto(paymentRow({ checkoutSessionId: null, paymentMethodId: uuid(3), customerReference: "cust_1", cardBrand: "visa", cardLast4: "4242", externalReference: "x" }), null)], false)],
    createCharge: [paymentDto(paymentRow({ checkoutSessionId: null, paymentMethodId: uuid(3), customerReference: "cust_1", cardBrand: "visa", cardLast4: "4242", status: "failed", failureCode: "insufficient_funds" }), null)],
    getPayment: [paymentDto(paymentRow(), sessionRow()), paymentDto(paymentRow({ status: "pending", resolveAt: T1, scenario: "pending_then_success" }), sessionRow())],
    createPaymentMethod: [paymentMethodDto(methodRow(), now)],
    listPaymentMethods: [listDto([paymentMethodDto(methodRow(), now), paymentMethodDto(methodRow({ status: "disabled", isDefault: false }), now)], false)],
    getDefaultPaymentMethod: [paymentMethodDto(methodRow(), now)],
    getPaymentMethod: [paymentMethodDto(methodRow({ expYear: 2020 }), now)],
    deletePaymentMethod: [{ id: `pm_${uuid(3)}`, object: "payment_method", deleted: true }],
    setDefaultPaymentMethod: [paymentMethodDto(methodRow(), now)],
    disablePaymentMethod: [paymentMethodDto(methodRow({ status: "disabled", isDefault: false }), now)],
    listEvents: [JSON.parse(rawList(events, true).text)],
    getEvent: [rawEvent, ...parsedEvents],
    createWebhookEndpoint: [secretEndpoint],
    listWebhookEndpoints: [listDto([webhookEndpointDto(endpointRow()), webhookEndpointDto(endpointRow({ failureMode: "delay", failureDelaySeconds: 30, previousSecretExpiresAt: T1 }))], false)],
    getWebhookEndpoint: [webhookEndpointDto(endpointRow())],
    updateWebhookEndpoint: [webhookEndpointDto(endpointRow({ failureMode: "http_500", failureModeRemaining: 2 }))],
    deleteWebhookEndpoint: [{ id: `we_${uuid(5)}`, object: "webhook_endpoint", deleted: true, cancelled_deliveries: 3 }],
    rotateWebhookSecret: [webhookEndpointDto(endpointRow({ previousSecretExpiresAt: T1 }), { secret: "whsec_new" })],
    sendWebhookTest: [webhookDeliveryDto(deliveryRow({ status: "pending", attemptCount: 0, lastStatusCode: null, nextAttemptAt: T0 }))],
    listWebhookDeliveries: [listDto([webhookDeliveryDto(deliveryRow())], false)],
    getWebhookDelivery: [webhookDeliveryDto(deliveryRow(), [attemptRow(), attemptRow({ attemptNo: 2, statusCode: null, errorCode: "timeout", durationMs: null, responseExcerpt: null, responseHeaders: null, injected: true, nextRetryAt: null })])],
    retryWebhookDelivery: [webhookDeliveryDto(deliveryRow({ manualPending: true }))],
  };
}

export { webhookAttemptDto };
