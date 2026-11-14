import "server-only";
import { serverEnv } from "@/lib/env";
import { db } from "../db";
import { allowPrivateTargets } from "../webhooks/config";
import { DEFAULT_API_CONFIG, type ApiDeps } from "./deps";

/** A misconfigured allowance must never loosen validation: it falls back to strict (the scheduler tick refuses to run instead). */
function strictUnlessDevelopment(): boolean {
  try { return allowPrivateTargets(); } catch { return false; }
}

export function defaultDeps(): ApiDeps {
  const env = serverEnv();
  return { db: db(), encKey: env.SECRETS_ENCRYPTION_KEY, appUrl: env.APP_URL, now: () => new Date(), config: DEFAULT_API_CONFIG, allowPrivateWebhookTargets: strictUnlessDevelopment() };
}
