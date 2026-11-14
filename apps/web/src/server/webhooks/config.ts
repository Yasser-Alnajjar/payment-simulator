/**
 * Webhook / scheduler configuration, read straight from the environment (kept out of lib/env.ts on purpose).
 *
 *  SCHEDULER_TICK_SECRET           bearer secret for POST /api/scheduler/tick (>= 32 chars). Unset -> the route always answers 404.
 *  SCHEDULER_TICK_SECRET_PREVIOUS  optional, accepted too while rotating.
 *  ALLOW_PRIVATE_WEBHOOK_TARGETS   "true" allows http/localhost/private targets. Honoured ONLY when APP_ENV=development; in any
 *                                  other environment its presence is a configuration error and webhook sending refuses to run.
 */
export const MIN_TICK_SECRET_LENGTH = 32;
export const ENDPOINT_SECRET_PURPOSE = "webhook-endpoint-secret";
export const endpointSecretContext = (userId: string, endpointId: string) => `${userId}|${endpointId}`;

export class WebhookConfigError extends Error {}
export type Env = Record<string, string | undefined>;

export function allowPrivateTargets(env: Env = process.env): boolean {
  const flag = env.ALLOW_PRIVATE_WEBHOOK_TARGETS;
  if (flag === undefined || flag === "" || flag === "false") return false;
  if (flag !== "true") throw new WebhookConfigError("ALLOW_PRIVATE_WEBHOOK_TARGETS must be \"true\" or unset");
  if ((env.APP_ENV ?? "development") !== "development") throw new WebhookConfigError("ALLOW_PRIVATE_WEBHOOK_TARGETS is only allowed when APP_ENV=development");
  // APP_ENV defaults to "development" when unset, so a hosted deployment that forgot it must not be able to open the allowance.
  if (env.VERCEL || env.NODE_ENV === "production") throw new WebhookConfigError("ALLOW_PRIVATE_WEBHOOK_TARGETS is refused on Vercel and in production builds");
  return true;
}

export function tickSecrets(env: Env = process.env): string[] {
  const ok = (s: string | undefined): s is string => typeof s === "string" && s.length >= MIN_TICK_SECRET_LENGTH;
  if (!ok(env.SCHEDULER_TICK_SECRET)) return []; // no valid primary secret: the route is closed
  return ok(env.SCHEDULER_TICK_SECRET_PREVIOUS) ? [env.SCHEDULER_TICK_SECRET, env.SCHEDULER_TICK_SECRET_PREVIOUS] : [env.SCHEDULER_TICK_SECRET];
}
