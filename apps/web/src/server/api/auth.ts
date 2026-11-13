import { createHash } from "node:crypto";
import { verifySecret } from "@sandbox/core";
import { ApiError } from "./errors";
import type { ApiDeps } from "./deps";
import { assertIpNotBlocked, recordAuthFailure, sha } from "./rate-limit";

export interface ApiAuth { userId: string; credentialId: string }

const REALM = 'Basic realm="Payment Sandbox API", charset="UTF-8"';
const WWW = { "www-authenticate": REALM };
/** Compared against when the client id is unknown, so response time does not reveal whether an id exists. */
const DUMMY_HASH = createHash("sha256").update("sandbox-dummy-secret").digest("hex");
const LAST_USED_THROTTLE_MS = 60_000;

const unauthenticated = (code: string, message: string) => new ApiError(401, "authentication_error", code, message, undefined, WWW);

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (fwd || req.headers.get("x-real-ip") || "unknown").slice(0, 64);
}

/** Parses `Authorization: Basic base64(client_id:client_secret)`. Returns null for anything malformed. */
export function parseBasic(header: string | null): { clientId: string; secret: string } | null {
  if (!header || header.length > 600) return null;
  const m = /^Basic +([A-Za-z0-9+/=_-]+)$/i.exec(header);
  if (!m?.[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  if (i <= 0 || i === decoded.length - 1) return null;
  const clientId = decoded.slice(0, i);
  const secret = decoded.slice(i + 1);
  return clientId.length <= 100 && secret.length <= 200 ? { clientId, secret } : null;
}

/**
 * API authentication. Only `Authorization: Basic` with an active API credential authenticates; dashboard cookies are never
 * read here. Revocation and expiry are checked on every request (no caching). Unknown ids, wrong secrets and malformed headers
 * are indistinguishable (same 401, dummy comparison); revoked/expired are reported only after the secret verified.
 */
export async function authenticate(req: Request, deps: ApiDeps): Promise<ApiAuth> {
  const { db, config } = deps;
  const ipHash = sha(`ip:${clientIp(req)}`);
  await assertIpNotBlocked(db, ipHash, config);

  const parsed = parseBasic(req.headers.get("authorization"));
  const cred = parsed ? await db.apiCredential.findUnique({ where: { clientId: parsed.clientId }, select: { id: true, userId: true, clientSecretHash: true, revokedAt: true, expiresAt: true } }) : null;
  const ok = verifySecret(parsed?.secret ?? "", cred?.clientSecretHash ?? DUMMY_HASH);

  if (!parsed || !cred || !ok) {
    const over = await recordAuthFailure(db, { ipHash, clientIdHash: parsed ? sha(`cid:${parsed.clientId}`) : null }, config);
    if (over) throw new ApiError(429, "rate_limit_error", "too_many_failed_attempts", "Too many failed authentication attempts. Retry later.", undefined, { "retry-after": "60" });
    throw unauthenticated("invalid_credentials", "Invalid API credentials");
  }
  const now = deps.now();
  if (cred.revokedAt) throw unauthenticated("credential_revoked", "This API credential has been revoked");
  if (cred.expiresAt && cred.expiresAt <= now) throw unauthenticated("credential_expired", "This API credential has expired");

  // Best effort and throttled to one write per credential per minute; a failure here never fails the request.
  await db.apiCredential
    .updateMany({ where: { id: cred.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_THROTTLE_MS) } }] }, data: { lastUsedAt: now } })
    .catch(() => undefined);
  return { userId: cred.userId, credentialId: cred.id };
}
