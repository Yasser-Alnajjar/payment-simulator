import { requestFingerprint } from "@sandbox/core";
import { authenticate, type ApiAuth } from "./auth";
import type { ApiDeps } from "./deps";
import { eventRaw, listDto, paymentDto, paymentMethodDto, RawJson, rawList, sessionDto, setupSessionDto } from "./dto";
import { ApiError, invalidRequest } from "./errors";
import { errorResponse, newRequestId, readJsonBody, toResponse, type ApiResult } from "./http";
import { consumeUserRateLimit, rateHeaders } from "./rate-limit";
import { createChargeBody, createMethodBody, createSessionBody, createSetupBody, defaultMethodQuery, eventsQuery, methodsQuery, paymentsQuery, parseMoney, parseWith, queryObject, sessionsQuery } from "./validation";
import { API_VERSION } from "../lifecycle";
import { cancelCheckoutSession, createCheckoutSession, getCheckoutSession, listCheckoutSessions } from "../services/checkout-sessions";
import { getEvent, listEvents } from "../services/events";
import { getPayment, listPayments } from "../services/payments";
import { IDEM_KEY } from "../services/api-idempotency";
import { createCharge } from "../services/charges";
import { assertCustomer, createPaymentMethod, disablePaymentMethod, getDefaultPaymentMethod, getPaymentMethod, listPaymentMethods, removePaymentMethod, setDefaultPaymentMethod } from "../services/payment-methods";
import { cancelSetupSession, createSetupSession, getSetupSession } from "../services/setup-sessions";

interface Ctx { req: Request; deps: ApiDeps; auth: ApiAuth; url: URL; now: Date }

/**
 * The single API pipeline: request id -> authentication (API credential only) -> per-user rate limit -> handler.
 * Responses never carry CORS headers (server-to-server API), are never cached, and always carry Request-Id.
 * Unexpected errors are logged by name only (no payloads, no secrets) and answered with a generic 500.
 */
async function run(req: Request, deps: ApiDeps, handler: (c: Ctx) => Promise<ApiResult>): Promise<Response> {
  const requestId = newRequestId();
  let extra: Record<string, string> = {};
  try {
    const auth = await authenticate(req, deps);
    extra = rateHeaders(await consumeUserRateLimit(deps.db, auth.userId, deps.config.rateLimitPerMinute));
    const result = await handler({ req, deps, auth, url: new URL(req.url), now: deps.now() });
    return toResponse(result, requestId, extra);
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e, requestId, extra);
    console.error("api error", requestId, e instanceof Error ? e.name : "unknown");
    return errorResponse(new ApiError(500, "api_error", "internal_error", "Something went wrong"), requestId, extra);
  }
}

const idemKeyOf = (req: Request, required: boolean): { key: string } | null => {
  const h = req.headers.get("idempotency-key");
  if (h === null) {
    if (required) throw invalidRequest("idempotency_key_required", "This endpoint requires an Idempotency-Key header", "Idempotency-Key");
    return null;
  }
  if (!IDEM_KEY.test(h)) throw invalidRequest("invalid_idempotency_key", "Idempotency-Key must be 1-255 characters of A-Z a-z 0-9 _ . : -");
  return { key: h };
};
const isSetupId = (id: string) => id.startsWith("seti_");

export const handlers = {
  createSession: (req: Request, deps: ApiDeps) =>
    run(req, deps, async (c) => {
      const raw = await readJsonBody(c.req);
      if (raw.mode === "setup") {
        const sb = parseWith(createSetupBody, raw);
        const r = await createSetupSession(c.deps.db, { encKey: c.deps.encKey, appUrl: c.deps.appUrl, now: c.now }, c.auth.userId,
          { customer: sb.customer, externalReference: sb.external_reference ?? null, metadata: sb.metadata ?? {}, expiresInSeconds: sb.expires_in ?? 1800, rawBody: raw }, idemKeyOf(c.req, false));
        return { status: r.status, body: r.body, headers: r.replayed ? { "idempotent-replayed": "true" } : undefined };
      }
      const body = parseWith(createSessionBody, raw);
      const amountMinor = parseMoney(body.amount, body.currency);
      const keyHeader = c.req.headers.get("idempotency-key");
      if (keyHeader !== null && !IDEM_KEY.test(keyHeader)) throw invalidRequest("invalid_idempotency_key", "Idempotency-Key must be 1-255 characters of A-Z a-z 0-9 _ . : -");
      const idem = keyHeader === null ? null : { key: keyHeader, fingerprint: requestFingerprint("POST", "/api/v1/checkout/sessions", API_VERSION, raw) };
      const r = await createCheckoutSession(
        c.deps.db, { encKey: c.deps.encKey, appUrl: c.deps.appUrl, now: c.now }, c.auth.userId,
        {
          amountMinor, currency: body.currency, externalReference: body.external_reference ?? null, metadata: body.metadata ?? {},
          expiresInSeconds: body.expires_in ?? 1800, presetScenario: body.scenario ?? null, customerReference: body.customer ?? null,
        },
        idem,
      );
      return { status: r.status, body: r.body, headers: r.replayed ? { "idempotent-replayed": "true" } : undefined };
    }),

  listSessions: (req: Request, deps: ApiDeps) =>
    run(req, deps, async (c) => {
      const q = parseWith(sessionsQuery, queryObject(c.url));
      const page = await listCheckoutSessions(c.deps.db, c.auth.userId, c.now, { limit: q.limit, startingAfter: q.starting_after, status: q.status, externalReference: q.external_reference });
      return { status: 200, body: listDto(page.items.map((s) => sessionDto(s)), page.hasMore) };
    }),

  getSession: (req: Request, deps: ApiDeps, id: string) =>
    run(req, deps, async (c) => ({
      status: 200,
      body: isSetupId(id) ? setupSessionDto(await getSetupSession(c.deps.db, c.auth.userId, id, c.now)) : sessionDto(await getCheckoutSession(c.deps.db, c.auth.userId, id, c.now)),
    })),

  cancelSession: (req: Request, deps: ApiDeps, id: string) =>
    run(req, deps, async (c) => ({
      status: 200,
      body: isSetupId(id) ? setupSessionDto(await cancelSetupSession(c.deps.db, c.auth.userId, id, c.now)) : sessionDto(await cancelCheckoutSession(c.deps.db, c.auth.userId, id, c.now)),
    })),

  listPayments: (req: Request, deps: ApiDeps) =>
    run(req, deps, async (c) => {
      const q = parseWith(paymentsQuery, queryObject(c.url));
      const page = await listPayments(c.deps.db, c.auth.userId, c.now, { limit: q.limit, startingAfter: q.starting_after, status: q.status, checkoutSessionId: q.checkout_session_id, paymentMethod: q.payment_method, customer: q.customer });
      return { status: 200, body: listDto(page.items.map((x) => paymentDto(x.payment, x.session)), page.hasMore) };
    }),

  getPayment: (req: Request, deps: ApiDeps, id: string) =>
    run(req, deps, async (c) => {
      const x = await getPayment(c.deps.db, c.auth.userId, id, c.now);
      return { status: 200, body: paymentDto(x.payment, x.session) };
    }),

  listEvents: (req: Request, deps: ApiDeps) =>
    run(req, deps, async (c) => {
      const q = parseWith(eventsQuery, queryObject(c.url));
      const page = await listEvents(c.deps.db, c.auth.userId, c.now, { limit: q.limit, startingAfter: q.starting_after, type: q.type });
      return { status: 200, body: rawList(page.items.map(eventRaw), page.hasMore) };
    }),

  getEvent: (req: Request, deps: ApiDeps, id: string) =>
    run(req, deps, async (c) => ({ status: 200, body: new RawJson(eventRaw(await getEvent(c.deps.db, c.auth.userId, id))) })),

  createCharge: (req: Request, deps: ApiDeps) =>
    run(req, deps, async (c) => {
      const raw = await readJsonBody(c.req);
      const idem = idemKeyOf(c.req, true)!;
      const b = parseWith(createChargeBody, raw);
      const r = await createCharge(c.deps.db, { now: c.now }, c.auth.userId, {
        paymentMethod: b.payment_method, amountMinor: parseMoney(b.amount, b.currency), currency: b.currency, customer: b.customer,
        externalReference: b.external_reference ?? null, metadata: b.metadata ?? {}, rawBody: raw,
      }, idem);
      return { status: r.status, body: r.body, headers: r.replayed ? { "idempotent-replayed": "true" } : undefined };
    }),

  createPaymentMethod: (req: Request, deps: ApiDeps) =>
    run(req, deps, async (c) => {
      const b = parseWith(createMethodBody, await readJsonBody(c.req)); // card details live only in this request's memory
      const r = await createPaymentMethod(c.deps.db, { encKey: c.deps.encKey, now: c.now }, c.auth.userId, { customer: b.customer, card: b.card, setDefault: b.set_default ?? false }, idemKeyOf(c.req, false));
      return { status: r.status, body: r.body, headers: r.replayed ? { "idempotent-replayed": "true" } : undefined };
    }),

  listPaymentMethods: (req: Request, deps: ApiDeps) =>
    run(req, deps, async (c) => {
      const q = parseWith(methodsQuery, queryObject(c.url));
      const page = await listPaymentMethods(c.deps.db, c.auth.userId, c.now, { limit: q.limit, startingAfter: q.starting_after, customer: q.customer, status: q.status });
      return { status: 200, body: listDto(page.items.map((m) => paymentMethodDto(m, c.now)), page.hasMore) };
    }),

  getDefaultPaymentMethod: (req: Request, deps: ApiDeps) =>
    run(req, deps, async (c) => {
      const q = parseWith(defaultMethodQuery, queryObject(c.url));
      return { status: 200, body: paymentMethodDto(await getDefaultPaymentMethod(c.deps.db, c.auth.userId, assertCustomer(q.customer)), c.now) };
    }),

  getPaymentMethod: (req: Request, deps: ApiDeps, id: string) =>
    run(req, deps, async (c) => ({ status: 200, body: paymentMethodDto(await getPaymentMethod(c.deps.db, c.auth.userId, id), c.now) })),

  setDefaultPaymentMethod: (req: Request, deps: ApiDeps, id: string) =>
    run(req, deps, async (c) => ({ status: 200, body: paymentMethodDto(await setDefaultPaymentMethod(c.deps.db, c.auth.userId, id, c.now), c.now) })),

  disablePaymentMethod: (req: Request, deps: ApiDeps, id: string) =>
    run(req, deps, async (c) => ({ status: 200, body: paymentMethodDto(await disablePaymentMethod(c.deps.db, c.auth.userId, id, c.now), c.now) })),

  deletePaymentMethod: (req: Request, deps: ApiDeps, id: string) =>
    run(req, deps, async (c) => {
      const r = await removePaymentMethod(c.deps.db, c.auth.userId, id, c.now);
      return { status: 200, body: { id: r.id, object: "payment_method", deleted: true } };
    }),
};
