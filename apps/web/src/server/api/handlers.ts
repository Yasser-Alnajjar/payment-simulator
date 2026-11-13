import { requestFingerprint } from "@sandbox/core";
import { authenticate, type ApiAuth } from "./auth";
import type { ApiDeps } from "./deps";
import { eventRaw, listDto, paymentDto, RawJson, rawList, sessionDto } from "./dto";
import { ApiError, invalidRequest } from "./errors";
import { errorResponse, newRequestId, readJsonBody, toResponse, type ApiResult } from "./http";
import { consumeUserRateLimit, rateHeaders } from "./rate-limit";
import { createSessionBody, eventsQuery, paymentsQuery, parseMoney, parseWith, queryObject, sessionsQuery } from "./validation";
import { API_VERSION } from "../lifecycle";
import { cancelCheckoutSession, createCheckoutSession, getCheckoutSession, listCheckoutSessions } from "../services/checkout-sessions";
import { getEvent, listEvents } from "../services/events";
import { getPayment, listPayments } from "../services/payments";

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

const IDEM_KEY = /^[A-Za-z0-9_.:-]{1,255}$/;

export const handlers = {
  createSession: (req: Request, deps: ApiDeps) =>
    run(req, deps, async (c) => {
      const raw = await readJsonBody(c.req);
      const body = parseWith(createSessionBody, raw);
      const amountMinor = parseMoney(body.amount, body.currency);
      const keyHeader = c.req.headers.get("idempotency-key");
      if (keyHeader !== null && !IDEM_KEY.test(keyHeader)) throw invalidRequest("invalid_idempotency_key", "Idempotency-Key must be 1-255 characters of A-Z a-z 0-9 _ . : -");
      const idem = keyHeader === null ? null : { key: keyHeader, fingerprint: requestFingerprint("POST", "/api/v1/checkout/sessions", API_VERSION, raw) };
      const r = await createCheckoutSession(
        c.deps.db, { encKey: c.deps.encKey, appUrl: c.deps.appUrl, now: c.now }, c.auth.userId,
        {
          amountMinor, currency: body.currency, externalReference: body.external_reference ?? null, metadata: body.metadata ?? {},
          expiresInSeconds: body.expires_in ?? 1800, presetScenario: body.scenario ?? null,
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
    run(req, deps, async (c) => ({ status: 200, body: sessionDto(await getCheckoutSession(c.deps.db, c.auth.userId, id, c.now)) })),

  cancelSession: (req: Request, deps: ApiDeps, id: string) =>
    run(req, deps, async (c) => ({ status: 200, body: sessionDto(await cancelCheckoutSession(c.deps.db, c.auth.userId, id, c.now)) })),

  listPayments: (req: Request, deps: ApiDeps) =>
    run(req, deps, async (c) => {
      const q = parseWith(paymentsQuery, queryObject(c.url));
      const page = await listPayments(c.deps.db, c.auth.userId, c.now, { limit: q.limit, startingAfter: q.starting_after, status: q.status, checkoutSessionId: q.checkout_session_id });
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
};
