/** True for PostgreSQL unique violations (23505) as surfaced by Prisma (P2002), the pg driver or the driver adapter. */
export function isUniqueViolation(e: unknown, constraintName?: string): boolean {
  const seen = new Set<unknown>();
  for (let cur: unknown = e; cur && typeof cur === "object" && !seen.has(cur); ) {
    seen.add(cur);
    const o = cur as { code?: unknown; message?: unknown; cause?: unknown; meta?: { driverAdapterError?: { cause?: { kind?: unknown } } } };
    if (o.code === "P2002" || o.code === "23505") return true;
    if (o.meta?.driverAdapterError?.cause?.kind === "UniqueConstraintViolation") return true;
    if (constraintName && typeof o.message === "string" && o.message.includes(constraintName)) return true;
    cur = o.cause;
  }
  return false;
}
