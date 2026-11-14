import { createHash, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@sandbox/db";
import { allowPrivateTargets, tickSecrets, WebhookConfigError, type Env } from "./config";
import { runSchedulerTick, type TickDeps } from "./scheduler";

export interface TickRouteDeps {
  db: PrismaClient;
  encKey: string;
  env: Env;
  now: () => Date;
  /** Test seams forwarded to the tick. */
  tick?: Partial<TickDeps>;
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
const empty = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

/** Constant-time check of `Authorization: Bearer <secret>` against every configured secret (current, and previous while rotating). */
export function isAuthorizedTick(authorization: string | null, secrets: readonly string[]): boolean {
  if (secrets.length === 0 || !authorization || authorization.length > 1024) return false;
  const m = /^Bearer ([\x21-\x7e]+)$/.exec(authorization);
  if (!m) return false;
  const presented = digest(m[1]!);
  let ok = false;
  for (const s of secrets) if (timingSafeEqual(presented, digest(s))) ok = true; // no early exit
  return ok;
}

/**
 * POST /api/scheduler/tick. Called every minute by Supabase Cron (pg_net). Not part of the merchant API: no Basic auth, no CORS,
 * no request parameters (the body is ignored), so a leaked secret can only trigger work that would run within a minute anyway.
 * Unauthenticated or unconfigured -> 404 with no body (does not advertise the route).
 */
export async function handleSchedulerTick(req: Request, deps: TickRouteDeps): Promise<Response> {
  if (!isAuthorizedTick(req.headers.get("authorization"), tickSecrets(deps.env))) return empty(404);
  let allowPrivate: boolean;
  try {
    allowPrivate = allowPrivateTargets(deps.env);
  } catch (e) {
    console.error("scheduler tick refused: configuration error", e instanceof WebhookConfigError ? e.message : "unknown");
    return Response.json({ error: "configuration_error" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
  try {
    const summary = await runSchedulerTick(deps.db, { encKey: deps.encKey, allowPrivate, now: deps.now, ...deps.tick });
    return Response.json(summary, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("scheduler tick failed", e instanceof Error ? e.name : "unknown");
    return Response.json({ error: "tick_failed" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
