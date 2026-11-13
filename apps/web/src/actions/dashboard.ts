"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { SCENARIOS } from "@sandbox/core";
import { db } from "@/server/db";
import { requireUser } from "@/server/session";
import { serverEnv } from "@/lib/env";
import { cancelCheckoutSession, createDashboardSession, DASHBOARD_EXPIRES } from "@/server/services/checkout-sessions";
import { resolvePendingPayment } from "@/server/services/payments";
import type { ActionResult } from "@/lib/types/common";
import { fail, invalid } from "./utils";

/** Dashboard actions. Ownership comes from the signed-in session only; every mutation goes through the same services as the API. */
const createInput = z.object({
  amount: z.string().trim().max(32),
  currency: z.string().trim().toUpperCase().length(3),
  scenario: z.enum(SCENARIOS).optional(),
  expiresIn: z.number().int().min(DASHBOARD_EXPIRES.min).max(DASHBOARD_EXPIRES.max).optional(),
  reference: z.string().trim().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/, "No control characters").optional(),
});
const sessionIdInput = z.object({ sessionId: z.string().max(64) });
const resolveInput = z.object({ paymentId: z.string().max(64), to: z.enum(["succeeded", "failed", "cancelled"]) });

/** The checkout URL contains the secret token and is shown exactly once, here (only its hash is stored). */
export async function createTestSessionAction(input: unknown): Promise<ActionResult<{ sessionId: string; url: string }>> {
  const p = createInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    const env = serverEnv();
    const r = await createDashboardSession(
      db(), { encKey: env.SECRETS_ENCRYPTION_KEY, appUrl: env.APP_URL, now: new Date() }, user.id,
      { amount: p.data.amount, currency: p.data.currency, reference: p.data.reference ?? null, scenario: p.data.scenario ?? null, expiresIn: p.data.expiresIn ?? null },
    );
    revalidatePath("/sessions");
    revalidatePath("/");
    return { ok: true, data: { sessionId: r.body.id, url: (r.body as { url: string }).url } };
  } catch (e) {
    return fail(e);
  }
}

export async function cancelSessionAction(input: unknown): Promise<ActionResult> {
  const p = sessionIdInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    await cancelCheckoutSession(db(), user.id, p.data.sessionId, new Date());
    revalidatePath("/sessions");
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

/** Operator control for a pending payment (succeed, fail or cancel it) through the state machine. */
export async function resolvePaymentAction(input: unknown): Promise<ActionResult> {
  const p = resolveInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    await resolvePendingPayment(db(), user.id, p.data.paymentId, p.data.to, new Date());
    revalidatePath("/sessions");
    revalidatePath("/payments");
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}
