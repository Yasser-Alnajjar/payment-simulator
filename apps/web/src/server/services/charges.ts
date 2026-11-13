import { chargeOutcome, effectiveStatus, newUuid, parsePublicId, requestFingerprint, type CardBehavior } from "@sandbox/core";
import type { PrismaClient, Transaction } from "@sandbox/db";
import { writeAudit } from "../audit";
import { paymentDto } from "../api/dto";
import { conflict, invalidRequest, notFound } from "../api/errors";
import { API_VERSION, emitEvent, TX_OPTIONS } from "../lifecycle";
import { claimIdempotency, finishIdempotency } from "./api-idempotency";
import { assertCustomer, lockMethod } from "./payment-methods";

export interface ChargeInput {
  paymentMethod: string;
  amountMinor: bigint;
  currency: string;
  customer?: string;
  externalReference: string | null;
  metadata: Record<string, string>;
  /** The request exactly as received (without card data: a charge request has none); used only for the idempotency fingerprint. */
  rawBody: unknown;
}

export interface ChargeResult { status: number; body: ReturnType<typeof paymentDto>; replayed: boolean }

/**
 * Executes and records ONE payment attempt against a saved TEST card. It is not subscription billing: the caller (e.g. Elapsed)
 * owns schedules, retries and dunning. Outcomes are deterministic: they come from the card's stored test behavior.
 *  - disabled, expired, deleted or foreign methods are refused BEFORE anything is recorded (no transaction, no event);
 *  - a decline / insufficient funds / authentication required / processor failure is a recorded `failed` payment (HTTP 201);
 *  - an idempotency key is REQUIRED: the key, the payment and its event are one transaction, so duplicates and concurrent duplicates
 *    produce exactly one payment and one event and the same response.
 * The method row is locked FOR SHARE, so a concurrent disable/remove either completes first (the charge is refused) or waits.
 */
export async function createCharge(
  db: PrismaClient, deps: { now: Date }, userId: string, input: ChargeInput, idem: { key: string },
): Promise<ChargeResult> {
  const methodId = parsePublicId("paymentMethod", input.paymentMethod);
  if (!methodId) throw notFound("Payment method");
  if (input.customer !== undefined) assertCustomer(input.customer);
  const requestHash = requestFingerprint("POST", "/api/v1/payments", API_VERSION, input.rawBody);
  const paymentId = newUuid();
  const now = deps.now;

  return db.$transaction(async (tx): Promise<ChargeResult> => {
    const claimed = await claimIdempotency(tx, userId, "charge.create", { key: idem.key, requestHash }, paymentId);
    if (!claimed.claimed) return { status: claimed.replay.status, body: claimed.replay.response as ChargeResult["body"], replayed: true };

    const m = await lockMethod(tx, userId, methodId, "share"); // owner-scoped: another tenant's id is simply not found
    if (!m) throw notFound("Payment method");
    if (input.customer !== undefined && input.customer !== m.customerReference) throw invalidRequest("customer_mismatch", "The payment method does not belong to this customer", "customer");
    const st = effectiveStatus(m.status, m.expMonth, m.expYear, now);
    if (st === "disabled") throw conflict("payment_method_disabled", "This payment method is disabled and cannot be charged");
    if (st === "expired") throw conflict("payment_method_expired", "This payment method has expired and cannot be charged");

    const outcome = chargeOutcome(m.testBehavior as CardBehavior);
    const row: Transaction = await tx.transaction.create({
      data: {
        id: paymentId, userId, checkoutSessionId: null, amountMinor: input.amountMinor, currency: input.currency, status: outcome.status,
        scenario: outcome.status === "succeeded" ? "success" : "decline", failureCode: outcome.failureCode, createdAt: now, updatedAt: now, resolvedAt: now,
        paymentMethodId: m.id, customerReference: m.customerReference, externalReference: input.externalReference, metadata: input.metadata, cardBrand: m.brand, cardLast4: m.last4,
      },
    });
    const body = paymentDto(row, null);
    await emitEvent(tx, {
      userId, type: `payment.${outcome.status === "succeeded" ? "succeeded" : "failed"}`, subjectId: paymentId, now,
      data: {
        payment_id: body.id, checkout_session_id: null, payment_method: body.payment_method, customer: body.customer, card: body.card,
        external_reference: body.external_reference, amount: body.amount, amount_minor: body.amount_minor, currency: body.currency,
        status: body.status, metadata: body.metadata, failure_code: body.failure_code,
      },
    });
    await writeAudit(tx, { userId, action: "charge.created", targetType: "payment", targetId: paymentId });
    await finishIdempotency(tx, userId, "charge.create", idem.key, 201, body);
    return { status: 201, body, replayed: false };
  }, TX_OPTIONS);
}
