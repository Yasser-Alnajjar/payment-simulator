import { z } from "zod";
import {
  CARD_BEHAVIORS, CARD_BRANDS, DELIVERY_STATUSES, EVENT_TYPES, FAILURE_MODES, PAYMENT_METHOD_STATUSES, PAYMENT_STATUSES, SCENARIOS, SEND_ERROR_CODES, SESSION_STATUSES,
} from "@sandbox/core";

/**
 * Response schemas of the public API (S5). They are the single source for BOTH the OpenAPI document and the contract tests, and they
 * are strict (unknown keys fail) so an undocumented field added to a DTO is caught. In the published document `additionalProperties:false`
 * is removed from responses: new fields are additive and clients must ignore fields they do not know.
 * Request bodies are NOT redefined here: they come from `server/api/validation.ts` (the schemas the handlers actually run).
 */

const ts = z.string().meta({ format: "date-time", description: "ISO 8601 timestamp (UTC)." });
const idOf = (prefix: string, what: string) => z.string().regex(new RegExp(`^${prefix}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)).meta({ description: `${what} id (\`${prefix}\` + uuid).`, example: `${prefix}0b6c1a52-3b0e-4a39-9d53-2f6f1d7a9c10` });

export const sessionId = idOf("cs_", "Checkout session");
export const setupSessionId = idOf("seti_", "Setup session");
export const anySessionId = z.union([sessionId, setupSessionId]).meta({ description: "Payment session id (`cs_…`) or setup session id (`seti_…`)." });
export const paymentId = idOf("pay_", "Payment");
export const eventId = idOf("evt_", "Event");
export const methodId = idOf("pm_", "Payment method");
export const endpointId = idOf("we_", "Webhook endpoint");
export const deliveryId = idOf("whd_", "Webhook delivery");

const metadata = z.record(z.string(), z.string()).meta({ description: "Your own key/value data (up to 50 keys, values up to 500 characters)." });
const money = {
  amount: z.string().regex(/^[0-9]+(\.[0-9]+)?$/).meta({ description: "Decimal string in the currency's major unit, e.g. \"149.00\"." }),
  amount_minor: z.number().int().meta({ description: "The same amount in minor units (cents). A JSON-safe integer." }),
  currency: z.string().regex(/^[A-Z]{3}$/),
};

export const checkoutSession = z.strictObject({
  id: sessionId,
  object: z.literal("checkout.session"),
  status: z.enum(SESSION_STATUSES),
  ...money,
  external_reference: z.string().nullable(),
  metadata,
  scenario: z.enum(SCENARIOS).nullable().meta({ description: "Preset outcome that locks the hosted page, or null when the payer chooses." }),
  customer: z.string().nullable(),
  expires_at: ts,
  created: ts,
  url: z.string().optional().meta({ description: "Hosted checkout URL. Returned only by create; contains the secret checkout token, so treat it like a credential." }),
}).meta({ id: "CheckoutSession" });

export const setupSession = z.strictObject({
  id: setupSessionId,
  object: z.literal("checkout.session"),
  mode: z.literal("setup"),
  status: z.enum(SESSION_STATUSES),
  customer: z.string(),
  external_reference: z.string().nullable(),
  metadata,
  payment_method: methodId.nullable(),
  failure_code: z.string().nullable(),
  expires_at: ts,
  created: ts,
  url: z.string().optional().meta({ description: "Hosted setup URL. Returned only by create; contains the secret checkout token." }),
}).meta({ id: "SetupSession" });

export const payment = z.strictObject({
  id: paymentId,
  object: z.literal("payment"),
  checkout_session_id: sessionId.nullable().meta({ description: "Null for a saved-card charge." }),
  payment_method: methodId.nullable(),
  customer: z.string().nullable(),
  card: z.strictObject({ brand: z.string(), last4: z.string().regex(/^[0-9]{4}$/) }).nullable(),
  status: z.enum(PAYMENT_STATUSES),
  ...money,
  scenario: z.enum(SCENARIOS).nullable(),
  failure_code: z.string().nullable(),
  external_reference: z.string().nullable(),
  metadata,
  resolve_at: ts.nullable().meta({ description: "When a scheduled `pending_then_*` resolution is due." }),
  created: ts,
  updated: ts,
}).meta({ id: "Payment" });

export const paymentMethod = z.strictObject({
  id: methodId,
  object: z.literal("payment_method"),
  type: z.literal("card"),
  test_mode: z.literal(true),
  customer: z.string(),
  card: z.strictObject({
    brand: z.enum(CARD_BRANDS), last4: z.string().regex(/^[0-9]{4}$/), exp_month: z.number().int().min(1).max(12), exp_year: z.number().int(),
    fingerprint: z.string().meta({ description: "Keyed hash that identifies the same test card within your account." }),
  }),
  cardholder_name: z.string().nullable(),
  status: z.enum(PAYMENT_METHOD_STATUSES),
  is_default: z.boolean(),
  test_behavior: z.enum(CARD_BEHAVIORS),
  created: ts,
  updated: ts,
}).meta({ id: "PaymentMethod" });

export const deletedPaymentMethod = z.strictObject({ id: methodId, object: z.literal("payment_method"), deleted: z.literal(true) }).meta({ id: "DeletedPaymentMethod" });

export const webhookEndpoint = z.strictObject({
  id: endpointId,
  object: z.literal("webhook_endpoint"),
  url: z.string(),
  description: z.string().nullable(),
  enabled_events: z.array(z.string()).meta({ description: "Event types, or [\"*\"] for all." }),
  status: z.enum(["enabled", "disabled"]),
  max_attempts: z.number().int().min(1).max(12),
  failure_simulation: z.strictObject({ mode: z.enum(FAILURE_MODES), remaining: z.number().int().nullable(), delay_seconds: z.number().int().nullable() }),
  previous_secret_expires_at: ts.nullable().meta({ description: "While set, deliveries carry a signature for the previous secret as well." }),
  created: ts,
  updated: ts,
  secret: z.string().regex(/^whsec_/).optional().meta({ description: "Signing secret. Returned ONLY by create (and its idempotent replay) and rotate-secret. Store it then." }),
}).meta({ id: "WebhookEndpoint" });

export const deletedWebhookEndpoint = z.strictObject({
  id: endpointId, object: z.literal("webhook_endpoint"), deleted: z.literal(true), cancelled_deliveries: z.number().int(),
}).meta({ id: "DeletedWebhookEndpoint" });

export const webhookAttempt = z.strictObject({
  attempt: z.number().int(),
  trigger: z.string().meta({ description: "What caused the attempt (automatic schedule or manual retry)." }),
  outcome: z.string(),
  status_code: z.number().int().nullable(),
  error_code: z.enum(SEND_ERROR_CODES).nullable(),
  duration_ms: z.number().int().nullable(),
  response_excerpt: z.string().nullable(),
  response_headers: z.unknown().nullable(),
  simulated: z.boolean().meta({ description: "True when the outcome was injected by the endpoint's failure simulation." }),
  stale: z.boolean(),
  signature: z.string().nullable(),
  started: ts,
  next_retry_at: ts.nullable(),
}).meta({ id: "WebhookAttempt" });

export const webhookDelivery = z.strictObject({
  id: deliveryId,
  object: z.literal("webhook_delivery"),
  event_id: eventId,
  endpoint_id: endpointId,
  status: z.enum(DELIVERY_STATUSES),
  attempt_count: z.number().int(),
  next_attempt_at: ts.nullable(),
  manual_retry_pending: z.boolean(),
  last_status_code: z.number().int().nullable(),
  last_error_code: z.string().nullable(),
  completed_at: ts.nullable(),
  created: ts,
  updated: ts,
  attempts: z.array(webhookAttempt).optional().meta({ description: "Attempt history. Returned by the single-delivery read only." }),
}).meta({ id: "WebhookDelivery" });

// ---------------------------------------------------------------------------------------------------- events

const sessionEventData = z.strictObject({
  checkout_session_id: sessionId, external_reference: z.string().nullable(), ...money, status: z.string(), metadata,
});
const paymentEventData = z.strictObject({
  payment_id: paymentId, checkout_session_id: sessionId.nullable(), external_reference: z.string().nullable(), ...money, status: z.string(), metadata,
  failure_code: z.string().nullable(),
  payment_method: methodId.nullable().optional(), customer: z.string().nullable().optional(),
  card: z.strictObject({ brand: z.string(), last4: z.string() }).nullable().optional(),
});
const setupEventData = z.strictObject({
  checkout_session_id: setupSessionId, mode: z.literal("setup"), customer: z.string(), external_reference: z.string().nullable(), status: z.string(),
  payment_method: methodId.nullable(), payment_method_details: paymentMethod.nullable(), metadata,
});
const methodEventData = z.strictObject({
  payment_method: paymentMethod,
  previous_default: methodId.nullable().optional().meta({ description: "`payment_method.default_updated`: the method that was the default before, or null." }),
  was_default: z.boolean().optional().meta({ description: "`payment_method.disabled` / `.deleted`: whether it was the default when that happened." }),
  change: z.literal("default_cleared").optional().meta({ description: "`payment_method.updated`: what changed (currently only that it stopped being the default)." }),
});
const testEventData = z.strictObject({ webhook_endpoint: endpointId, message: z.string() });

/** Per event type, the shape of `data`. `checkout.session.*` is either a payment session or a setup session. */
export const EVENT_DATA = {
  "checkout.session.completed": [sessionEventData, setupEventData],
  "checkout.session.expired": [sessionEventData, setupEventData],
  "checkout.session.cancelled": [sessionEventData, setupEventData],
  "payment.pending": [paymentEventData],
  "payment.succeeded": [paymentEventData],
  "payment.failed": [paymentEventData],
  "payment.cancelled": [paymentEventData],
  "payment_method.created": [methodEventData],
  "payment_method.updated": [methodEventData],
  "payment_method.default_updated": [methodEventData],
  "payment_method.disabled": [methodEventData],
  "payment_method.deleted": [methodEventData],
  "webhook_endpoint.test": [testEventData],
} as const satisfies Record<(typeof EVENT_TYPES)[number], readonly z.ZodType[]>;

const eventEnvelope = (type: (typeof EVENT_TYPES)[number]) =>
  z.strictObject({
    id: eventId,
    object: z.literal("event"),
    type: z.literal(type),
    created: ts,
    api_version: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).meta({ description: "API version the payload was written with." }),
    data: z.union(EVENT_DATA[type] as unknown as [z.ZodType, ...z.ZodType[]]),
  });

/** One schema per event type (discriminated on `type`). Used for GET /events, GET /events/{id} and the webhook request body. */
export const event = z.discriminatedUnion("type", EVENT_TYPES.map(eventEnvelope) as unknown as [ReturnType<typeof eventEnvelope>, ...ReturnType<typeof eventEnvelope>[]]).meta({ id: "Event" });

// ---------------------------------------------------------------------------------------------------- lists and errors

export const list = <T extends z.ZodType>(item: T, id: string) =>
  z.strictObject({ object: z.literal("list"), data: z.array(item), has_more: z.boolean().meta({ description: "Pass the last item's id as `starting_after` to fetch the next page." }) }).meta({ id });

export const ERROR_TYPES = ["authentication_error", "invalid_request_error", "conflict_error", "rate_limit_error", "idempotency_error", "card_error", "api_error"] as const;

export const errorBody = z.strictObject({
  error: z.strictObject({
    type: z.enum(ERROR_TYPES),
    code: z.string().meta({ description: "Stable machine-readable code. Branch on this, not on `message`." }),
    message: z.string().meta({ description: "Human-readable, safe to log. Not stable." }),
    param: z.string().optional().meta({ description: "The offending request parameter, when there is one." }),
    request_id: z.string().regex(/^req_/).meta({ description: "Also returned in the `Request-Id` header. Quote it when asking for help." }),
  }),
}).meta({ id: "Error" });

export const checkoutSessionOrSetup = z.union([checkoutSession, setupSession]).meta({ id: "CheckoutSessionOrSetupSession" });
