"use server";

import { z } from "zod";
import { SCENARIOS } from "@sandbox/core";
import { db } from "@/server/db";
import { attemptPaymentByToken } from "@/server/services/payments";
import { cancelCheckoutByToken } from "@/server/services/checkout-public";
import { attemptSetupByToken, cancelSetupByToken } from "@/server/services/setup-sessions";
import { serverEnv } from "@/lib/env";
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

/** Hosted SETUP page: add a test card to the session's customer. Same token-only authorization as payAction. */
const cardInput = z.object({ number: z.string().max(32), expMonth: z.number(), expYear: z.number(), cvc: z.string().max(8), name: z.string().max(120).optional() });
const setupInput = z.object({ token, card: cardInput });
const FIELD: Record<string, string> = { "card.number": "number", "card.exp_month": "expMonth", "card.exp_year": "expYear", "card.cvc": "cvc", "card.name": "name" };

export async function setupCardAction(input: unknown): Promise<ActionResult<{ last4: string; brand: string }>> {
  const p = setupInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const c = p.data.card;
    const r = await attemptSetupByToken(db(), { encKey: serverEnv().SECRETS_ENCRYPTION_KEY }, { token: p.data.token, card: { number: c.number, exp_month: c.expMonth, exp_year: c.expYear, cvc: c.cvc, name: c.name } }, new Date());
    return { ok: true, data: { last4: r.paymentMethod.last4, brand: r.paymentMethod.brand } };
  } catch (e) {
    const res = fail(e);
    const param = (e as { param?: string }).param;
    if (!res.ok && param && FIELD[param]) return { ok: false, error: res.error, fieldErrors: { [FIELD[param]!]: res.error } };
    return res;
  }
}

export async function cancelSetupAction(input: unknown): Promise<ActionResult> {
  const p = cancelInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    await cancelSetupByToken(db(), p.data.token, new Date());
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

/** Hosted PAYMENT page with a test card: a saved card of the session's customer, or a new card (optionally saved). The outcome comes from the card. */
const payCardInput = z.object({
  token,
  saved: z.string().max(64).optional(),
  card: cardInput.optional(),
  save: z.boolean().optional(),
});

export async function payWithCardAction(input: unknown): Promise<ActionResult<{ status: string }>> {
  const p = payCardInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  if ((p.data.saved === undefined) === (p.data.card === undefined)) return { ok: false, error: "Choose a saved card or enter a new test card" };
  try {
    const c = p.data.card;
    const r = await attemptPaymentByToken(db(), {
      token: p.data.token, encKey: serverEnv().SECRETS_ENCRYPTION_KEY,
      card: p.data.saved !== undefined
        ? { kind: "saved", paymentMethod: p.data.saved }
        : { kind: "new", save: p.data.save === true, card: { number: c!.number, exp_month: c!.expMonth, exp_year: c!.expYear, cvc: c!.cvc, name: c!.name } },
    }, new Date());
    return { ok: true, data: { status: r.payment.status } };
  } catch (e) {
    const res = fail(e);
    const param = (e as { param?: string }).param;
    if (!res.ok && param && FIELD[param]) return { ok: false, error: res.error, fieldErrors: { [FIELD[param]!]: res.error } };
    return res;
  }
}
