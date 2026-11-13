"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CUSTOMER_REFERENCE } from "@sandbox/core";
import { db } from "@/server/db";
import { requireUser } from "@/server/session";
import { serverEnv } from "@/lib/env";
import { createPaymentMethod, disablePaymentMethod, removePaymentMethod, setDefaultPaymentMethod } from "@/server/services/payment-methods";
import { createSetupSession } from "@/server/services/setup-sessions";
import type { ActionResult } from "@/lib/types/common";
import { fail, invalid } from "./utils";

/**
 * Dashboard actions for TEST payment methods. Ownership comes from the signed-in session only. Card details are accepted here
 * for the simulator's test cards, validated and reduced in memory by the same service as the API, and never stored, logged or returned.
 */
const customer = z.string().trim().regex(CUSTOMER_REFERENCE, "Customer reference: 1-128 characters of A-Z a-z 0-9 _ . : @ -");
const addInput = z.object({
  customer,
  number: z.string().max(32),
  expMonth: z.number(),
  expYear: z.number(),
  cvc: z.string().max(8),
  name: z.string().max(120).optional(),
  setDefault: z.boolean().optional(),
});
const idInput = z.object({ id: z.string().max(64) });
const setupInput = z.object({ customer, reference: z.string().trim().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/).optional() });

const FIELD: Record<string, string> = { "card.number": "number", "card.exp_month": "expMonth", "card.exp_year": "expYear", "card.cvc": "cvc", "card.name": "name" };

export async function addTestCardAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const p = addInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    const r = await createPaymentMethod(
      db(), { encKey: serverEnv().SECRETS_ENCRYPTION_KEY, now: new Date() }, user.id,
      { customer: p.data.customer, card: { number: p.data.number, exp_month: p.data.expMonth, exp_year: p.data.expYear, cvc: p.data.cvc, name: p.data.name }, setDefault: p.data.setDefault ?? false }, null,
    );
    revalidatePath("/payment-methods");
    return { ok: true, data: { id: r.body.id } };
  } catch (e) {
    const res = fail(e);
    const param = (e as { param?: string }).param;
    if (!res.ok && param && FIELD[param]) return { ok: false, error: res.error, fieldErrors: { [FIELD[param]!]: res.error } };
    return res;
  }
}

async function mutate(input: unknown, fn: (userId: string, id: string) => Promise<unknown>): Promise<ActionResult> {
  const p = idInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    await fn(user.id, p.data.id);
    revalidatePath("/payment-methods");
    revalidatePath(`/payment-methods/${p.data.id}`);
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

export async function setDefaultAction(input: unknown): Promise<ActionResult> { return mutate(input, (u, id) => setDefaultPaymentMethod(db(), u, id, new Date())); }
export async function disableAction(input: unknown): Promise<ActionResult> { return mutate(input, (u, id) => disablePaymentMethod(db(), u, id)); }
export async function removeAction(input: unknown): Promise<ActionResult> { return mutate(input, (u, id) => removePaymentMethod(db(), u, id)); }

/** The hosted setup link contains the secret checkout token and is shown exactly once. */
export async function createSetupLinkAction(input: unknown): Promise<ActionResult<{ id: string; url: string }>> {
  const p = setupInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    const env = serverEnv();
    const r = await createSetupSession(
      db(), { encKey: env.SECRETS_ENCRYPTION_KEY, appUrl: env.APP_URL, now: new Date() }, user.id,
      { customer: p.data.customer, externalReference: p.data.reference ?? null, metadata: {}, expiresInSeconds: 1800, rawBody: {} }, null,
    );
    return { ok: true, data: { id: r.body.id, url: (r.body as { url: string }).url } };
  } catch (e) {
    return fail(e);
  }
}
