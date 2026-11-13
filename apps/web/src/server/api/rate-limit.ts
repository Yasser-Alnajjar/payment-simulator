import { createHash } from "node:crypto";
import type { PrismaClient } from "@sandbox/db";
import { ApiError } from "./errors";
import type { ApiConfig } from "./deps";

const WINDOW_SECONDS = 60;
export const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export interface RateInfo { limit: number; remaining: number; resetEpoch: number }

const retryAfter = (windowStart: Date): number => Math.min(WINDOW_SECONDS, Math.max(1, Math.ceil((windowStart.getTime() + WINDOW_SECONDS * 1000 - Date.now()) / 1000)));

/** Fixed one-minute window per user in Postgres (database clock). One upsert per request. */
export async function consumeUserRateLimit(db: PrismaClient, userId: string, limit: number): Promise<RateInfo> {
  const rows = await db.$queryRaw<{ count: number; window_start: Date }[]>`
    INSERT INTO api_rate_limits (user_id, window_start, count)
    VALUES (${userId}::uuid, date_trunc('minute', now()), 1)
    ON CONFLICT (user_id, window_start) DO UPDATE SET count = api_rate_limits.count + 1
    RETURNING count, window_start`;
  const row = rows[0]!;
  const info: RateInfo = { limit, remaining: Math.max(0, limit - row.count), resetEpoch: Math.floor(row.window_start.getTime() / 1000) + WINDOW_SECONDS };
  if (row.count === 1) {
    // Housekeeping scoped to this user: drop their windows older than an hour.
    await db.$executeRaw`DELETE FROM api_rate_limits WHERE user_id = ${userId}::uuid AND window_start < now() - interval '1 hour'`;
  }
  if (row.count > limit) {
    throw new ApiError(429, "rate_limit_error", "rate_limited", "Too many requests. Slow down and retry after the indicated time.", undefined, {
      "retry-after": String(retryAfter(row.window_start)), "x-ratelimit-limit": String(limit), "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(info.resetEpoch),
    });
  }
  return info;
}

export const rateHeaders = (i: RateInfo): Record<string, string> => ({ "x-ratelimit-limit": String(i.limit), "x-ratelimit-remaining": String(i.remaining), "x-ratelimit-reset": String(i.resetEpoch) });

const tooMany = () => new ApiError(429, "rate_limit_error", "too_many_failed_attempts", "Too many failed authentication attempts. Retry later.", undefined, { "retry-after": "60" });

export interface FailureKeys { ip: string; clientId: string | null }

/** Cheap pre-check before any credential lookup: an address that already failed too often is refused. */
export async function assertIpNotBlocked(db: PrismaClient, ipHash: string, cfg: ApiConfig): Promise<void> {
  const rows = await db.$queryRaw<{ count: number }[]>`
    SELECT count FROM auth_failure_windows WHERE scope = 'ip' AND bucket = ${ipHash} AND window_start = date_trunc('minute', now())`;
  if ((rows[0]?.count ?? 0) >= cfg.authFailureLimits.ip) throw tooMany();
}

/** Records a failed authentication and returns 429 instead of 401 once a bucket is over its limit (no further oracle for the attacker). */
export async function recordAuthFailure(db: PrismaClient, keys: { ipHash: string; clientIdHash: string | null }, cfg: ApiConfig): Promise<boolean> {
  const buckets: [string, string, number][] = [["ip", keys.ipHash, cfg.authFailureLimits.ip], ["global", "all", cfg.authFailureLimits.global]];
  if (keys.clientIdHash) buckets.push(["client_id", keys.clientIdHash, cfg.authFailureLimits.clientId]);
  let over = false;
  for (const [scope, bucket, max] of buckets) {
    const rows = await db.$queryRaw<{ count: number }[]>`
      INSERT INTO auth_failure_windows (scope, bucket, window_start, count) VALUES (${scope}, ${bucket}, date_trunc('minute', now()), 1)
      ON CONFLICT (scope, bucket, window_start) DO UPDATE SET count = auth_failure_windows.count + 1
      RETURNING count`;
    if ((rows[0]?.count ?? 0) > max) over = true;
  }
  if (Math.random() < 0.05) await db.$executeRaw`DELETE FROM auth_failure_windows WHERE window_start < now() - interval '1 hour'`;
  return over;
}

/**
 * One atomic fixed-window counter (single upsert on the database clock, so concurrent callers cannot read-then-increment past the limit).
 * Reuses `auth_failure_windows`, whose buckets are free-form hashes/labels; callers use a distinct bucket prefix per purpose.
 * Throws `onLimit()` once the count in the current minute exceeds `limit`. The attempt that crosses the limit is the one rejected.
 */
export async function consumeBucket(db: PrismaClient, bucket: string, limit: number, onLimit: () => ApiError): Promise<void> {
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO auth_failure_windows (scope, bucket, window_start, count) VALUES ('global', ${bucket}, date_trunc('minute', now()), 1)
    ON CONFLICT (scope, bucket, window_start) DO UPDATE SET count = auth_failure_windows.count + 1
    RETURNING count`;
  if (Math.random() < 0.02) await db.$executeRaw`DELETE FROM auth_failure_windows WHERE window_start < now() - interval '1 hour'`;
  if ((rows[0]?.count ?? 0) > limit) throw onLimit();
}
