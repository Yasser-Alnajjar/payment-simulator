import type { Prisma, PrismaClient } from "@sandbox/db";

type Db = PrismaClient | Prisma.TransactionClient;

/** Callers must never put secrets, emails or IP addresses in metadata (ids and action names only). */
export function writeAudit(
  db: Db,
  e: { userId: string; action: string; targetType?: string; targetId?: string; metadata?: Prisma.InputJsonValue },
) {
  return db.auditLog.create({ data: { ...e, metadata: e.metadata ?? {} } });
}
