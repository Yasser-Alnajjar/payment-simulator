/** Pure safety helpers for the hosted-database test harness (rule R-DB-1). Unit-tested; no I/O. */
import { EXPECTED_PROJECT_REF } from "@sandbox/db";

export const HOSTED_TEST_FLAG = "hosted-s2-2026-11-13";
export const TEST_EMAIL_DOMAIN = "sbx-test.invalid";
export const MAX_TEST_USERS_PER_RUN = 200;
export const RUN_ID_PATTERN = /^[0-9a-f]{12}$/;

export const testEmail = (runId: string, n: number) => `sbx-test-${runId}-${n}@${TEST_EMAIL_DOMAIN}`;
export const testEmailPattern = (runId: string) => `sbx-test-${runId}-%@${TEST_EMAIL_DOMAIN}`;
export const isTestEmailOfRun = (email: string, runId: string) => new RegExp(`^sbx-test-${runId}-[0-9]{1,3}@sbx-test\\.invalid$`).test(email);

/**
 * Decides whether a hosted write run is explicitly requested. An environment variable alone is never sufficient authorization:
 * the live database identity is verified separately before any write (see harness.ts and verifyHostedIdentity).
 */
export function resolveTarget(env: Record<string, string | undefined>): "hosted" {
  if (env.TEST_DATABASE_URL !== undefined) throw new Error("TEST_DATABASE_URL is no longer supported: tests run only against the Hosted Supabase database (rule R-DB-1)");
  if (env.SANDBOX_TEST_TARGET !== HOSTED_TEST_FLAG) throw new Error("SANDBOX_TEST_TARGET is not set to the required value; refusing to run write tests");
  if (env.SANDBOX_TEST_EXPECTED_REF !== EXPECTED_PROJECT_REF) throw new Error("SANDBOX_TEST_EXPECTED_REF must be declared and match the project this repository targets");
  return "hosted";
}

/** Rejects statements that the harness never needs: DDL, grants, and DELETE/UPDATE without a WHERE clause. */
export function assertSafeSql(text: string): void {
  const t = text.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (/\b(drop|truncate)\b/i.test(t)) throw new Error("Harness refuses DROP/TRUNCATE");
  if (/\b(alter|create)\s+(table|schema|database|role|index|function|trigger|extension)\b/i.test(t) || /\b(grant|revoke)\b/i.test(t)) throw new Error("Harness refuses DDL and privilege changes");
  const mutates = /\bdelete\s+from\b/i.test(t) || /\bupdate\s+[\w."]+\s+set\b/i.test(t);
  if (mutates && (!/\bwhere\b/i.test(t) || /\bwhere\s+(true|1\s*=\s*1)\b/i.test(t))) throw new Error("Harness refuses DELETE/UPDATE without a restrictive WHERE clause");
}
