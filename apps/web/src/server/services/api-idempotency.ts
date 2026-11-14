import type { Tx } from "../lifecycle";
import { ApiError } from "../api/errors";

export const API_IDEMPOTENCY_TTL_HOURS = 24;
export type IdemScope = "payment_method.create" | "setup_session.create" | "charge.create" | "webhook_endpoint.create";

export interface IdemInput { key: string; requestHash: string }
export interface Replay { status: number; response: unknown; tokenEnc: string | null; resourceId: string }

/**
 * Claims an idempotency key INSIDE the caller's transaction with INSERT .. ON CONFLICT DO NOTHING. A concurrent request with the
 * same key blocks on the unique index until this transaction ends, then sees the stored result. The response is filled in by
 * `finishIdempotency` in the same transaction, so a stored key always has its response and a rolled-back request leaves no key.
 * The request hash never contains card data (callers hash a copy where the number is replaced by its keyed fingerprint and the
 * security code is dropped).
 */
export async function claimIdempotency(tx: Tx, userId: string, scope: IdemScope, idem: IdemInput, resourceId: string, tokenEnc: string | null = null): Promise<{ claimed: true } | { claimed: false; replay: Replay }> {
  await tx.$executeRaw`DELETE FROM api_idempotency_keys WHERE user_id = ${userId}::uuid AND scope = ${scope} AND key = ${idem.key} AND created_at < now() - make_interval(hours => ${API_IDEMPOTENCY_TTL_HOURS})`;
  const n = await tx.$executeRaw`
    INSERT INTO api_idempotency_keys (user_id, scope, key, request_hash, status_code, response, token_enc, resource_id)
    VALUES (${userId}::uuid, ${scope}, ${idem.key}, ${idem.requestHash}, 0, '{}'::jsonb, ${tokenEnc}, ${resourceId}::uuid)
    ON CONFLICT (user_id, scope, key) DO NOTHING`;
  if (n === 1) return { claimed: true };
  const existing = await tx.apiIdempotencyKey.findUnique({ where: { userId_scope_key: { userId, scope, key: idem.key } } });
  if (!existing) throw new ApiError(409, "idempotency_error", "idempotency_key_in_progress", "A request with this idempotency key is still being processed; retry shortly");
  if (existing.requestHash !== idem.requestHash) throw new ApiError(422, "idempotency_error", "idempotency_key_reused", "This idempotency key was already used with a different request");
  return { claimed: false, replay: { status: existing.statusCode, response: existing.response, tokenEnc: existing.tokenEnc, resourceId: existing.resourceId } };
}

export async function finishIdempotency(tx: Tx, userId: string, scope: IdemScope, key: string, status: number, response: unknown): Promise<void> {
  await tx.$executeRaw`UPDATE api_idempotency_keys SET status_code = ${status}, response = ${JSON.stringify(response)}::jsonb WHERE user_id = ${userId}::uuid AND scope = ${scope} AND key = ${key}`;
}

export const IDEM_KEY = /^[A-Za-z0-9_.:-]{1,255}$/;
