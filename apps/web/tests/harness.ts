import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { createPrismaClient } from "@sandbox/db";

/**
 * Real-Postgres harness. Two mutually exclusive modes:
 *
 * 1. DISPOSABLE (default): TEST_DATABASE_URL. Refuses the primary Supabase project outright and any Supabase host
 *    unless ALLOW_SUPABASE_TEST_DB=1. Applies the real migration files into a throwaway schema `sbx_test_<random>`
 *    and drops only that schema (plus a stub `auth` schema, only if this run created it).
 *
 * 2. HOSTED DEV (explicit, narrowly scoped): only when SANDBOX_TEST_TARGET equals HOSTED_DEV_FLAG exactly.
 *    Runs against the already-migrated `public` schema of the dev project via DIRECT_URL. Creates no schemas and
 *    drops nothing. Safeguards: aborts unless api_credentials is empty and audit_logs holds exactly SANDBOX_TEST_EXPECT_AUDIT_ROWS rows (default 0), records the existing
 *    auth.users ids + stable fingerprints and verifies at the end that they are unchanged, deletes ONLY the test
 *    users it created. Audit rows written by tests are immutable and remain (accepted for this dev database).
 *
 * Anything else, including a bare TEST_DATABASE_URL pointing at the primary project, is refused.
 */
export const TEST_DB_URL = process.env.TEST_DATABASE_URL;
export const HOSTED_DEV_FLAG = "hosted-dev-s1-2026-11-13";
const PRIMARY_REF = "yxyhgelnenqeulzxukrc";

export const HOSTED_DEV_ENABLED = process.env.SANDBOX_TEST_TARGET === HOSTED_DEV_FLAG;
export const DB_TESTS_ENABLED = !!TEST_DB_URL || HOSTED_DEV_ENABLED;

export function assertDisposable(url: string, env: Record<string, string | undefined> = process.env): void {
  if (url.includes(PRIMARY_REF)) throw new Error("Refusing to run tests against the primary Supabase project");
  const host = new URL(url).hostname;
  if (/supabase\.(co|com)$/i.test(host) && env.ALLOW_SUPABASE_TEST_DB !== "1") {
    throw new Error("Refusing a Supabase host for tests unless ALLOW_SUPABASE_TEST_DB=1 (use a dedicated test-only project)");
  }
}

/** Pure decision function so the default protection is unit-tested. */
export function resolveTarget(env: Record<string, string | undefined>): "disposable" | "hosted-dev" {
  if (env.SANDBOX_TEST_TARGET !== undefined) {
    if (env.SANDBOX_TEST_TARGET !== HOSTED_DEV_FLAG) throw new Error("Unrecognised SANDBOX_TEST_TARGET; refusing to run");
    if (env.TEST_DATABASE_URL) throw new Error("Set either TEST_DATABASE_URL or SANDBOX_TEST_TARGET, not both");
    return "hosted-dev";
  }
  if (!env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL not set");
  assertDisposable(env.TEST_DATABASE_URL, env);
  return "disposable";
}

type Harness = {
  prisma: ReturnType<typeof createPrismaClient>;
  schema: string;
  sql: (text: string, params?: unknown[]) => Promise<pg.QueryResult>;
  user: () => Promise<{ id: string }>;
  deleteAuthUser: (id: string) => Promise<void>;
  close: () => Promise<void>;
};

export async function createTestDb(): Promise<Harness> {
  return resolveTarget(process.env) === "hosted-dev" ? createHostedDevDb() : createDisposableDb();
}

async function createDisposableDb(): Promise<Harness> {
  const url = process.env.TEST_DATABASE_URL!;
  const schema = `sbx_test_${randomBytes(6).toString("hex")}`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const hadAuth = (await client.query("select to_regclass('auth.users') as t")).rows[0].t !== null;
  if (!hadAuth) await client.query("CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE auth.users (id uuid PRIMARY KEY)");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  const migDir = path.resolve(__dirname, "../../../packages/db/prisma/migrations");
  for (const d of readdirSync(migDir).filter((n) => /^\d/.test(n)).sort()) {
    await client.query(readFileSync(path.join(migDir, d, "migration.sql"), "utf8"));
  }
  const prisma = createPrismaClient(url, schema);
  return {
    prisma,
    schema,
    sql: (text, params = []) => client.query(text, params),
    async user() {
      const id = randomUUID();
      await client.query("INSERT INTO auth.users (id) VALUES ($1)", [id]);
      return { id };
    },
    async deleteAuthUser(id) {
      await client.query("DELETE FROM auth.users WHERE id = $1", [id]);
    },
    async close() {
      await prisma.$disconnect();
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      if (!hadAuth) await client.query("DROP SCHEMA auth CASCADE");
      await client.end();
    },
  };
}

const STABLE_SQL = "select id::text as id, md5(concat_ws('|', id, email, created_at, encrypted_password, email_confirmed_at, raw_app_meta_data)) as fp from auth.users order by id";

async function createHostedDevDb(): Promise<Harness> {
  config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set");
  if (new URL(url).port !== "5432") throw new Error("Hosted dev tests must use the session pooler / direct connection (port 5432)");

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const present = (await client.query("select to_regclass('public.api_credentials') a, to_regclass('public.audit_logs') b")).rows[0];
  if (!present.a || !present.b) throw new Error("S1 migration is not applied; refusing to run");
  // Immutable audit rows from earlier test runs are expected; the operator states the exact number (default 0).
  const expected: Record<string, number> = { api_credentials: 0, audit_logs: Number(process.env.SANDBOX_TEST_EXPECT_AUDIT_ROWS ?? 0) };
  for (const [t, want] of Object.entries(expected)) {
    const n = (await client.query(`select count(*)::int n from public.${t}`)).rows[0].n as number;
    if (n !== want) throw new Error(`Refusing to run: public.${t} contains ${n} row(s), expected ${want}`);
  }
  const baseline = (await client.query(STABLE_SQL)).rows as { id: string; fp: string }[];
  const created: string[] = [];
  const prisma = createPrismaClient(url);

  return {
    prisma,
    schema: "public",
    sql: (text, params = []) => client.query(text, params),
    async user() {
      const id = randomUUID();
      await client.query("INSERT INTO auth.users (id) VALUES ($1)", [id]);
      created.push(id);
      return { id };
    },
    async deleteAuthUser(id) {
      if (!created.includes(id)) throw new Error("Refusing to delete an auth user this run did not create");
      await client.query("DELETE FROM auth.users WHERE id = $1", [id]);
    },
    async close() {
      await prisma.$disconnect();
      // Delete ONLY users created by this run (their credentials cascade). Audit rows are immutable and stay.
      if (created.length) await client.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [created]);
      const after = (await client.query(STABLE_SQL)).rows as { id: string; fp: string }[];
      await client.end();
      const same = JSON.stringify(after) === JSON.stringify(baseline);
      if (!same) throw new Error("Pre-existing auth users changed during the run!");
      console.log(`[harness] test users created and removed: ${created.length}; pre-existing auth users unchanged: ${baseline.length}`);
    },
  };
}
