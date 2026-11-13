import { CardError, cardFingerprint, chargeOutcome, DEFAULT_PENDING_DELAY_SECONDS, effectiveStatus, hashSecret, isScenario, parsePublicId, tokenizeTestCard, type CardBehavior, type CardInput, type Scenario, type TestCardToken } from "@sandbox/core";
import type { CheckoutSession, PrismaClient, Transaction } from "@sandbox/db";
import { ApiError, conflict, invalidRequest, notFound } from "../api/errors";
import { consumeBucket, sha } from "../api/rate-limit";
import { delaySchema } from "../api/validation";
import { cardErrorToApi, insertMethodLocked, lockCustomer, lockMethod } from "./payment-methods";
import { createPayment, findActivePayment, type CardUse, lockSession, mapPaymentRace, needsSettle, settleLocked, settleSession, sweepUser, transitionPayment, TX_OPTIONS } from "../lifecycle";
import type { Page } from "./checkout-sessions";

/**
 * Abuse limits for the PUBLIC payment attempt. Page loads, status polling, cancel and operator resolution are never counted.
 *  - maxAttemptsPerSession: payment attempts ever created for one session (declined/cancelled retries count, so a customer
 *    can retry a few times but not forever). Enforced under the session row lock, so concurrent requests cannot exceed it.
 *  - perOwnerPerMinute / globalPerMinute: attempt requests per minute across all sessions of one merchant / of the whole app.
 *    The owner is known only from a valid token, so this does not depend on client IP (which is not trustworthy behind
 *    an unknown proxy chain). The owner counter is consumed first: a flooding merchant's traffic cannot eat the global budget.
 *  - unknownTokenPerMinute: requests carrying a well-formed token that matches nothing, kept in their own bucket so
 *    random-token floods cannot exhaust the budget valid customers use.
 * `namespace` prefixes the counter buckets (tests use a run-scoped one so they never touch production counters).
 */
export interface CheckoutLimits { maxAttemptsPerSession: number; perOwnerPerMinute: number; globalPerMinute: number; unknownTokenPerMinute: number; namespace: string }
export const DEFAULT_CHECKOUT_LIMITS: CheckoutLimits = { maxAttemptsPerSession: 10, perOwnerPerMinute: 300, globalPerMinute: 1200, unknownTokenPerMinute: 120, namespace: "checkout-pay" };

const busy = () => new ApiError(429, "rate_limit_error", "too_many_requests", "Too many requests. Please wait a moment and try again.", undefined, { "retry-after": "60" });
export const attemptsExhausted = () => new ApiError(429, "rate_limit_error", "too_many_payment_attempts", "This checkout has reached its maximum number of payment attempts.");

/** How a customer pays with a TEST card on the hosted checkout. The outcome comes from the card (never from the browser). */
export type CardChoice = { kind: "saved"; paymentMethod: string } | { kind: "new"; card: CardInput; save: boolean };

export interface AttemptInput { token: string; scenario?: unknown; delaySeconds?: unknown; card?: CardChoice; encKey?: string }

type Db = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Resolves the card used for a payment inside the session-locked transaction. Returns an ApiError instead of throwing so the transaction commits cleanly. */
async function resolveCardUse(tx: Db, s: CheckoutSession, choice: CardChoice, prepared: { token: TestCardToken; fingerprint: string } | null, now: Date): Promise<{ use: CardUse } | { error: ApiError }> {
  if (choice.kind === "saved") {
    if (!s.customerReference) return { error: invalidRequest("customer_required", "This checkout has no customer, so saved cards are not available", "payment_method") };
    const id = parsePublicId("paymentMethod", choice.paymentMethod);
    const m = id ? await lockMethod(tx, s.userId, id, "share") : null;
    if (!m || m.customerReference !== s.customerReference) return { error: notFound("Payment method") }; // another customer's card looks the same as a missing one
    return useOf(m, now);
  }
  const { token, fingerprint } = prepared!;
  if (!choice.save) return { use: { outcome: chargeOutcome(token.behavior), paymentMethodId: null, customerReference: s.customerReference, brand: token.brand, last4: token.last4 } };
  if (!s.customerReference) return { error: invalidRequest("customer_required", "Saving a card needs a customer on this checkout", "save") };
  await lockCustomer(tx, s.userId, s.customerReference);
  const created = await insertMethodLocked(tx, s.userId, { customer: s.customerReference, token, fingerprint, setDefault: false }, now);
  if (created) return useOf(created, now);
  const existing = await tx.paymentMethod.findFirst({ where: { userId: s.userId, customerReference: s.customerReference, fingerprint, deletedAt: null } });
  return existing ? useOf(existing, now) : { error: conflict("duplicate_payment_method", "This card is already saved for this customer") };
}

function useOf(m: { id: string; status: string; expMonth: number; expYear: number; testBehavior: string; customerReference: string; brand: string; last4: string }, now: Date): { use: CardUse } | { error: ApiError } {
  const st = effectiveStatus(m.status, m.expMonth, m.expYear, now);
  if (st === "disabled") return { error: conflict("payment_method_disabled", "This payment method is disabled and cannot be used") };
  if (st === "expired") return { error: conflict("payment_method_expired", "This payment method has expired and cannot be used") };
  return { use: { outcome: chargeOutcome(m.testBehavior as CardBehavior), paymentMethodId: m.id, customerReference: m.customerReference, brand: m.brand, last4: m.last4 } };
}

/**
 * A customer's payment attempt on the hosted checkout (S3 calls this; S2 exposes it as a service only). Authorized by the secret
 * checkout token, never by an API credential. Amount and currency come from the session, never from the caller.
 * The session row is locked, due expiry/resolution is applied first, and the database's partial unique index is the last guard
 * against a second pending/succeeded payment.
 */
export async function attemptPaymentByToken(db: PrismaClient, input: AttemptInput, now: Date, limits: CheckoutLimits = DEFAULT_CHECKOUT_LIMITS): Promise<{ payment: Transaction; session: CheckoutSession }> {
  if (typeof input.token !== "string" || input.token.length < 20 || input.token.length > 100) throw notFound("Checkout session");
  const ref = await db.checkoutSession.findUnique({ where: { tokenHash: hashSecret(input.token) }, select: { id: true, userId: true } });
  if (!ref) {
    await consumeBucket(db, `${limits.namespace}:unknown`, limits.unknownTokenPerMinute, busy);
    throw notFound("Checkout session");
  }
  await consumeBucket(db, `${limits.namespace}:owner:${sha(ref.userId)}`, limits.perOwnerPerMinute, busy);
  await consumeBucket(db, `${limits.namespace}:all`, limits.globalPerMinute, busy);

  let delay = DEFAULT_PENDING_DELAY_SECONDS;
  if (input.delaySeconds !== undefined) {
    const d = delaySchema.safeParse(input.delaySeconds);
    if (!d.success) throw invalidRequest("invalid_parameter", "delay_seconds must be an integer between 1 and 3600", "delay_seconds");
    delay = d.data;
  }
  if (input.scenario !== undefined && !isScenario(input.scenario)) throw invalidRequest("invalid_parameter", "Unknown scenario", "scenario");
  if (input.card && input.scenario !== undefined) throw invalidRequest("scenario_with_card", "A payment made with a card takes its outcome from the card; do not send a scenario", "scenario");

  // Card details are validated and reduced in memory before any database work; nothing derived from them is logged or returned.
  let prepared: { token: TestCardToken; fingerprint: string } | null = null;
  if (input.card?.kind === "new") {
    if (!input.encKey) throw new Error("encKey is required for card payments");
    let token: TestCardToken;
    try { token = tokenizeTestCard(input.card.card, now); } catch (e) { if (e instanceof CardError) throw cardErrorToApi(e); throw e; }
    prepared = { token, fingerprint: cardFingerprint(token.panForFingerprint, ref.userId, input.encKey) };
  }

  const outcome = await db.$transaction(async (tx) => {
    const locked = await lockSession(tx, ref.userId, ref.id);
    if (!locked) return { error: notFound("Checkout session") };
    const s = await settleLocked(tx, locked, now);
    if (s.status === "expired") return { error: conflict("session_expired", "This checkout session has expired") };
    if (s.status === "cancelled") return { error: conflict("session_cancelled", "This checkout session was cancelled") };
    if (s.status === "completed") return { error: conflict("session_already_paid", "This checkout session is already paid") };
    if (await findActivePayment(tx, s.id)) return { error: conflict("payment_in_progress", "This checkout session already has a pending or successful payment") };
    // Counted under the session row lock taken above: concurrent attempts are serialized, so the limit cannot be exceeded.
    if ((await tx.transaction.count({ where: { checkoutSessionId: s.id } })) >= limits.maxAttemptsPerSession) return { error: attemptsExhausted() };

    if (input.card) {
      if (s.presetScenario) return { error: invalidRequest("scenario_locked", "This session's outcome is fixed by its creator; cards are not available", "payment_method") };
      const r = await resolveCardUse(tx, s, input.card, prepared, now);
      if ("error" in r) return { error: r.error };
      const payment = await createPayment(tx, s, r.use.outcome.status === "succeeded" ? "success" : "decline", delay, now, r.use);
      return { ok: { payment, session: s } };
    }
    let scenario: Scenario;
    if (s.presetScenario) {
      if (input.scenario !== undefined && input.scenario !== s.presetScenario) return { error: invalidRequest("scenario_locked", "This session's scenario is fixed by its creator", "scenario") };
      scenario = s.presetScenario as Scenario;
    } else {
      if (input.scenario === undefined) return { error: invalidRequest("scenario_required", "A scenario must be chosen", "scenario") };
      scenario = input.scenario as Scenario;
    }
    const payment = await createPayment(tx, s, scenario, delay, now);
    return { ok: { payment, session: s } };
  }, TX_OPTIONS).catch(mapPaymentRace);

  if ("error" in outcome && outcome.error) throw outcome.error;
  return (outcome as { ok: { payment: Transaction; session: CheckoutSession } }).ok;
}

/** Operator/dashboard action (used by S3 scenario controls): resolve a pending payment through the same state machine. */
export async function resolvePendingPayment(db: PrismaClient, userId: string, publicId: string, to: "succeeded" | "failed" | "cancelled", now: Date): Promise<Transaction> {
  const id = parsePublicId("payment", publicId);
  if (!id) throw notFound("Payment");
  const p0 = await db.transaction.findFirst({ where: { id, userId }, select: { checkoutSessionId: true } });
  if (!p0) throw notFound("Payment");
  // Saved-card charges have no checkout session and are never pending: they are terminal when created.
  if (!p0.checkoutSessionId) throw new ApiError(409, "conflict_error", "invalid_state_transition", "A saved-card payment is final and cannot change status");
  const sessionId = p0.checkoutSessionId;
  return db.$transaction(async (tx) => {
    const locked = await lockSession(tx, userId, sessionId);
    if (!locked) throw notFound("Payment");
    const s = await settleLocked(tx, locked, now);
    const p = await tx.transaction.findFirstOrThrow({ where: { id, userId } });
    if (p.status !== "pending") throw new ApiError(409, "conflict_error", "invalid_state_transition", `A ${p.status} payment cannot change status`);
    await transitionPayment(tx, s, p, to, to === "failed" ? "declined" : to === "cancelled" ? "payment_cancelled" : null, now);
    return tx.transaction.findFirstOrThrow({ where: { id, userId } });
  }, TX_OPTIONS);
}

export async function getPayment(db: PrismaClient, userId: string, publicId: string, now: Date): Promise<{ payment: Transaction; session: CheckoutSession | null }> {
  const id = parsePublicId("payment", publicId);
  if (!id) throw notFound("Payment");
  let p = await db.transaction.findFirst({ where: { id, userId } });
  if (!p) throw notFound("Payment");
  if (!p.checkoutSessionId) return { payment: p, session: null };
  let s = await db.checkoutSession.findFirstOrThrow({ where: { id: p.checkoutSessionId, userId } });
  if (await needsSettle(db, s, now)) {
    s = (await settleSession(db, userId, s.id, now)) ?? s;
    p = (await db.transaction.findFirst({ where: { id, userId } })) ?? p;
  }
  return { payment: p, session: s };
}

export async function listPayments(
  db: PrismaClient, userId: string, now: Date, q: { limit?: number; startingAfter?: string; status?: string; checkoutSessionId?: string; paymentMethod?: string; customer?: string },
): Promise<Page<{ payment: Transaction; session: CheckoutSession | null }>> {
  const limit = q.limit ?? 10;
  let after: bigint | undefined;
  if (q.startingAfter !== undefined) {
    const id = parsePublicId("payment", q.startingAfter);
    const cur = id ? await db.transaction.findFirst({ where: { id, userId }, select: { seq: true } }) : null;
    if (!cur) throw invalidRequest("invalid_cursor", "starting_after does not match a payment", "starting_after");
    after = cur.seq;
  }
  let sessionFilter: string | undefined;
  if (q.checkoutSessionId !== undefined) {
    sessionFilter = parsePublicId("session", q.checkoutSessionId) ?? undefined;
    if (!sessionFilter) throw invalidRequest("invalid_parameter", "checkout_session_id is not a valid checkout session id", "checkout_session_id");
  }
  let methodFilter: string | undefined;
  if (q.paymentMethod !== undefined) {
    methodFilter = parsePublicId("paymentMethod", q.paymentMethod) ?? undefined;
    if (!methodFilter) throw invalidRequest("invalid_parameter", "payment_method is not a valid payment method id", "payment_method");
  }
  await sweepUser(db, userId, now);
  const rows = await db.transaction.findMany({
    where: {
      userId, ...(q.status ? { status: q.status } : {}), ...(sessionFilter ? { checkoutSessionId: sessionFilter } : {}), ...(after !== undefined ? { seq: { lt: after } } : {}),
      ...(methodFilter ? { paymentMethodId: methodFilter } : {}), ...(q.customer ? { customerReference: q.customer } : {}),
    },
    orderBy: { seq: "desc" }, take: limit + 1, include: { session: true },
  });
  const page = rows.slice(0, limit).map(({ session, ...payment }) => ({ payment: payment as Transaction, session }));
  return { items: page, hasMore: rows.length > limit };
}
