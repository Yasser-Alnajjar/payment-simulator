import { formatAmount, hashSecret, toPublicId } from "@sandbox/core";
import type { PrismaClient } from "@sandbox/db";
import { notFound } from "../api/errors";
import { needsSettle, settleSession } from "../lifecycle";
import { cancelCheckoutSession } from "./checkout-sessions";

/** What the hosted checkout page may know. No owner id, internal id, token, hash or metadata. */
export interface CheckoutView {
  status: "open" | "completed" | "expired" | "cancelled";
  amount: string;
  currency: string;
  reference: string | null;
  /** Set when the merchant fixed the scenario at session creation; the customer cannot change it. */
  presetScenario: string | null;
  expiresAt: string;
  payment: { status: "pending" | "succeeded" | "failed" | "cancelled"; failureCode: string | null; scenario: string; resolveAt: string | null } | null;
  /** True only when a new attempt would be accepted right now. */
  canPay: boolean;
}

const validShape = (t: unknown): t is string => typeof t === "string" && t.length >= 20 && t.length <= 100 && /^[A-Za-z0-9_-]+$/.test(t);

async function refFor(db: PrismaClient, token: unknown) {
  if (!validShape(token)) return null;
  return db.checkoutSession.findUnique({ where: { tokenHash: hashSecret(token) }, select: { id: true, userId: true } });
}

/** Looks the session up by its secret token, applies anything that is due (expiry, scheduled resolution) and returns the public view. */
export async function getCheckoutView(db: PrismaClient, token: unknown, now: Date): Promise<CheckoutView | null> {
  const ref = await refFor(db, token);
  if (!ref) return null;
  let s = await db.checkoutSession.findFirst({ where: { id: ref.id, userId: ref.userId } });
  if (!s) return null;
  if (await needsSettle(db, s, now)) s = (await settleSession(db, ref.userId, ref.id, now)) ?? s;
  const latest = await db.transaction.findFirst({ where: { checkoutSessionId: s.id, userId: ref.userId }, orderBy: { seq: "desc" } });
  const active = latest !== null && (latest.status === "pending" || latest.status === "succeeded");
  return {
    status: s.status as CheckoutView["status"],
    amount: formatAmount(s.amountMinor, s.currency),
    currency: s.currency,
    reference: s.externalReference,
    presetScenario: s.presetScenario,
    expiresAt: s.expiresAt.toISOString(),
    payment: latest
      ? { status: latest.status as NonNullable<CheckoutView["payment"]>["status"], failureCode: latest.failureCode, scenario: latest.scenario, resolveAt: latest.resolveAt?.toISOString() ?? null }
      : null,
    canPay: s.status === "open" && !active,
  };
}

/** The customer abandons the checkout. Same state machine and transaction as the API cancel; authorized by the secret token only. */
export async function cancelCheckoutByToken(db: PrismaClient, token: unknown, now: Date): Promise<void> {
  const ref = await refFor(db, token);
  if (!ref) throw notFound("Checkout session");
  await cancelCheckoutSession(db, ref.userId, toPublicId("session", ref.id), now);
}
