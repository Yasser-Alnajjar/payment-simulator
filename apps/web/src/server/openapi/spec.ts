import { z } from "zod";
import { EVENT_TYPES, SIGNATURE_TOLERANCE_SECONDS } from "@sandbox/core";
import { API_VERSION } from "../lifecycle";
import { COMMON_ERRORS, ERROR_CODES } from "./errors";
import { OPERATIONS, type Operation } from "./operations";
import * as S from "./schemas";

type Json = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** Names for request bodies (their zod schemas live in `server/api/validation.ts` and are not modified). */
const BODY_IDS = new Map<string, string>([
  ["createSession", "CreateCheckoutSessionRequest|CreateSetupSessionRequest"], ["createCharge", "CreateChargeRequest"], ["createPaymentMethod", "CreatePaymentMethodRequest"],
  ["createWebhookEndpoint", "CreateWebhookEndpointRequest"], ["updateWebhookEndpoint", "UpdateWebhookEndpointRequest"],
]);

/** Registers every schema once, under a stable component name, and returns the converted components. */
function buildComponents(): Record<string, Json> {
  const reg = z.registry<{ id?: string }>();
  const add = (schema: z.ZodType, id: string) => reg.add(schema, { id });
  const seen = new Set<unknown>();
  for (const op of OPERATIONS) {
    const names = (BODY_IDS.get(op.handler) ?? "").split("|");
    (op.body ?? []).forEach((b, i) => { if (!seen.has(b)) { seen.add(b); add(b, names[i]!); } });
    for (const s of op.success) {
      const meta = z.globalRegistry.get(s.schema)?.id;
      if (meta && !seen.has(s.schema)) { seen.add(s.schema); add(s.schema, meta); }
    }
  }
  for (const [schema, id] of [[S.errorBody, "Error"], [S.event, "Event"], [S.webhookAttempt, "WebhookAttempt"], [S.paymentMethod, "PaymentMethod"], [S.checkoutSession, "CheckoutSession"], [S.setupSession, "SetupSession"], [S.payment, "Payment"], [S.webhookEndpoint, "WebhookEndpoint"], [S.webhookDelivery, "WebhookDelivery"]] as const) {
    if (!seen.has(schema)) { seen.add(schema); add(schema, id); }
  }
  const out = z.toJSONSchema(reg, { target: "draft-2020-12", io: "output", unrepresentable: "any", uri: (id) => `#/components/schemas/${id}` }) as { schemas: Record<string, Json> };
  const comps: Record<string, Json> = {};
  for (const [name, schema] of Object.entries(out.schemas)) comps[name] = clean(schema, name.endsWith("Request")) as Json;
  return comps;
}

/** Strips JSON-Schema-only noise. Responses stay open to additive fields (`additionalProperties:false` removed); requests stay strict. */
function clean(node: unknown, keepStrict: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => clean(n, keepStrict));
  if (node && typeof node === "object") {
    const o: Json = {};
    for (const [k, v] of Object.entries(node as Json)) {
      if (k === "$schema" || k === "$id" || (k === "id" && typeof v === "string")) continue;
      if (k === "additionalProperties" && v === false && !keepStrict) continue;
      o[k] = clean(v, keepStrict);
    }
    return o;
  }
  return node;
}

function propSchema(schema: z.ZodType): Json {
  return clean(z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }), true) as Json;
}

const requestIdHeader = { "Request-Id": { description: "Unique id of this request. Quote it in support requests.", schema: { type: "string" } } };
const AFTER_AUTH = " Sent on every response after successful authentication; not on `401` and not on `too_many_failed_attempts`.";
const rateHeaders = {
  ...requestIdHeader,
  "X-RateLimit-Limit": { description: "Requests allowed per minute for your account." + AFTER_AUTH, schema: { type: "integer" } },
  "X-RateLimit-Remaining": { description: "Requests left in the current one-minute window." + AFTER_AUTH, schema: { type: "integer" } },
  "X-RateLimit-Reset": { description: "Unix time at which the window resets." + AFTER_AUTH, schema: { type: "integer" } },
};

function parameters(op: Operation): Json[] {
  const out: Json[] = [];
  for (const [name, schema] of Object.entries(op.pathParams ?? {})) out.push({ name, in: "path", required: true, schema: propSchema(schema) });
  if (op.query) {
    for (const [name, schema] of Object.entries(op.query.shape as Record<string, z.ZodType>)) {
      out.push({ name, in: "query", required: !schema.safeParse(undefined).success, schema: propSchema(schema) });
    }
  }
  if (op.idempotency) {
    out.push({
      name: "Idempotency-Key", in: "header", required: op.idempotency === "required",
      description: "1-255 characters of A-Z a-z 0-9 _ . : -. A retry with the same key and body returns the original response (`Idempotent-Replayed: true`); the same key with a different body is `422 idempotency_key_reused`.",
      schema: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,255}$" },
    });
  }
  return out;
}

function responses(op: Operation): Json {
  const out: Record<string, Json> = {};
  for (const s of op.success) {
    const name = z.globalRegistry.get(s.schema)?.id;
    out[String(s.status)] = {
      description: s.description,
      headers: { ...rateHeaders, ...(s.replayHeader ? { "Idempotent-Replayed": { description: "`true` when this is the stored response of an earlier request with the same key.", schema: { type: "string", enum: ["true"] } } } : {}) },
      content: { "application/json": { schema: name ? ref(name) : propSchema(s.schema) } },
    };
  }
  const byStatus: Record<number, string[]> = {};
  for (const [st, codes] of Object.entries({ ...op.errors })) byStatus[Number(st)] = [...codes];
  for (const [st, codes] of Object.entries(COMMON_ERRORS)) byStatus[Number(st)] = [...new Set([...(byStatus[Number(st)] ?? []), ...codes])];
  for (const [st, codes] of Object.entries(byStatus).sort(([a], [b]) => Number(a) - Number(b))) {
    const list = codes.map((c) => `- \`${c}\`: ${ERROR_CODES[c]!.description}`).join("\n");
    out[st] = {
      description: `Error. \`error.code\` is one of:\n\n${list}`,
      headers: { ...(st === "401" ? { ...requestIdHeader, "WWW-Authenticate": { schema: { type: "string" }, description: "Basic challenge." } } : rateHeaders), ...(st === "429" ? { "Retry-After": { schema: { type: "integer" }, description: "Seconds to wait." } } : {}) },
      content: { "application/json": { schema: ref("Error"), examples: { [codes[0]!]: { value: errorExample(Number(st), codes[0]!) } } } },
    };
  }
  return out;
}

export function errorExample(status: number, code: string): Json {
  const info = ERROR_CODES[code]!;
  return { error: { type: info.type, code, message: info.description.split(".")[0] + ".", request_id: "req_Qm7u3sZq9T1xKc2P", ...(status === 400 && code === "invalid_parameter" ? { param: "amount" } : {}) } };
}

function operation(op: Operation): Json {
  const o: Json = {
    operationId: op.handler, tags: [op.tag], summary: op.summary, description: op.description, security: [{ basicAuth: [] }],
    parameters: parameters(op), responses: responses(op),
  };
  if (op.body) {
    const names = (BODY_IDS.get(op.handler) ?? "").split("|");
    const schema = op.body.length === 1 ? ref(names[0]!) : { oneOf: names.map(ref) };
    o.requestBody = { required: true, content: { "application/json": { schema } } };
  }
  return o;
}

export function buildOpenApiDocument(): Json {
  const paths: Record<string, Json> = {};
  for (const op of OPERATIONS) (paths[op.path] ??= {})[op.method] = operation(op);

  const components = buildComponents();
  const eventExamples = EVENT_TYPES.map((t) => `\`${t}\``).join(", ");
  return {
    openapi: "3.1.0",
    info: {
      title: "Payment Sandbox API",
      version: API_VERSION,
      summary: "A test-mode payment provider for developers. No real money, no real cards.",
      description: [
        "Create hosted checkouts, simulate every payment outcome, save and charge **test** cards, and receive signed webhooks.",
        "",
        "**Everything here is simulated.** Real card numbers are refused; no real payment provider is connected.",
        "",
        "## Authentication",
        "HTTP Basic: `Authorization: Basic base64(client_id:client_secret)` with an API credential created in the dashboard. Send it over HTTPS only. Dashboard cookies are never accepted by the API.",
        "",
        "## Conventions",
        "- JSON in, JSON out; send `Content-Type: application/json` (max 64 KiB). Unknown request fields are rejected with `unknown_parameter`.",
        "- Amounts are decimal strings (`\"149.00\"`) plus an integer `amount_minor`. Never floats.",
        "- Lists are newest first and use cursors: `limit` (1-100, default 10) and `starting_after` (an id from the previous page); `has_more` tells you whether to continue.",
        "- Errors always have the shape of the `Error` schema. Branch on `error.code`, never on `message`.",
        "- Rate limit: per account per minute, reported in `X-RateLimit-*` headers; `429` carries `Retry-After`.",
        "- Idempotency: send `Idempotency-Key` on any create call you may retry (required for `POST /payments`).",
        `- API version: \`${API_VERSION}\`, also written into every event as \`api_version\`. Responses may gain fields; ignore the ones you do not know.`,
        "",
        "## Webhooks",
        `Events (${eventExamples}) are POSTed to your endpoints with a \`Sandbox-Signature\` header; see the \`webhooks\` section below and the webhook guide for verification.`,
      ].join("\n"),
    },
    servers: [{ url: "/", description: "This deployment (same origin as this document)." }],
    tags: [
      { name: "Checkout sessions", description: "Hosted checkouts for a payment, or for saving a test card (setup mode)." },
      { name: "Payments", description: "Payment records, and charges against saved test cards." },
      { name: "Payment methods", description: "Saved **test** cards. Only the published test numbers are accepted." },
      { name: "Events", description: "Immutable records of everything that happens. Also the payload of webhooks." },
      { name: "Webhook endpoints", description: "Where we send events, with per-endpoint signing secrets and failure simulation." },
      { name: "Webhook deliveries", description: "One delivery per event per endpoint, with attempt history and manual retry." },
    ],
    paths,
    webhooks: {
      event: {
        post: {
          operationId: "webhookEvent", security: [], tags: ["Webhook endpoints"], summary: "Event delivery (sent by us, to your endpoint)",
          description: [
            "We POST each event to every enabled endpoint subscribed to its type. Respond `2xx` within 10 seconds. Anything else is retried with exponential backoff (see the webhook guide); delivery is **at least once** and unordered, so deduplicate on `Sandbox-Event-Id`.",
            "",
            `**Verify the signature on the raw body bytes** before parsing: \`v1 = hex(HMAC-SHA256(key = your whsec_ secret, message = t + "." + raw_body))\`. Accept if any \`v1\` matches (two are sent for 24 hours after a rotation) and \`t\` is within ${SIGNATURE_TOLERANCE_SECONDS} seconds of now.`,
          ].join("\n"),
          parameters: [
            { name: "Sandbox-Signature", in: "header", required: true, schema: { type: "string", example: "t=1763121600,v1=5f0c…" }, description: "`t=<unix seconds>,v1=<hex>[,v1=<hex>]`." },
            { name: "Sandbox-Event-Id", in: "header", required: true, schema: { type: "string" }, description: "The event id. Stable across retries; use it to deduplicate." },
            { name: "Sandbox-Delivery-Id", in: "header", required: true, schema: { type: "string" } },
            { name: "Sandbox-Delivery-Attempt", in: "header", required: true, schema: { type: "integer" }, description: "1 for the first attempt." },
            { name: "Sandbox-Timestamp", in: "header", required: true, schema: { type: "integer" }, description: "Same as `t` in the signature." },
          ],
          requestBody: { required: true, content: { "application/json": { schema: ref("Event") } } },
          responses: { "200": { description: "Return any 2xx to acknowledge. 408, 429 and 5xx are retried; other 4xx and redirects are permanent failures." } },
        },
      },
    },
    components: {
      securitySchemes: { basicAuth: { type: "http", scheme: "basic", description: "API credential: client id as the user name, client secret as the password." } },
      schemas: components,
    },
  };
}
