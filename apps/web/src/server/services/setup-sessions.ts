import { CardError, cardFingerprint, generateCheckoutToken, hashSecret, newUuid, openBound, parsePublicId, requestFingerprint, sealBound, tokenizeTestCard, toPublicId, type CardInput } from "@sandbox/core";
import type { PaymentMethod, PrismaClient, SetupSession } from "@sandbox/db";
import { writeAudit } from "../audit";
import { paymentMethodDto, setupSessionDto } from "../api/dto";
import { ApiError, conflict, notFound } from "../api/errors";
import { consumeBucket, sha } from "../api/rate-limit";
import { API_VERSION, emitEvent, TX_OPTIONS, type Tx } from "../lifecycle";
import { claimIdempotency, finishIdempotency } from "./api-idempotency";
import { checkoutUrl } from "./checkout-sessions";
import { cardErrorToApi, insertMethodLocked, lockCustomer, mapMethodRace } from "./payment-methods";

const TOKEN_PURPOSE = "idempotency-setup-token";
const aad = (userId: string, key: string, id: string) => `${userId}|${key}|${id}`;

export interface CreateSetupInput { customer: string; externalReference: string | null; metadata: Record<string, string>; expiresInSeconds: number; rawBody: unknown }
export interface SetupCreateResult { status: number; body: ReturnType<typeof setupSessionDto>; replayed: boolean }

/** Hosted-page abuse limits for setup attempts (same design as the payment limits; own bucket namespace). */
export interface SetupLimits { maxAttemptsPerSession: number; perOwnerPerMinute: number; globalPerMinute: number; unknownTokenPerMinute: number; namespace: string }
export const DEFAULT_SETUP_LIMITS: SetupLimits = { maxAttemptsPerSession: 10, perOwnerPerMinute: 120, globalPerMinute: 600, unknownTokenPerMinute: 120, namespace: "checkout-setup" };
const busy = () => new ApiError(429, "rate_limit_error", "too_many_requests", "Too many requests. Please wait a moment and try again.", undefined, { "retry-after": "60" });

function setupEventData(s: SetupSession, status: string, pm: PaymentMethod | null, now: Date) {
  return {
    checkout_session_id: toPublicId("setupSession", s.id), mode: "setup", customer: s.customerReference, external_reference: s.externalReference,
    status, payment_method: pm ? toPublicId("paymentMethod", pm.id) : null, payment_method_details: pm ? paymentMethodDto(pm, now) : null, metadata: s.metadata,
  };
}

/** Creates a setup-mode checkout session (no amount, no payment). The checkout token is stored hashed; the replay copy is sealed with a purpose-derived key. */
export async function createSetupSession(
  db: PrismaClient, deps: { encKey: string; appUrl: string; now: Date }, userId: string, input: CreateSetupInput, idem: { key: string } | null,
): Promise<SetupCreateResult> {
  const { token, tokenHash } = generateCheckoutToken();
  const id = newUuid();
  const createdAt = deps.now;
  const expiresAt = new Date(createdAt.getTime() + input.expiresInSeconds * 1000);
  const row: SetupSession = {
    id, seq: 0n, userId, tokenHash, customerReference: input.customer, externalReference: input.externalReference, metadata: input.metadata, status: "open",
    paymentMethodId: null, attemptCount: 0, lastFailureCode: null, expiresAt, createdAt, updatedAt: createdAt,
  };
  const body = setupSessionDto(row, { url: checkoutUrl(deps.appUrl, token) });
  const { url: _omit, ...stored } = body;
  void _omit;
  const requestHash = idem ? requestFingerprint("POST", "/api/v1/checkout/sessions", API_VERSION, input.rawBody) : "";

  return db.$transaction(async (tx): Promise<SetupCreateResult> => {
    if (idem) {
      const tokenEnc = sealBound(token, deps.encKey, TOKEN_PURPOSE, aad(userId, idem.key, id));
      const c = await claimIdempotency(tx, userId, "setup_session.create", { key: idem.key, requestHash }, id, tokenEnc);
      if (!c.claimed) {
        const oldToken = openBound(c.replay.tokenEnc ?? "", deps.encKey, TOKEN_PURPOSE, aad(userId, idem.key, c.replay.resourceId));
        return { status: c.replay.status, body: { ...(c.replay.response as object), url: checkoutUrl(deps.appUrl, oldToken) } as SetupCreateResult["body"], replayed: true };
      }
    }
    await tx.setupSession.create({
      data: { id, userId, tokenHash, customerReference: input.customer, externalReference: input.externalReference, metadata: input.metadata, status: "open", expiresAt, createdAt, updatedAt: createdAt },
    });
    await writeAudit(tx, { userId, action: "setup_session.created", targetType: "setup_session", targetId: id });
    if (idem) await finishIdempotency(tx, userId, "setup_session.create", idem.key, 201, stored);
    return { status: 201, body, replayed: false };
  }, TX_OPTIONS);
}

async function lockSetup(tx: Tx, userId: string, id: string): Promise<SetupSession | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM setup_sessions WHERE id = ${id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
  return rows.length === 0 ? null : tx.setupSession.findFirst({ where: { id, userId } });
}

/** An open session past its expiry becomes `expired` (one event). Call with the row locked. */
async function settleSetupLocked(tx: Tx, s: SetupSession, now: Date): Promise<SetupSession> {
  if (s.status !== "open" || s.expiresAt > now) return s;
  const next = await tx.setupSession.update({ where: { id: s.id }, data: { status: "expired", updatedAt: now } });
  await emitEvent(tx, { userId: s.userId, type: "checkout.session.expired", subjectId: s.id, data: setupEventData(s, "expired", null, now), now });
  return next;
}

async function settleSetup(db: PrismaClient, userId: string, id: string, now: Date): Promise<SetupSession | null> {
  return db.$transaction(async (tx) => { const s = await lockSetup(tx, userId, id); return s ? settleSetupLocked(tx, s, now) : null; }, TX_OPTIONS);
}

export async function getSetupSession(db: PrismaClient, userId: string, publicId: string, now: Date): Promise<SetupSession> {
  const id = parsePublicId("setupSession", publicId);
  if (!id) throw notFound("Checkout session");
  const s = await db.setupSession.findFirst({ where: { id, userId } });
  if (!s) throw notFound("Checkout session");
  if (s.status === "open" && s.expiresAt <= now) return (await settleSetup(db, userId, id, now)) ?? s;
  return s;
}

export async function cancelSetupSession(db: PrismaClient, userId: string, publicId: string, now: Date): Promise<SetupSession> {
  const id = parsePublicId("setupSession", publicId);
  if (!id) throw notFound("Checkout session");
  return db.$transaction(async (tx) => {
    const locked = await lockSetup(tx, userId, id);
    if (!locked) throw notFound("Checkout session");
    const s = await settleSetupLocked(tx, locked, now);
    if (s.status === "cancelled") return s;
    if (s.status !== "open") throw conflict("invalid_state_transition", `A ${s.status} checkout session cannot be cancelled`);
    const next = await tx.setupSession.update({ where: { id }, data: { status: "cancelled", updatedAt: now } });
    await emitEvent(tx, { userId, type: "checkout.session.cancelled", subjectId: id, data: setupEventData(s, "cancelled", null, now), now });
    await writeAudit(tx, { userId, action: "setup_session.cancelled", targetType: "setup_session", targetId: id });
    return next;
  }, TX_OPTIONS);
}

// ---------------------------------------------------------------- hosted page (authorized by the secret token only)

export interface SetupView {
  mode: "setup";
  status: "open" | "completed" | "expired" | "cancelled";
  customer: string;
  reference: string | null;
  expiresAt: string;
  failureCode: string | null;
  /** Safe display of the saved card after a successful setup. */
  card: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  canSubmit: boolean;
}

const validShape = (t: unknown): t is string => typeof t === "string" && t.length >= 20 && t.length <= 100 && /^[A-Za-z0-9_-]+$/.test(t);
async function refFor(db: PrismaClient, token: unknown) {
  if (!validShape(token)) return null;
  return db.setupSession.findUnique({ where: { tokenHash: hashSecret(token) }, select: { id: true, userId: true } });
}

export async function getSetupView(db: PrismaClient, token: unknown, now: Date): Promise<SetupView | null> {
  const ref = await refFor(db, token);
  if (!ref) return null;
  let s = await db.setupSession.findFirst({ where: { id: ref.id, userId: ref.userId } });
  if (!s) return null;
  if (s.status === "open" && s.expiresAt <= now) s = (await settleSetup(db, ref.userId, ref.id, now)) ?? s;
  const pm = s.paymentMethodId ? await db.paymentMethod.findFirst({ where: { id: s.paymentMethodId, userId: ref.userId } }) : null;
  return {
    mode: "setup", status: s.status as SetupView["status"], customer: s.customerReference, reference: s.externalReference, expiresAt: s.expiresAt.toISOString(),
    failureCode: s.lastFailureCode, card: pm ? { brand: pm.brand, last4: pm.last4, expMonth: pm.expMonth, expYear: pm.expYear } : null, canSubmit: s.status === "open",
  };
}

export async function cancelSetupByToken(db: PrismaClient, token: unknown, now: Date): Promise<void> {
  const ref = await refFor(db, token);
  if (!ref) throw notFound("Checkout session");
  await cancelSetupSession(db, ref.userId, toPublicId("setupSession", ref.id), now);
}

export interface SetupAttemptResult { session: SetupSession; paymentMethod: PaymentMethod }

/**
 * The customer submits a test card on the hosted setup page. Validation errors (bad number, expiry, code, name, not a test card)
 * are rejected before anything is written and do not use an attempt. A card that is declined at setup records the attempt and a
 * failure code on the session, saves NOTHING, and leaves the session open. Success creates the payment method, completes the
 * session and emits payment_method.created (+ default_updated) and checkout.session.completed in one transaction.
 */
export async function attemptSetupByToken(
  db: PrismaClient, deps: { encKey: string }, input: { token: unknown; card: CardInput }, now: Date, limits: SetupLimits = DEFAULT_SETUP_LIMITS,
): Promise<SetupAttemptResult> {
  const ref = await refFor(db, input.token);
  if (!ref) {
    await consumeBucket(db, `${limits.namespace}:unknown`, limits.unknownTokenPerMinute, busy);
    throw notFound("Checkout session");
  }
  await consumeBucket(db, `${limits.namespace}:owner:${sha(ref.userId)}`, limits.perOwnerPerMinute, busy);
  await consumeBucket(db, `${limits.namespace}:all`, limits.globalPerMinute, busy);

  let token;
  try { token = tokenizeTestCard(input.card, now); } catch (e) { if (e instanceof CardError) throw cardErrorToApi(e); throw e; }
  const fingerprint = cardFingerprint(token.panForFingerprint, ref.userId, deps.encKey);

  const out = await db.$transaction(async (tx) => {
    const locked = await lockSetup(tx, ref.userId, ref.id);
    if (!locked) return { error: notFound("Checkout session") };
    await lockCustomer(tx, ref.userId, locked.customerReference);
    const s = await settleSetupLocked(tx, locked, now);
    if (s.status === "expired") return { error: conflict("session_expired", "This checkout session has expired") };
    if (s.status === "cancelled") return { error: conflict("session_cancelled", "This checkout session was cancelled") };
    if (s.status === "completed") return { error: conflict("session_already_completed", "A card was already added with this checkout session") };
    if (s.attemptCount >= limits.maxAttemptsPerSession) return { error: new ApiError(429, "rate_limit_error", "too_many_setup_attempts", "This checkout has reached its maximum number of attempts.") };
    if (token.behavior === "setup_declined") {
      await tx.setupSession.update({ where: { id: s.id }, data: { attemptCount: s.attemptCount + 1, lastFailureCode: "card_declined", updatedAt: now } });
      return { error: new ApiError(402, "card_error", "card_declined", "The card was declined while being added. It was not saved.", "card.number"), recorded: true };
    }
    const pm = await insertMethodLocked(tx, s.userId, { customer: s.customerReference, token, fingerprint, setDefault: false }, now);
    if (!pm) {
      await tx.setupSession.update({ where: { id: s.id }, data: { attemptCount: s.attemptCount + 1, lastFailureCode: "duplicate_payment_method", updatedAt: now } });
      return { error: conflict("duplicate_payment_method", "This card is already saved for this customer"), recorded: true };
    }
    const done = await tx.setupSession.update({ where: { id: s.id }, data: { status: "completed", paymentMethodId: pm.id, attemptCount: s.attemptCount + 1, lastFailureCode: null, updatedAt: now } });
    await emitEvent(tx, { userId: s.userId, type: "checkout.session.completed", subjectId: s.id, data: setupEventData(s, "completed", pm, now), now });
    return { ok: { session: done, paymentMethod: pm } };
  }, TX_OPTIONS).catch(mapMethodRace);

  if ("error" in out && out.error) throw out.error;
  return (out as { ok: SetupAttemptResult }).ok;
}
