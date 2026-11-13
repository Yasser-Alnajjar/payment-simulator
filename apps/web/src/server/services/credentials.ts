import { encryptSecret, generateCredentials, secretHint } from "@sandbox/core";
import type { ApiCredential, PrismaClient } from "@sandbox/db";
import { writeAudit } from "../audit";
import { AppError } from "../errors";
import { isUniqueViolation as isUniqueViolationOn } from "../db-errors";

/** Generous interactive-transaction limits: the hosted database is across a network and the default 5 s is easy to exceed under load. */
const TX_OPTIONS = { timeout: 15_000, maxWait: 15_000 } as const;
import type { CredentialView, IssuedCredential } from "@/lib/types/credential";

/** Columns that are safe to read. The secret hash and encrypted webhook secret are never selected by read paths. */
const SAFE_SELECT = { id: true, clientId: true, clientSecretHint: true, createdAt: true, lastUsedAt: true, revokedAt: true } as const;
type SafeRow = Pick<ApiCredential, keyof typeof SAFE_SELECT>;

const HISTORY_LIMIT = 20;
const ACTIVE_CONSTRAINT = "api_credentials_one_active_per_user";

export function toCredentialView(c: SafeRow): CredentialView {
  return {
    id: c.id,
    clientId: c.clientId,
    clientSecretHint: c.clientSecretHint,
    status: c.revokedAt ? "revoked" : "active",
    createdAt: c.createdAt.toISOString(),
    lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    revokedAt: c.revokedAt?.toISOString() ?? null,
  };
}

export const isUniqueViolation = (e: unknown): boolean => isUniqueViolationOn(e, ACTIVE_CONSTRAINT);

function issue(userId: string, encKey: string) {
  const g = generateCredentials();
  return {
    g,
    data: {
      userId,
      clientId: g.clientId,
      clientSecretHash: g.clientSecretHash,
      clientSecretHint: secretHint(g.clientSecret),
      webhookSecretEnc: encryptSecret(g.webhookSecret, encKey),
    },
  };
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // The partial unique index is the final guard; surface it as a normal conflict.
    if (isUniqueViolation(e)) throw new AppError("conflict", "You already have active credentials");
    throw e;
  }
}

export function createCredential(db: PrismaClient, userId: string, encKey: string): Promise<IssuedCredential> {
  return guarded(() =>
    db.$transaction(async (tx) => {
      const { g, data } = issue(userId, encKey);
      const row = await tx.apiCredential.create({ data, select: SAFE_SELECT });
      await writeAudit(tx, { userId, action: "credential.created", targetType: "api_credential", targetId: row.id });
      return { credential: toCredentialView(row), clientSecret: g.clientSecret, webhookSecret: g.webhookSecret };
    }, TX_OPTIONS),
  );
}

/** Rotation: revoke the caller's active credential and issue a replacement, atomically. */
export function rotateCredential(db: PrismaClient, userId: string, credentialId: string, encKey: string): Promise<IssuedCredential> {
  return guarded(() =>
    db.$transaction(async (tx) => {
      const revoked = await tx.apiCredential.updateMany({
        where: { id: credentialId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count !== 1) throw new AppError("not_found", "Credential not found or already revoked");
      const { g, data } = issue(userId, encKey);
      const row = await tx.apiCredential.create({ data, select: SAFE_SELECT });
      await writeAudit(tx, { userId, action: "credential.rotated", targetType: "api_credential", targetId: row.id, metadata: { replaced: credentialId } });
      return { credential: toCredentialView(row), clientSecret: g.clientSecret, webhookSecret: g.webhookSecret };
    }, TX_OPTIONS),
  );
}

export async function revokeCredential(db: PrismaClient, userId: string, credentialId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const res = await tx.apiCredential.updateMany({ where: { id: credentialId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count !== 1) throw new AppError("not_found", "Credential not found or already revoked");
    await writeAudit(tx, { userId, action: "credential.revoked", targetType: "api_credential", targetId: credentialId });
  }, TX_OPTIONS);
}

export async function listCredentials(db: PrismaClient, userId: string): Promise<CredentialView[]> {
  const rows = await db.apiCredential.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: HISTORY_LIMIT + 1, select: SAFE_SELECT });
  return rows.map(toCredentialView);
}
