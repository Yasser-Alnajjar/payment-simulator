import {
  ACTIVE_PAYMENT_STATUSES, type ChargeOutcome, canTransitionPayment, canTransitionSession, formatAmount, minorToNumber, newUuid, paymentEventType, planScenario,
  sessionEventType, toPublicId, type PaymentStatus, type Scenario, type SessionStatus,
} from "@sandbox/core";
import type { CheckoutSession, Prisma, PrismaClient, Transaction } from "@sandbox/db";
import { ApiError, conflict, notFound } from "./api/errors";
import { isUniqueViolation } from "./db-errors";

export const API_VERSION = "2026-11-01";
export type Tx = Prisma.TransactionClient;
export const TX_OPTIONS = { timeout: 15_000, maxWait: 15_000 } as const;

/** Row lock on the session. Every mutation takes this first, so attempts, resolution, expiry and cancellation are serialized per session. */
export async function lockSession(tx: Tx, userId: string, id: string): Promise<CheckoutSession | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM checkout_sessions WHERE id = ${id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
  if (rows.length === 0) return null;
  return tx.checkoutSession.findFirst({ where: { id, userId } });
}

export interface EventInput { userId: string; type: string; subjectId: string; data: Record<string, unknown>; now: Date; occurrence?: number }

/** Persists the event in the caller's transaction. The payload text is serialized once here and never regenerated. */
export async function emitEvent(tx: Tx, e: EventInput) {
  const id = newUuid();
  const payload = JSON.stringify({ id: toPublicId("event", id), object: "event", type: e.type, created: e.now.toISOString(), api_version: API_VERSION, data: e.data });
  await tx.event.create({ data: { id, userId: e.userId, type: e.type, subjectId: e.subjectId, payload, occurrence: e.occurrence ?? 0, createdAt: e.now } });
}

const sessionData = (s: CheckoutSession, status: string) => ({
  checkout_session_id: toPublicId("session", s.id),
  external_reference: s.externalReference,
  amount: formatAmount(s.amountMinor, s.currency),
  amount_minor: minorToNumber(s.amountMinor),
  currency: s.currency,
  status,
  metadata: s.metadata,
});

export async function transitionSession(tx: Tx, s: CheckoutSession, to: Exclude<SessionStatus, "open">, now: Date): Promise<void> {
  if (!canTransitionSession(s.status as SessionStatus, to)) throw conflict("invalid_state_transition", `Checkout session cannot move from ${s.status} to ${to}`);
  const r = await tx.checkoutSession.updateMany({ where: { id: s.id, userId: s.userId, status: s.status }, data: { status: to, updatedAt: now } });
  if (r.count !== 1) throw conflict("invalid_state_transition", "Checkout session was changed concurrently");
  await emitEvent(tx, { userId: s.userId, type: sessionEventType(to), subjectId: s.id, data: sessionData(s, to), now });
}

export async function transitionPayment(
  tx: Tx, s: CheckoutSession, p: Transaction, to: Exclude<PaymentStatus, "pending">, failureCode: string | null, now: Date,
): Promise<void> {
  if (!canTransitionPayment(p.status as PaymentStatus, to)) throw conflict("invalid_state_transition", `Payment cannot move from ${p.status} to ${to}`);
  const r = await tx.transaction.updateMany({
    where: { id: p.id, userId: p.userId, status: p.status, version: p.version },
    data: { status: to, version: p.version + 1, updatedAt: now, resolvedAt: now, failureCode },
  });
  if (r.count !== 1) throw conflict("invalid_state_transition", "Payment was changed concurrently");
  await emitEvent(tx, { userId: p.userId, type: paymentEventType(to), subjectId: p.id, data: paymentEventData(s, { ...p, status: to, failureCode }), now });
  if (to === "succeeded") await transitionSession(tx, s, "completed", now);
}

/** Card keys are added only when a card was used, so events of simulated-outcome payments stay byte-identical to before. */
function paymentEventData(s: CheckoutSession, p: Pick<Transaction, "id" | "status" | "failureCode"> & Partial<Pick<Transaction, "paymentMethodId" | "cardBrand" | "cardLast4">>) {
  const card = p.cardBrand && p.cardLast4
    ? { payment_method: p.paymentMethodId ? toPublicId("paymentMethod", p.paymentMethodId) : null, customer: s.customerReference, card: { brand: p.cardBrand, last4: p.cardLast4 } }
    : {};
  return { payment_id: toPublicId("payment", p.id), ...sessionData(s, p.status), failure_code: p.failureCode, ...card };
}

/** A payment made with a TEST card: the outcome comes from the card, never from the browser. */
export interface CardUse { outcome: ChargeOutcome; paymentMethodId: string | null; customerReference: string | null; brand: string; last4: string }

/** Creates a payment for an open session according to the scenario. Emits exactly one payment event, plus the session event when it succeeds. */
export async function createPayment(tx: Tx, s: CheckoutSession, scenario: Scenario, delaySeconds: number, now: Date, card?: CardUse): Promise<Transaction> {
  const plan = card
    ? { initial: card.outcome.status as PaymentStatus, resolveTo: null, resolveAfterSeconds: null, failureCode: card.outcome.failureCode }
    : planScenario(scenario, delaySeconds);
  const id = newUuid();
  const terminal = plan.initial !== "pending";
  const row = await tx.transaction.create({
    data: {
      id, userId: s.userId, checkoutSessionId: s.id, amountMinor: s.amountMinor, currency: s.currency, status: plan.initial, scenario,
      resolveAt: plan.resolveAfterSeconds === null ? null : new Date(now.getTime() + plan.resolveAfterSeconds * 1000),
      resolveTo: plan.resolveTo, failureCode: plan.failureCode, createdAt: now, updatedAt: now, resolvedAt: terminal ? now : null,
      ...(card ? { paymentMethodId: card.paymentMethodId, customerReference: card.customerReference, cardBrand: card.brand, cardLast4: card.last4 } : {}),
    },
  });
  await emitEvent(tx, { userId: s.userId, type: paymentEventType(plan.initial), subjectId: id, data: paymentEventData(s, row), now });
  if (plan.initial === "succeeded") await transitionSession(tx, s, "completed", now);
  return row;
}

export const findActivePayment = (tx: Tx, sessionId: string) =>
  tx.transaction.findFirst({ where: { checkoutSessionId: sessionId, status: { in: [...ACTIVE_PAYMENT_STATUSES] } } });

/**
 * Applies everything that is due for a locked session, in time order, inside the caller's transaction:
 *  1. a scheduled pending resolution whose time is before the session expires;
 *  2. expiry (an open session past `expiresAt` expires and its pending payment is cancelled with it).
 * Returns the fresh session row. Bounded: at most one payment is pending per session, so this does at most three writes.
 */
export async function settleLocked(tx: Tx, session: CheckoutSession, now: Date): Promise<CheckoutSession> {
  let s = session;
  if (s.status !== "open") return s;
  const pending = await tx.transaction.findFirst({ where: { checkoutSessionId: s.id, status: "pending" } });
  if (pending?.resolveAt && pending.resolveTo && pending.resolveAt <= now && pending.resolveAt < s.expiresAt) {
    await transitionPayment(tx, s, pending, pending.resolveTo as "succeeded" | "failed", pending.resolveTo === "failed" ? "declined" : null, now);
    const fresh = await tx.checkoutSession.findFirst({ where: { id: s.id, userId: s.userId } });
    if (fresh) s = fresh;
    if (s.status !== "open") return s;
  }
  if (s.expiresAt <= now) {
    const stillPending = await tx.transaction.findFirst({ where: { checkoutSessionId: s.id, status: "pending" } });
    if (stillPending) await transitionPayment(tx, s, stillPending, "cancelled", stillPending.scenario === "timeout" ? "timeout" : "session_expired", now);
    await transitionSession(tx, s, "expired", now);
    const fresh = await tx.checkoutSession.findFirst({ where: { id: s.id, userId: s.userId } });
    if (fresh) s = fresh;
  }
  return s;
}

/** Lock + settle one session. Returns null when it does not exist for this user. */
export async function settleSession(db: PrismaClient, userId: string, sessionId: string, now: Date): Promise<CheckoutSession | null> {
  return db.$transaction(async (tx) => {
    const s = await lockSession(tx, userId, sessionId);
    return s ? settleLocked(tx, s, now) : null;
  }, TX_OPTIONS);
}

/** True when reading this session would change state (expired, or a scheduled resolution is due). */
export async function needsSettle(db: PrismaClient, s: CheckoutSession, now: Date): Promise<boolean> {
  if (s.status !== "open") return false;
  if (s.expiresAt <= now) return true;
  const due = await db.transaction.count({ where: { checkoutSessionId: s.id, status: "pending", resolveAt: { lte: now } } });
  return due > 0;
}

export const SWEEP_LIMIT = 25;

/** Bounded per-user sweep run at the start of list endpoints. */
export async function sweepUser(db: PrismaClient, userId: string, now: Date, limit = SWEEP_LIMIT): Promise<number> {
  const ids = await dueSessionIds(db, now, limit, userId);
  for (const id of ids) await settleSession(db, userId, id, now);
  return ids.length;
}

/** Global bounded sweep. Exported for the S4 worker; also usable by operators. */
export async function sweepAll(db: PrismaClient, now: Date, limit = 100): Promise<number> {
  const due = await dueSessions(db, now, limit);
  for (const d of due) await settleSession(db, d.userId, d.id, now);
  return due.length;
}

async function dueSessions(db: PrismaClient, now: Date, limit: number, userId?: string): Promise<{ id: string; userId: string }[]> {
  const base = userId ? { userId } : {};
  const expired = await db.checkoutSession.findMany({ where: { ...base, status: "open", expiresAt: { lte: now } }, select: { id: true, userId: true }, orderBy: { expiresAt: "asc" }, take: limit });
  const resolvable = await db.transaction.findMany({ where: { ...base, status: "pending", resolveAt: { lte: now }, checkoutSessionId: { not: null } }, select: { checkoutSessionId: true, userId: true }, orderBy: { resolveAt: "asc" }, take: limit });
  const map = new Map<string, string>();
  for (const e of expired) map.set(e.id, e.userId);
  for (const r of resolvable) if (r.checkoutSessionId) map.set(r.checkoutSessionId, r.userId);
  return [...map].slice(0, limit).map(([id, uid]) => ({ id, userId: uid }));
}
const dueSessionIds = async (db: PrismaClient, now: Date, limit: number, userId: string) => (await dueSessions(db, now, limit, userId)).map((d) => d.id);

/** Maps the database's last-line guard (one active payment per session) to the public conflict. */
export function mapPaymentRace(e: unknown): never {
  if (e instanceof ApiError) throw e;
  if (isUniqueViolation(e)) throw conflict("payment_in_progress", "This checkout session already has a pending or successful payment");
  throw e;
}

export { notFound };
