import type { PrismaClient } from "@sandbox/db";
import { sweepAll } from "../lifecycle";
import { sweepSetupAll } from "../services/setup-sessions";
import { claimDeliveries, processDelivery, type EngineDeps, type ProcessResult } from "./engine";
import { assertNoEnvProxy } from "./sender";

/**
 * One scheduler tick (called every minute by Supabase Cron through POST /api/scheduler/tick, inside a Vercel function).
 *
 * Timing contract (Vercel Hobby: functions may run up to 300 s; the route sets maxDuration = 60 s):
 *  - work budget 25 s; a new delivery batch is only claimed while at least STOP_CLAIM_MARGIN (15 s: worst-case send = 5 s DNS + 10 s exchange)
 *    remains, so the last batch finishes by ~25 s, far inside the 60 s function limit and the 55 s pg_net timeout;
 *  - scheduler lease 90 s (> maxDuration), so a tick killed by the platform can never block the scheduler for more than 90 s;
 *  - delivery lease 60 s (> the 10 s send limit + recording).
 * Overlap protection: a single-row lease in PostgreSQL (no session advisory locks: the web runtime uses the transaction pooler).
 */
export const TICK = { budgetMs: 25_000, stopClaimMarginMs: 15_000, batchSize: 10, sweepLimit: 100, schedulerLeaseSeconds: 90 } as const;

export interface TickSummary {
  skipped?: "busy";
  swept: { settled: number; failed: number };
  setup_swept: { settled: number; failed: number };
  claimed: number;
  succeeded: number;
  retrying: number;
  failed: number;
  stale: number;
  errors: number;
  duration_ms: number;
}

export interface TickDeps extends EngineDeps {
  budgetMs?: number;
  stopClaimMarginMs?: number;
  /** Tests only: restrict claims to these delivery ids and skip global sweeps. Never set by the route. */
  onlyDeliveryIds?: string[];
  skipSweeps?: boolean;
  leaseSeconds?: number;
  /** Tests only: their own scheduler row ('test-<runId>'), never the production 'tick' row. */
  leaseName?: string;
}

export async function acquireSchedulerLease(db: PrismaClient, seconds: number = TICK.schedulerLeaseSeconds, name = "tick"): Promise<string | null> {
  const rows = await db.$queryRaw<{ lease_token: string }[]>`
    UPDATE scheduler_leases
       SET lease_token = gen_random_uuid(), locked_until = now() + make_interval(secs => ${seconds}), last_started_at = now()
     WHERE name = ${name} AND (locked_until IS NULL OR locked_until < now())
    RETURNING lease_token::text`;
  return rows[0]?.lease_token ?? null;
}

export async function releaseSchedulerLease(db: PrismaClient, token: string, summary: TickSummary, name = "tick"): Promise<void> {
  await db.$executeRaw`
    UPDATE scheduler_leases
       SET lease_token = NULL, locked_until = NULL, last_finished_at = now(), last_summary = ${JSON.stringify(summary)}::jsonb
     WHERE name = ${name} AND lease_token = ${token}::uuid`;
}

export async function runSchedulerTick(db: PrismaClient, deps: TickDeps): Promise<TickSummary> {
  assertNoEnvProxy();
  const started = Date.now();
  const s: TickSummary = { swept: { settled: 0, failed: 0 }, setup_swept: { settled: 0, failed: 0 }, claimed: 0, succeeded: 0, retrying: 0, failed: 0, stale: 0, errors: 0, duration_ms: 0 };
  const leaseName = deps.leaseName ?? "tick";
  const token = await acquireSchedulerLease(db, TICK.schedulerLeaseSeconds, leaseName);
  if (!token) return { ...s, skipped: "busy", duration_ms: Date.now() - started };
  try {
    if (!deps.skipSweeps) {
      // Same functions as lazy settlement on read: row-locked and re-checked, so they cannot double-apply anything.
      s.swept = await sweepAll(db, deps.now(), TICK.sweepLimit);
      s.setup_swept = await sweepSetupAll(db, deps.now(), TICK.sweepLimit);
    }
    const budget = deps.budgetMs ?? TICK.budgetMs;
    const margin = deps.stopClaimMarginMs ?? TICK.stopClaimMarginMs;
    while (Date.now() - started < budget - margin) {
      const batch = await claimDeliveries(db, { limit: TICK.batchSize, now: deps.now(), leaseSeconds: deps.leaseSeconds, onlyIds: deps.onlyDeliveryIds });
      if (batch.length === 0) break;
      s.claimed += batch.length;
      // At most one delivery per endpoint per batch (enforced by the claim), all sent concurrently (batch size 10).
      const results = await Promise.allSettled(batch.map((c) => processDelivery(db, c, deps)));
      for (const r of results) {
        if (r.status === "rejected") { s.errors++; console.error("tick: delivery processing failed", r.reason instanceof Error ? r.reason.name : "unknown"); continue; }
        tally(s, r.value);
      }
    }
  } finally {
    s.duration_ms = Date.now() - started;
    await releaseSchedulerLease(db, token, s, leaseName).catch(() => undefined); // if this fails the lease simply expires after 90 s
  }
  return s;
}

function tally(s: TickSummary, r: ProcessResult) {
  if (r.stale) s.stale++;
  else if (r.status === "succeeded") s.succeeded++;
  else if (r.status === "retrying") s.retrying++;
  else if (r.status === "failed") s.failed++;
}
