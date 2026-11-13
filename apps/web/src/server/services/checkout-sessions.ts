import { generateCheckoutToken, newUuid, openBound, parsePublicId, sealBound, type Scenario } from "@sandbox/core";
import type { CheckoutSession, PrismaClient } from "@sandbox/db";
import { writeAudit } from "../audit";
import { sessionDto } from "../api/dto";
import { ApiError, invalidRequest, notFound } from "../api/errors";
import { EXPIRES_MAX, EXPIRES_MIN, parseMoney } from "../api/validation";
import { lockSession, needsSettle, settleLocked, settleSession, sweepUser, transitionPayment, transitionSession, TX_OPTIONS } from "../lifecycle";

const TOKEN_PURPOSE = "idempotency-checkout-token";
export const IDEMPOTENCY_TTL_HOURS = 24;
const aad = (userId: string, key: string, sessionId: string) => `${userId}|${key}|${sessionId}`;
export const checkoutUrl = (appUrl: string, token: string) => `${appUrl.replace(/\/$/, "")}/checkout/${token}`;

export interface CreateSessionInput {
  amountMinor: bigint;
  currency: string;
  externalReference: string | null;
  metadata: Record<string, string>;
  expiresInSeconds: number;
  presetScenario: Scenario | null;
  /** Optional external customer id; lets the hosted page offer this customer's saved test cards. */
  customerReference?: string | null;
}

export interface CreateResult { status: number; body: ReturnType<typeof sessionDto>; replayed: boolean }

/**
 * Creates a checkout session. With an idempotency key, the key row is claimed first with INSERT .. ON CONFLICT DO NOTHING in the
 * SAME transaction as the session: a concurrent request with the same key blocks on the unique index until this transaction
 * commits, then replays the stored response. The checkout token is stored only as a hash on the session; the replay copy lives
 * encrypted (purpose-derived key, AAD = user|key|session) in the idempotency row.
 */
export async function createCheckoutSession(
  db: PrismaClient, deps: { encKey: string; appUrl: string; now: Date },
  userId: string, input: CreateSessionInput, idem: { key: string; fingerprint: string } | null,
): Promise<CreateResult> {
  const { token, tokenHash } = generateCheckoutToken();
  const id = newUuid();
  const createdAt = deps.now;
  const expiresAt = new Date(createdAt.getTime() + input.expiresInSeconds * 1000);
  const row: CheckoutSession = {
    id, seq: 0n, userId, tokenHash, amountMinor: input.amountMinor, currency: input.currency, externalReference: input.externalReference,
    metadata: input.metadata, presetScenario: input.presetScenario, customerReference: input.customerReference ?? null, status: "open", expiresAt, createdAt, updatedAt: createdAt,
  };
  const url = checkoutUrl(deps.appUrl, token);
  const body = sessionDto(row, { url });
  const { url: _omit, ...stored } = body as typeof body & { url: string };
  void _omit;

  return db.$transaction(async (tx) => {
    if (idem) {
      await tx.$executeRaw`DELETE FROM idempotency_keys WHERE user_id = ${userId}::uuid AND key = ${idem.key} AND created_at < now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})`;
      const tokenEnc = sealBound(token, deps.encKey, TOKEN_PURPOSE, aad(userId, idem.key, id));
      const claimed = await tx.$executeRaw`
        INSERT INTO idempotency_keys (user_id, key, request_hash, status_code, response, token_enc, session_id)
        VALUES (${userId}::uuid, ${idem.key}, ${idem.fingerprint}, 201, ${JSON.stringify(stored)}::jsonb, ${tokenEnc}, ${id}::uuid)
        ON CONFLICT (user_id, key) DO NOTHING`;
      if (claimed === 0) {
        const existing = await tx.idempotencyKey.findUnique({ where: { userId_key: { userId, key: idem.key } } });
        if (!existing) throw new ApiError(409, "idempotency_error", "idempotency_key_in_progress", "A request with this idempotency key is still being processed; retry shortly");
        if (existing.requestHash !== idem.fingerprint) {
          throw new ApiError(422, "idempotency_error", "idempotency_key_reused", "This idempotency key was already used with a different request");
        }
        const oldToken = openBound(existing.tokenEnc, deps.encKey, TOKEN_PURPOSE, aad(userId, idem.key, existing.sessionId));
        return { status: existing.statusCode, body: { ...(existing.response as object), url: checkoutUrl(deps.appUrl, oldToken) } as ReturnType<typeof sessionDto>, replayed: true };
      }
    }
    await tx.checkoutSession.create({
      data: {
        id, userId, tokenHash, amountMinor: input.amountMinor, currency: input.currency, externalReference: input.externalReference,
        metadata: input.metadata, presetScenario: input.presetScenario, customerReference: input.customerReference ?? null, status: "open", expiresAt, createdAt, updatedAt: createdAt,
      },
    });
    await writeAudit(tx, { userId, action: "checkout_session.created", targetType: "checkout_session", targetId: id });
    return { status: 201, body, replayed: false };
  }, TX_OPTIONS);
}

export async function getCheckoutSession(db: PrismaClient, userId: string, publicId: string, now: Date): Promise<CheckoutSession> {
  const id = parsePublicId("session", publicId);
  if (!id) throw notFound("Checkout session");
  let s = await db.checkoutSession.findFirst({ where: { id, userId } });
  if (!s) throw notFound("Checkout session");
  if (await needsSettle(db, s, now)) s = (await settleSession(db, userId, id, now)) ?? s;
  return s;
}

export interface Page<T> { items: T[]; hasMore: boolean }

export async function listCheckoutSessions(
  db: PrismaClient, userId: string, now: Date, q: { limit?: number; startingAfter?: string; status?: string; externalReference?: string },
): Promise<Page<CheckoutSession>> {
  const limit = q.limit ?? 10;
  let after: bigint | undefined;
  if (q.startingAfter !== undefined) {
    const id = parsePublicId("session", q.startingAfter);
    const cur = id ? await db.checkoutSession.findFirst({ where: { id, userId }, select: { seq: true } }) : null;
    if (!cur) throw invalidRequest("invalid_cursor", "starting_after does not match a checkout session", "starting_after");
    after = cur.seq;
  }
  await sweepUser(db, userId, now);
  const rows = await db.checkoutSession.findMany({
    where: { userId, ...(q.status ? { status: q.status } : {}), ...(q.externalReference ? { externalReference: q.externalReference } : {}), ...(after !== undefined ? { seq: { lt: after } } : {}) },
    orderBy: { seq: "desc" }, take: limit + 1,
  });
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** Cancels an open session and, in the same transaction, its pending payment. Repeating the call on a cancelled session is a no-op. */
export async function cancelCheckoutSession(db: PrismaClient, userId: string, publicId: string, now: Date): Promise<CheckoutSession> {
  const id = parsePublicId("session", publicId);
  if (!id) throw notFound("Checkout session");
  return db.$transaction(async (tx) => {
    const locked = await lockSession(tx, userId, id);
    if (!locked) throw notFound("Checkout session");
    const s = await settleLocked(tx, locked, now);
    if (s.status === "cancelled") return s;
    if (s.status !== "open") throw new ApiError(409, "conflict_error", "invalid_state_transition", `A ${s.status} checkout session cannot be cancelled`);
    const pending = await tx.transaction.findFirst({ where: { checkoutSessionId: s.id, status: "pending" } });
    if (pending) await transitionPayment(tx, s, pending, "cancelled", "session_cancelled", now);
    await transitionSession(tx, s, "cancelled", now);
    await writeAudit(tx, { userId, action: "checkout_session.cancelled", targetType: "checkout_session", targetId: s.id });
    return (await tx.checkoutSession.findFirstOrThrow({ where: { id: s.id, userId } }));
  }, TX_OPTIONS);
}

export interface DashboardSessionInput { amount: string; currency: string; reference: string | null; scenario: Scenario | null; expiresIn: number | null }
export const DASHBOARD_EXPIRES = { min: EXPIRES_MIN, max: EXPIRES_MAX } as const;

/** Dashboard-created test session: same validation and creation path as the API (no idempotency key). */
export function createDashboardSession(db: PrismaClient, deps: { encKey: string; appUrl: string; now: Date }, userId: string, i: DashboardSessionInput) {
  return createCheckoutSession(
    db, deps, userId,
    { amountMinor: parseMoney(i.amount, i.currency), currency: i.currency, externalReference: i.reference, metadata: {}, expiresInSeconds: i.expiresIn ?? 1800, presetScenario: i.scenario },
    null,
  );
}
