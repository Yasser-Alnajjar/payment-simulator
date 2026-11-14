"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { FAILURE_DELAY_MAX, FAILURE_DELAY_MIN, FAILURE_MODES, toPublicId, WEBHOOK_MAX_ATTEMPTS_MAX, WEBHOOK_MAX_ATTEMPTS_MIN } from "@sandbox/core";
import { db } from "@/server/db";
import { requireUser } from "@/server/session";
import { serverEnv } from "@/lib/env";
import { allowPrivateTargets } from "@/server/webhooks/config";
import {
  createWebhookEndpoint, deleteWebhookEndpoint, retryWebhookDelivery, rotateWebhookSecret, sendTestEvent, updateWebhookEndpoint,
} from "@/server/services/webhooks";
import type { ActionResult } from "@/lib/types/common";
import type { CreatedEndpoint } from "@/lib/types/webhook";
import { fail, invalid } from "./utils";

/**
 * Dashboard actions for webhook endpoints and deliveries. Ownership comes from the signed-in session only; the same services as the
 * API do all validation (URL/SSRF rules, event list, failure-simulation shape). Secrets are returned once and never logged.
 */
const idInput = z.object({ id: z.string().max(64) });
const createInput = z.object({
  url: z.string().trim().min(1).max(2048),
  description: z.string().trim().max(500).optional(),
  events: z.array(z.string().max(64)).min(1).max(32),
});
const updateInput = z.object({
  id: z.string().max(64),
  status: z.enum(["enabled", "disabled"]).optional(),
  url: z.string().trim().min(1).max(2048).optional(),
  events: z.array(z.string().max(64)).min(1).max(32).optional(),
  maxAttempts: z.number().int().min(WEBHOOK_MAX_ATTEMPTS_MIN).max(WEBHOOK_MAX_ATTEMPTS_MAX).optional(),
  failureMode: z.enum(FAILURE_MODES).optional(),
  failureModeRemaining: z.number().int().min(1).max(100).nullable().optional(),
  failureDelaySeconds: z.number().int().min(FAILURE_DELAY_MIN).max(FAILURE_DELAY_MAX).nullable().optional(),
});

const strict = () => { try { return allowPrivateTargets(); } catch { return false; } };
const deps = () => ({ encKey: serverEnv().SECRETS_ENCRYPTION_KEY, now: new Date(), allowPrivate: strict() });
const refresh = (endpointId?: string) => { revalidatePath("/webhooks"); if (endpointId) revalidatePath(`/webhooks/${endpointId}`); };

export async function createEndpointAction(input: unknown): Promise<ActionResult<CreatedEndpoint>> {
  const p = createInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    const r = await createWebhookEndpoint(db(), deps(), user.id, { url: p.data.url, description: p.data.description || null, enabledEvents: p.data.events, rawBody: {} }, null);
    refresh();
    return { ok: true, data: { id: toPublicId("webhookEndpoint", r.endpoint.id), secret: r.secret } };
  } catch (e) {
    return fail(e);
  }
}

export async function updateEndpointAction(input: unknown): Promise<ActionResult> {
  const p = updateInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    const d = p.data;
    await updateWebhookEndpoint(db(), deps(), user.id, d.id, {
      status: d.status, url: d.url, enabledEvents: d.events, maxAttempts: d.maxAttempts,
      failureMode: d.failureMode, failureModeRemaining: d.failureModeRemaining, failureDelaySeconds: d.failureDelaySeconds,
    });
    refresh(d.id);
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteEndpointAction(input: unknown): Promise<ActionResult> {
  const p = idInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    await deleteWebhookEndpoint(db(), user.id, p.data.id, new Date());
    refresh(p.data.id);
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

export async function rotateSecretAction(input: unknown): Promise<ActionResult<{ secret: string }>> {
  const p = idInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    const r = await rotateWebhookSecret(db(), deps(), user.id, p.data.id);
    refresh(p.data.id);
    return { ok: true, data: { secret: r.secret } };
  } catch (e) {
    return fail(e);
  }
}

export async function sendTestAction(input: unknown): Promise<ActionResult> {
  const p = idInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    await sendTestEvent(db(), user.id, p.data.id, new Date());
    refresh(p.data.id);
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}

export async function retryDeliveryAction(input: unknown): Promise<ActionResult> {
  const p = idInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    await retryWebhookDelivery(db(), user.id, p.data.id, new Date());
    revalidatePath(`/webhooks/deliveries/${p.data.id}`);
    refresh();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}
