import "server-only";
import { serverEnv } from "@/lib/env";
import { db } from "../db";
import { DEFAULT_API_CONFIG, type ApiDeps } from "./deps";

export function defaultDeps(): ApiDeps {
  const env = serverEnv();
  return { db: db(), encKey: env.SECRETS_ENCRYPTION_KEY, appUrl: env.APP_URL, now: () => new Date(), config: DEFAULT_API_CONFIG };
}
