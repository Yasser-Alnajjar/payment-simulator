"use server";

import { z } from "zod";
import { SCENARIOS } from "@sandbox/core";
import { db } from "@/server/db";
import { attemptPaymentByToken } from "@/server/services/payments";
import { cancelCheckoutByToken } from "@/server/services/checkout-public";
import type { ActionResult } from "@/lib/types/common";
import { fail, invalid } from "./utils";

/**
 * Public actions for the hosted checkout. Authorized by the secret checkout token alone (no dashboard session, no API credential).
 * Amount and currency are never inputs: the service reads them from the session. Business rules live in the service layer.
 */
const token = z.string().min(20).max(100);
const payInput = z.object({ token, scenario: z.enum(SCENARIOS).optional(), delaySeconds: z.number().int().optional() });
const cancelInput = z.object({ token });

export async function payAction(input: unknown): Promise<ActionResult<{ status: string }>> {
  const p = payInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const r = await attemptPaymentByToken(db(), { token: p.data.token, scenario: p.data.scenario, delaySeconds: p.data.delaySeconds }, new Date());
    return { ok: true, data: { status: r.payment.status } };
  } catch (e) {
    return fail(e);
  }
}

export async function cancelCheckoutAction(input: unknown): Promise<ActionResult> {
  const p = cancelInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    await cancelCheckoutByToken(db(), p.data.token, new Date());
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}
