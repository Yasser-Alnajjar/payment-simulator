import "server-only";
import { serverEnv } from "@/lib/env";
import { db } from "../db";
import type { TickRouteDeps } from "./tick-handler";

export function defaultTickDeps(): TickRouteDeps {
  return { db: db(), encKey: serverEnv().SECRETS_ENCRYPTION_KEY, env: process.env, now: () => new Date() };
}
