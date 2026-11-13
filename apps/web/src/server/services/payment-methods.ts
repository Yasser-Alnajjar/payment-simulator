import {
  CardError, CUSTOMER_REFERENCE, cardFingerprint, effectiveStatus, newUuid, parsePublicId, requestFingerprint, tokenizeTestCard, toPublicId,
  type CardInput, type TestCardToken,
} from "@sandbox/core";
import type { PaymentMethod, Prisma, PrismaClient } from "@sandbox/db";
import { writeAudit } from "../audit";
import { paymentMethodDto } from "../api/dto";
import { ApiError, conflict, invalidRequest, notFound } from "../api/errors";
import { isUniqueViolation } from "../db-errors";
import { API_VERSION, emitEvent, TX_OPTIONS, type Tx } from "../lifecycle";
import { claimIdempotency, finishIdempotency, type IdemInput } from "./api-idempotency";
import type { Page } from "./checkout-sessions";

/**
 * Payment methods (TEST cards). Ownership is `user_id` (the simulator has no workspaces/projects: see arch-plan scope amendment);
 * the customer is an opaque external reference supplied by the integrator.
 *
 * Default-method policy (documented in docs/payment-methods.md):
 *  - at most one default per (owner, customer); the first usable card saved for a customer becomes the default;
 *  - setting a default demotes the previous one in the same transaction (events: payment_method.updated for it);
 *  - disabling or removing the default leaves the customer with NO default (no automatic replacement);
 *  - only an active, non-expired, non-deleted method can be made default.
 * Every default-affecting operation serializes per (owner, customer) with a transaction-level advisory lock, and the partial unique
 * index payment_methods_one_default_per_customer is the final guard.
 */

export const PM_LIMIT_PER_CUSTOMER = 50;

export function cardErrorToApi(e: CardError): ApiError {
  return invalidRequest(e.code, e.message, e.param);
}

export const declinedOnSetup = () => new ApiError(402, "card_error", "card_declined", "The card was declined while being added. It was not saved.", "card.number");
const duplicate = () => conflict("duplicate_payment_method", "This card is already saved for this customer");

/** Serializes everything that can change a customer's default (create, set default, disable, delete). */
export async function lockCustomer(tx: Tx, userId: string, customer: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId + "|" + customer}, 0))`;
}

/** Row lock on one owned, undeleted method; `share` is enough for a charge, mutations take the exclusive lock. */
export async function lockMethod(tx: Tx, userId: string, id: string, mode: "share" | "update"): Promise<PaymentMethod | null> {
  const rows = mode === "update"
    ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payment_methods WHERE id = ${id}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL FOR UPDATE`
    : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payment_methods WHERE id = ${id}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL FOR SHARE`;
  if (rows.length === 0) return null;
  return tx.paymentMethod.findFirst({ where: { id, userId, deletedAt: null } });
}

const eventData = (m: PaymentMethod, now: Date, extra: Record<string, unknown> = {}) => ({ payment_method: paymentMethodDto(m, now), ...extra });

async function emitMethodEvent(tx: Tx, m: PaymentMethod, type: string, now: Date, extra: Record<string, unknown> = {}) {
  await emitEvent(tx, { userId: m.userId, type, subjectId: m.id, data: eventData(m, now, extra), now, occurrence: m.version });
}

export interface NewMethodInput { customer: string; token: TestCardToken; fingerprint: string; setDefault: boolean }

/**
 * Inserts a method in the caller's transaction (used by the API, the dashboard, and the hosted setup/checkout flows).
 * The caller must already hold `lockCustomer`. Returns the new row, or null when the card is already saved (duplicate).
 */
export async function insertMethodLocked(tx: Tx, userId: string, i: NewMethodInput, now: Date): Promise<PaymentMethod | null> {
  const dup = await tx.paymentMethod.findFirst({ where: { userId, customerReference: i.customer, fingerprint: i.fingerprint, deletedAt: null }, select: { id: true } });
  if (dup) return null;
  const count = await tx.paymentMethod.count({ where: { userId, customerReference: i.customer, deletedAt: null } });
  if (count >= PM_LIMIT_PER_CUSTOMER) throw conflict("payment_method_limit_reached", `A customer can have at most ${PM_LIMIT_PER_CUSTOMER} saved test cards`);
  const current = await tx.paymentMethod.findFirst({ where: { userId, customerReference: i.customer, isDefault: true, deletedAt: null } });
  const makeDefault = i.setDefault || !current;
  let previous: PaymentMethod | null = null;
  if (makeDefault && current) previous = await demote(tx, current, now);
  const id = newUuid();
  const row = await tx.paymentMethod.create({
    data: {
      id, userId, customerReference: i.customer, type: "card", brand: i.token.brand, last4: i.token.last4, expMonth: i.token.expMonth, expYear: i.token.expYear,
      cardholderName: i.token.cardholderName, fingerprint: i.fingerprint, testBehavior: i.token.behavior, status: "active", isDefault: makeDefault, version: 1, createdAt: now, updatedAt: now,
    },
  });
  await emitMethodEvent(tx, row, "payment_method.created", now);
  if (makeDefault) await emitMethodEvent(tx, row, "payment_method.default_updated", now, { previous_default: previous ? toPublicId("paymentMethod", previous.id) : null });
  await writeAudit(tx, { userId, action: "payment_method.created", targetType: "payment_method", targetId: id });
  return row;
}

/** Clears the default flag on `m` (version +1) and records the change. */
async function demote(tx: Tx, m: PaymentMethod, now: Date): Promise<PaymentMethod> {
  const next = await tx.paymentMethod.update({ where: { id: m.id }, data: { isDefault: false, version: m.version + 1, updatedAt: now } });
  await emitMethodEvent(tx, next, "payment_method.updated", now, { change: "default_cleared" });
  return next;
}

/** Maps a unique violation from the partial indexes to the public error (the pre-checks above normally catch these first). */
export function mapMethodRace(e: unknown): never {
  if (e instanceof ApiError) throw e;
  if (isUniqueViolation(e, "payment_methods_no_duplicate_card")) throw duplicate();
  if (isUniqueViolation(e)) throw conflict("payment_method_conflict", "The payment method was changed concurrently; retry");
  throw e;
}

export interface CreateMethodInput { customer: string; card: CardInput; setDefault: boolean }

/** Request fingerprint for idempotency: card number replaced by the keyed fingerprint, security code dropped. */
function idemHash(encKey: string, userId: string, i: CreateMethodInput, t: TestCardToken): string {
  return requestFingerprint("POST", "/api/v1/payment-methods", API_VERSION, {
    customer: i.customer, set_default: i.setDefault, card: { fingerprint: cardFingerprint(t.panForFingerprint, userId, encKey), exp_month: t.expMonth, exp_year: t.expYear, name: t.cardholderName },
  });
}

export interface MethodResult { status: number; body: ReturnType<typeof paymentMethodDto>; replayed: boolean }

/**
 * Creates a test payment method from test-card details. The details are validated and reduced in memory (see `tokenizeTestCard`);
 * only safe display fields, a keyed fingerprint and the test behavior reach the database. With an idempotency key the key row and the
 * method are written in one transaction, so concurrent retries create exactly one method and one set of events.
 */
export async function createPaymentMethod(
  db: PrismaClient, deps: { encKey: string; now: Date }, userId: string, input: CreateMethodInput, idem: { key: string } | null,
): Promise<MethodResult> {
  let token: TestCardToken;
  try { token = tokenizeTestCard(input.card, deps.now); } catch (e) { if (e instanceof CardError) throw cardErrorToApi(e); throw e; }
  if (token.behavior === "setup_declined") throw declinedOnSetup();
  const fingerprint = cardFingerprint(token.panForFingerprint, userId, deps.encKey);
  const idemInput: IdemInput | null = idem ? { key: idem.key, requestHash: idemHash(deps.encKey, userId, input, token) } : null;
  const newId = newUuid();

  return db.$transaction(async (tx): Promise<MethodResult> => {
    await lockCustomer(tx, userId, input.customer);
    if (idemInput) {
      const c = await claimIdempotency(tx, userId, "payment_method.create", idemInput, newId);
      if (!c.claimed) return { status: c.replay.status, body: c.replay.response as MethodResult["body"], replayed: true };
    }
    const row = await insertMethodLocked(tx, userId, { customer: input.customer, token, fingerprint, setDefault: input.setDefault }, deps.now);
    if (!row) throw duplicate();
    const body = paymentMethodDto(row, deps.now);
    if (idemInput) await finishIdempotency(tx, userId, "payment_method.create", idemInput.key, 201, body);
    return { status: 201, body, replayed: false };
  }, TX_OPTIONS).catch(mapMethodRace);
}

export async function getPaymentMethod(db: PrismaClient, userId: string, publicId: string): Promise<PaymentMethod> {
  const id = parsePublicId("paymentMethod", publicId);
  if (!id) throw notFound("Payment method");
  const m = await db.paymentMethod.findFirst({ where: { id, userId, deletedAt: null } });
  if (!m) throw notFound("Payment method");
  return m;
}

export function assertCustomer(v: string, param = "customer"): string {
  if (!CUSTOMER_REFERENCE.test(v)) throw invalidRequest("invalid_customer", "customer must be 1-128 characters of A-Z a-z 0-9 _ . : @ -", param);
  return v;
}

export async function getDefaultPaymentMethod(db: PrismaClient, userId: string, customer: string): Promise<PaymentMethod> {
  assertCustomer(customer);
  const m = await db.paymentMethod.findFirst({ where: { userId, customerReference: customer, isDefault: true, deletedAt: null } });
  if (!m) throw new ApiError(404, "invalid_request_error", "no_default_payment_method", "This customer has no default payment method");
  return m;
}

type Where = Prisma.PaymentMethodWhereInput;
function statusWhere(status: string, now: Date): Where {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const past: Where = { OR: [{ expYear: { lt: y } }, { expYear: y, expMonth: { lt: m } }] };
  if (status === "disabled") return { status: "disabled" };
  if (status === "expired") return { status: { not: "disabled" }, ...past };
  return { status: "active", NOT: past };
}

export async function listPaymentMethods(
  db: PrismaClient, userId: string, now: Date, q: { limit?: number; startingAfter?: string; customer?: string; status?: string },
): Promise<Page<PaymentMethod>> {
  const limit = q.limit ?? 10;
  let after: bigint | undefined;
  if (q.startingAfter !== undefined) {
    const id = parsePublicId("paymentMethod", q.startingAfter);
    const cur = id ? await db.paymentMethod.findFirst({ where: { id, userId, deletedAt: null }, select: { seq: true } }) : null;
    if (!cur) throw invalidRequest("invalid_cursor", "starting_after does not match a payment method", "starting_after");
    after = cur.seq;
  }
  if (q.customer !== undefined) assertCustomer(q.customer);
  const rows = await db.paymentMethod.findMany({
    where: { userId, deletedAt: null, ...(q.customer ? { customerReference: q.customer } : {}), ...(q.status ? statusWhere(q.status, now) : {}), ...(after !== undefined ? { seq: { lt: after } } : {}) },
    orderBy: { seq: "desc" }, take: limit + 1,
  });
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** Makes an active, non-expired method the customer's default. Already the default: no change, no event. */
export async function setDefaultPaymentMethod(db: PrismaClient, userId: string, publicId: string, now: Date): Promise<PaymentMethod> {
  const id = parsePublicId("paymentMethod", publicId);
  if (!id) throw notFound("Payment method");
  const probe = await db.paymentMethod.findFirst({ where: { id, userId, deletedAt: null }, select: { customerReference: true } });
  if (!probe) throw notFound("Payment method");
  return db.$transaction(async (tx) => {
    await lockCustomer(tx, userId, probe.customerReference);
    const m = await lockMethod(tx, userId, id, "update");
    if (!m) throw notFound("Payment method");
    const st = effectiveStatus(m.status, m.expMonth, m.expYear, now);
    if (st === "disabled") throw conflict("payment_method_disabled", "A disabled payment method cannot be the default");
    if (st === "expired") throw conflict("payment_method_expired", "An expired payment method cannot be the default");
    if (m.isDefault) return m;
    const current = await tx.paymentMethod.findFirst({ where: { userId, customerReference: m.customerReference, isDefault: true, deletedAt: null } });
    const previous = current ? await demote(tx, current, now) : null; // clear first: the partial unique index allows only one default
    const next = await tx.paymentMethod.update({ where: { id }, data: { isDefault: true, version: m.version + 1, updatedAt: now } });
    await emitMethodEvent(tx, next, "payment_method.default_updated", now, { previous_default: previous ? toPublicId("paymentMethod", previous.id) : null });
    await writeAudit(tx, { userId, action: "payment_method.default_updated", targetType: "payment_method", targetId: id });
    return next;
  }, TX_OPTIONS).catch(mapMethodRace);
}

/** Disables a method (final: it cannot be re-enabled). If it was the default, the customer is left with no default. Repeating is a no-op. */
export async function disablePaymentMethod(db: PrismaClient, userId: string, publicId: string, at?: Date): Promise<PaymentMethod> {
  const id = parsePublicId("paymentMethod", publicId);
  if (!id) throw notFound("Payment method");
  const probe = await db.paymentMethod.findFirst({ where: { id, userId, deletedAt: null }, select: { customerReference: true } });
  if (!probe) throw notFound("Payment method");
  return db.$transaction(async (tx) => {
    const now = at ?? new Date();
    await lockCustomer(tx, userId, probe.customerReference);
    const m = await lockMethod(tx, userId, id, "update");
    if (!m) throw notFound("Payment method");
    if (m.status === "disabled") return m;
    const next = await tx.paymentMethod.update({ where: { id }, data: { status: "disabled", isDefault: false, version: m.version + 1, updatedAt: now } });
    await emitMethodEvent(tx, next, "payment_method.disabled", now, { was_default: m.isDefault });
    await writeAudit(tx, { userId, action: "payment_method.disabled", targetType: "payment_method", targetId: id });
    return next;
  }, TX_OPTIONS);
}

/** Removes (soft-deletes) a method: it disappears from the API, can never be used again, and payment history keeps its card snapshot. */
export async function removePaymentMethod(db: PrismaClient, userId: string, publicId: string, at?: Date): Promise<{ id: string; deleted: true }> {
  const id = parsePublicId("paymentMethod", publicId);
  if (!id) throw notFound("Payment method");
  const probe = await db.paymentMethod.findFirst({ where: { id, userId, deletedAt: null }, select: { customerReference: true } });
  if (!probe) throw notFound("Payment method");
  return db.$transaction(async (tx) => {
    const now = at ?? new Date();
    await lockCustomer(tx, userId, probe.customerReference);
    const m = await lockMethod(tx, userId, id, "update");
    if (!m) throw notFound("Payment method");
    const next = await tx.paymentMethod.update({ where: { id }, data: { deletedAt: now, isDefault: false, version: m.version + 1, updatedAt: now } });
    await emitMethodEvent(tx, next, "payment_method.deleted", now, { was_default: m.isDefault });
    await writeAudit(tx, { userId, action: "payment_method.deleted", targetType: "payment_method", targetId: id });
    return { id: toPublicId("paymentMethod", id), deleted: true as const };
  }, TX_OPTIONS);
}
