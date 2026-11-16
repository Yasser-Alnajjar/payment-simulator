import type { z } from "zod";
import {
  createChargeBody, createMethodBody, createSessionBody, createSetupBody, createWebhookEndpointBody, defaultMethodQuery, eventsQuery, methodsQuery, paymentsQuery,
  sessionsQuery, updateWebhookEndpointBody, webhookDeliveriesQuery, webhookEndpointsQuery,
} from "../api/validation";
import { EVENT_TYPES } from "@sandbox/core";
import * as S from "./schemas";

export type Method = "get" | "post" | "patch" | "delete";
export type Tag = "Checkout sessions" | "Payments" | "Payment methods" | "Events" | "Webhook endpoints" | "Webhook deliveries";

export interface Success { status: number; schema: z.ZodType; description: string; replayHeader?: boolean }

export interface Operation {
  /** Name of the function in `server/api/handlers.ts` that serves this operation (checked against the route files). */
  handler: string;
  method: Method;
  /** OpenAPI path, relative to the server root. */
  path: string;
  tag: Tag;
  summary: string;
  description: string;
  /** Names of path parameters, in order, with their id schema. */
  pathParams?: Record<string, z.ZodType>;
  query?: z.ZodObject;
  /** Body schemas; several means "one of". */
  body?: z.ZodType[];
  idempotency?: "optional" | "required";
  success: Success[];
  /** Operation-specific errors by status; the common ones (401, 429, 500) are added to every operation. */
  errors: Record<number, string[]>;
}

const MONEY = ["unsupported_currency", "invalid_amount_format", "too_many_decimals", "amount_too_small", "amount_too_large"];
const BODY = ["invalid_json", "invalid_parameter", "unknown_parameter"];
const LIST = ["invalid_parameter", "unknown_parameter", "invalid_cursor"];
const IDEM_ERR = { 409: ["idempotency_key_in_progress"], 422: ["idempotency_key_reused"] };
const CARD = ["invalid_card_number", "not_a_test_card", "card_expired", "invalid_expiry", "invalid_cvc", "invalid_cardholder_name"];
const NF = ["resource_not_found"];
const BODY_LIMITS = { 413: ["body_too_large"], 415: ["unsupported_media_type"] };

const sessionList = S.list(S.checkoutSession, "CheckoutSessionList");
const paymentList = S.list(S.payment, "PaymentList");
const methodList = S.list(S.paymentMethod, "PaymentMethodList");
const eventList = S.list(S.event, "EventList");
const endpointList = S.list(S.webhookEndpoint, "WebhookEndpointList");
const deliveryList = S.list(S.webhookDelivery, "WebhookDeliveryList");

export const OPERATIONS: Operation[] = [
  // ------------------------------------------------------------------------------------------ checkout sessions
  {
    handler: "createSession", method: "post", path: "/api/v1/checkout/sessions", tag: "Checkout sessions", idempotency: "optional",
    summary: "Create a checkout session",
    description: "Creates a hosted checkout. Send `amount` and `currency` for a payment session, or `mode: \"setup\"` with a `customer` to let a payer save a test card. The response `url` is where you send the payer; it is returned only once. Setting `scenario` fixes the outcome of the payment (see the guide). Repeating a request with the same `Idempotency-Key` and body returns the original response with `Idempotent-Replayed: true`.",
    body: [createSessionBody, createSetupBody],
    success: [{ status: 201, schema: S.checkoutSessionOrSetup, description: "The session. A payment session has `amount`; a setup session has `mode: \"setup\"`.", replayHeader: true }],
    errors: { 400: [...BODY, ...MONEY, "invalid_idempotency_key"], ...IDEM_ERR, ...BODY_LIMITS },
  },
  {
    handler: "listSessions", method: "get", path: "/api/v1/checkout/sessions", tag: "Checkout sessions", summary: "List checkout sessions",
    description: "Newest first. Payment sessions only. Sessions past their expiry are settled (expired) before they are returned.",
    query: sessionsQuery, success: [{ status: 200, schema: sessionList, description: "A page of sessions." }], errors: { 400: LIST },
  },
  {
    handler: "getSession", method: "get", path: "/api/v1/checkout/sessions/{sessionId}", tag: "Checkout sessions", summary: "Retrieve a checkout session",
    description: "Accepts a payment session id (`cs_…`) or a setup session id (`seti_…`). Reading settles a due scheduled payment or an expiry first.",
    pathParams: { sessionId: S.anySessionId },
    success: [{ status: 200, schema: S.checkoutSessionOrSetup, description: "The session." }], errors: { 404: NF },
  },
  {
    handler: "cancelSession", method: "post", path: "/api/v1/checkout/sessions/{sessionId}/cancel", tag: "Checkout sessions", summary: "Cancel a checkout session",
    description: "Only an `open` session can be cancelled; a pending payment is cancelled with it. Repeating the call on an already cancelled session returns it unchanged.",
    pathParams: { sessionId: S.anySessionId },
    success: [{ status: 200, schema: S.checkoutSessionOrSetup, description: "The cancelled session." }], errors: { 404: NF, 409: ["invalid_state_transition"] },
  },
  // ------------------------------------------------------------------------------------------ payments
  {
    handler: "listPayments", method: "get", path: "/api/v1/payments", tag: "Payments", summary: "List payments",
    description: "Newest first. Includes payments of checkout sessions and saved-card charges.",
    query: paymentsQuery, success: [{ status: 200, schema: paymentList, description: "A page of payments." }], errors: { 400: LIST },
  },
  {
    handler: "createCharge", method: "post", path: "/api/v1/payments", tag: "Payments", idempotency: "required", summary: "Charge a saved test card",
    description: "Creates a payment from a saved payment method, without a checkout session. The outcome comes from the card's test behaviour. **`Idempotency-Key` is required.** A declined card is a successful call that returns a payment with `status: \"failed\"`, not an HTTP error.",
    body: [createChargeBody],
    success: [{ status: 201, schema: S.payment, description: "The payment (succeeded or failed).", replayHeader: true }],
    errors: { 400: [...BODY, ...MONEY, "idempotency_key_required", "invalid_idempotency_key", "customer_mismatch"], 404: NF, 409: ["payment_method_disabled", "payment_method_expired", "idempotency_key_in_progress"], 422: ["idempotency_key_reused"], ...BODY_LIMITS },
  },
  {
    handler: "getPayment", method: "get", path: "/api/v1/payments/{paymentId}", tag: "Payments", summary: "Retrieve a payment",
    description: "Reading settles a due scheduled resolution of the payment's session first.",
    pathParams: { paymentId: S.paymentId }, success: [{ status: 200, schema: S.payment, description: "The payment." }], errors: { 404: NF },
  },
  // ------------------------------------------------------------------------------------------ payment methods
  {
    handler: "createPaymentMethod", method: "post", path: "/api/v1/payment-methods", tag: "Payment methods", idempotency: "optional", summary: "Save a test card",
    description: "Saves a **test** card for a customer. Only the simulator's published test card numbers are accepted (see the guide); a real card number is refused. The full number and security code are never stored.",
    body: [createMethodBody],
    success: [{ status: 201, schema: S.paymentMethod, description: "The saved payment method.", replayHeader: true }],
    errors: { 400: [...BODY, ...CARD, "invalid_customer", "invalid_idempotency_key"], 402: ["card_declined"], 409: ["duplicate_payment_method", "payment_method_limit_reached", "payment_method_conflict", "idempotency_key_in_progress"], 422: ["idempotency_key_reused"], ...BODY_LIMITS },
  },
  {
    handler: "listPaymentMethods", method: "get", path: "/api/v1/payment-methods", tag: "Payment methods", summary: "List payment methods",
    description: "Newest first. Deleted methods are not listed.", query: methodsQuery, success: [{ status: 200, schema: methodList, description: "A page of payment methods." }], errors: { 400: [...LIST, "invalid_customer"] },
  },
  {
    handler: "getDefaultPaymentMethod", method: "get", path: "/api/v1/payment-methods/default", tag: "Payment methods", summary: "Retrieve a customer's default payment method",
    description: "`customer` is required.", query: defaultMethodQuery, success: [{ status: 200, schema: S.paymentMethod, description: "The default method." }],
    errors: { 400: ["invalid_parameter", "unknown_parameter", "invalid_customer"], 404: ["no_default_payment_method"] },
  },
  {
    handler: "getPaymentMethod", method: "get", path: "/api/v1/payment-methods/{methodId}", tag: "Payment methods", summary: "Retrieve a payment method",
    description: "Shows the safe display view of a test card (brand, last four digits, expiry).",
    pathParams: { methodId: S.methodId }, success: [{ status: 200, schema: S.paymentMethod, description: "The payment method." }], errors: { 404: NF },
  },
  {
    handler: "deletePaymentMethod", method: "delete", path: "/api/v1/payment-methods/{methodId}", tag: "Payment methods", summary: "Delete a payment method",
    description: "Removes the method from lists and from charging. Existing payments keep their card summary.",
    pathParams: { methodId: S.methodId }, success: [{ status: 200, schema: S.deletedPaymentMethod, description: "Confirmation." }], errors: { 404: NF },
  },
  {
    handler: "setDefaultPaymentMethod", method: "post", path: "/api/v1/payment-methods/{methodId}/default", tag: "Payment methods", summary: "Make a payment method the default",
    description: "Becomes the customer's default; the previous default is unset. A disabled or expired method cannot be the default.",
    pathParams: { methodId: S.methodId }, success: [{ status: 200, schema: S.paymentMethod, description: "The updated method." }],
    errors: { 404: NF, 409: ["payment_method_disabled", "payment_method_expired", "payment_method_conflict"] },
  },
  {
    handler: "disablePaymentMethod", method: "post", path: "/api/v1/payment-methods/{methodId}/disable", tag: "Payment methods", summary: "Disable a payment method",
    description: "Final: a disabled method cannot be re-enabled. If it was the default, the customer is left without one. Repeating is a no-op.",
    pathParams: { methodId: S.methodId }, success: [{ status: 200, schema: S.paymentMethod, description: "The disabled method." }], errors: { 404: NF, 409: ["payment_method_conflict"] },
  },
  // ------------------------------------------------------------------------------------------ events
  {
    handler: "listEvents", method: "get", path: "/api/v1/events", tag: "Events", summary: "List events",
    description: "Newest first. The same objects that are sent to your webhook endpoints, byte for byte. `type` must be one of the documented event types.",
    query: eventsQuery, success: [{ status: 200, schema: eventList, description: "A page of events." }], errors: { 400: LIST },
  },
  {
    handler: "getEvent", method: "get", path: "/api/v1/events/{eventId}", tag: "Events", summary: "Retrieve an event",
    description: "Use it to confirm a webhook payload or to recover after missed deliveries.",
    pathParams: { eventId: S.eventId }, success: [{ status: 200, schema: S.event, description: "The event." }], errors: { 404: NF },
  },
  // ------------------------------------------------------------------------------------------ webhook endpoints
  {
    handler: "createWebhookEndpoint", method: "post", path: "/api/v1/webhook-endpoints", tag: "Webhook endpoints", idempotency: "optional", summary: "Create a webhook endpoint",
    description: "Registers an HTTPS URL. The response contains the signing `secret` (`whsec_…`) **once**; store it now. Repeating the request with the same `Idempotency-Key` returns the same secret. See the webhook guide for verifying signatures.",
    body: [createWebhookEndpointBody],
    success: [{ status: 201, schema: S.webhookEndpoint, description: "The endpoint, including `secret`.", replayHeader: true }],
    errors: { 400: [...BODY, "invalid_url", "url_not_allowed", "invalid_idempotency_key"], 409: ["endpoint_limit_reached", "idempotency_key_in_progress"], 422: ["idempotency_key_reused"], ...BODY_LIMITS },
  },
  {
    handler: "listWebhookEndpoints", method: "get", path: "/api/v1/webhook-endpoints", tag: "Webhook endpoints", summary: "List webhook endpoints",
    description: "Newest first. Deleted endpoints are not listed. Secrets are never included.", query: webhookEndpointsQuery,
    success: [{ status: 200, schema: endpointList, description: "A page of endpoints." }], errors: { 400: LIST },
  },
  {
    handler: "getWebhookEndpoint", method: "get", path: "/api/v1/webhook-endpoints/{endpointId}", tag: "Webhook endpoints", summary: "Retrieve a webhook endpoint",
    description: "Never includes the secret.", pathParams: { endpointId: S.endpointId }, success: [{ status: 200, schema: S.webhookEndpoint, description: "The endpoint." }], errors: { 404: NF },
  },
  {
    handler: "updateWebhookEndpoint", method: "patch", path: "/api/v1/webhook-endpoints/{endpointId}", tag: "Webhook endpoints", summary: "Update a webhook endpoint",
    description: "Change the URL, description, subscribed events, status or retry limit, or configure failure simulation (`failure_mode`, `failure_mode_remaining`, `failure_delay_seconds`). At least one field is required.",
    pathParams: { endpointId: S.endpointId }, body: [updateWebhookEndpointBody], success: [{ status: 200, schema: S.webhookEndpoint, description: "The updated endpoint." }],
    errors: { 400: [...BODY, "invalid_url", "url_not_allowed"], 404: NF, ...BODY_LIMITS },
  },
  {
    handler: "deleteWebhookEndpoint", method: "delete", path: "/api/v1/webhook-endpoints/{endpointId}", tag: "Webhook endpoints", summary: "Delete a webhook endpoint",
    description: "Soft delete: pending deliveries are cancelled, delivery history stays readable.", pathParams: { endpointId: S.endpointId },
    success: [{ status: 200, schema: S.deletedWebhookEndpoint, description: "Confirmation with the number of cancelled deliveries." }], errors: { 404: NF },
  },
  {
    handler: "rotateWebhookSecret", method: "post", path: "/api/v1/webhook-endpoints/{endpointId}/rotate-secret", tag: "Webhook endpoints", summary: "Rotate the signing secret",
    description: "Returns a new `secret` once. For 24 hours every delivery carries a signature for both the new and the previous secret, so receivers can switch without downtime.",
    pathParams: { endpointId: S.endpointId }, success: [{ status: 200, schema: S.webhookEndpoint, description: "The endpoint, including the new `secret`." }], errors: { 404: NF },
  },
  {
    handler: "sendWebhookTest", method: "post", path: "/api/v1/webhook-endpoints/{endpointId}/test", tag: "Webhook endpoints", summary: "Send a test event",
    description: "Queues a `webhook_endpoint.test` event to this endpoint only. The delivery happens on the next scheduler tick (within about a minute). Limited to 10 per endpoint per minute.",
    pathParams: { endpointId: S.endpointId }, success: [{ status: 202, schema: S.webhookDelivery, description: "The queued delivery." }], errors: { 404: NF, 409: ["endpoint_disabled"], 429: ["too_many_requests"] },
  },
  // ------------------------------------------------------------------------------------------ webhook deliveries
  {
    handler: "listWebhookDeliveries", method: "get", path: "/api/v1/webhook-deliveries", tag: "Webhook deliveries", summary: "List webhook deliveries",
    description: "Newest first. Filter by endpoint, event or status.", query: webhookDeliveriesQuery, success: [{ status: 200, schema: deliveryList, description: "A page of deliveries." }], errors: { 400: LIST },
  },
  {
    handler: "getWebhookDelivery", method: "get", path: "/api/v1/webhook-deliveries/{deliveryId}", tag: "Webhook deliveries", summary: "Retrieve a webhook delivery",
    description: "Includes the attempt history (status code, error code, duration, response excerpt).", pathParams: { deliveryId: S.deliveryId },
    success: [{ status: 200, schema: S.webhookDelivery, description: "The delivery with `attempts`." }], errors: { 404: NF },
  },
  {
    handler: "retryWebhookDelivery", method: "post", path: "/api/v1/webhook-deliveries/{deliveryId}/retry", tag: "Webhook deliveries", summary: "Retry a webhook delivery now",
    description: "Schedules an immediate extra attempt of a delivery that has been attempted. Limited to 10 per account per minute.", pathParams: { deliveryId: S.deliveryId },
    success: [{ status: 202, schema: S.webhookDelivery, description: "The delivery, rescheduled." }],
    errors: { 404: NF, 409: ["delivery_cancelled", "delivery_not_attempted", "delivery_in_progress", "endpoint_disabled"], 429: ["too_many_requests"] },
  },
];

export const EVENT_TYPE_LIST = EVENT_TYPES;
