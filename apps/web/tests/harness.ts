import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { createPrismaClient, EXPECTED_PROJECT_REF, verifyHostedIdentity, type IdentityReport } from "@sandbox/db";
import { assertSafeSql, MAX_TEST_USERS_PER_RUN, resolveTarget, testEmail } from "./harness-safety";

/**
 * Hosted-database harness (rule R-DB-1: Hosted Supabase only; there is no local, Docker or disposable database).
 *
 * Before ANY write it: (1) requires the explicit target flag AND the declared project ref, (2) verifies the live database
 * identity with read-only queries (project ref from the connection, database name, PostgreSQL 17, Supabase objects, S1/S2 migrations),
 * (3) takes a database-wide advisory lock so two runs cannot interfere, and (4) snapshots the pre-existing rows.
 * Verification uses a connection that is forced read-only; writes use a separate connection.
 * Test users are rows in auth.users tagged sbx-test-<runId>-<n>@sbx-test.invalid and recorded in a gitignored manifest BEFORE insertion.
 * Cleanup deletes only those exact ids with the exact tag; pre-existing data is fingerprinted before and verified after.
 * The harness issues no schema changes and no table-wide deletes; `sql()` additionally rejects such statements.
 * Audit rows written by tests are immutable by design and remain; the run reports how many it created.
 */
export const DB_TESTS_ENABLED = process.env.SANDBOX_TEST_TARGET !== undefined;
const LOCK_KEY = 7_428_190_331n; // arbitrary constant, database-wide advisory lock for "a test run is active"
const MANIFEST_DIR = path.resolve(__dirname, "../.sbx-test-runs");
const POOL_MAX = 4;
/** User-owned tables checked for leftovers after every run. Names are constants (never input), so interpolating them is safe. */
export const OWNED_TABLES = [
  "api_credentials", "checkout_sessions", "transactions", "events", "idempotency_keys", "api_rate_limits",
  "payment_methods", "setup_sessions", "api_idempotency_keys",
  "webhook_endpoints", "webhook_deliveries", "webhook_delivery_attempts",
] as const;

export interface Harness {
  prisma: ReturnType<typeof createPrismaClient>;
  runId: string;
  identity: IdentityReport;
  /** Guarded raw SQL on the write connection. */
  sql: (text: string, params?: unknown[]) => Promise<pg.QueryResult>;
  user: () => Promise<{ id: string }>;
  deleteAuthUser: (id: string) => Promise<void>;
  close: () => Promise<void>;
}

const FINGERPRINT = {
  authUsers: "select id::text as id, md5(concat_ws('|', id, email, created_at, encrypted_password, email_confirmed_at, raw_app_meta_data)) as fp from auth.users order by id",
};

/** `allowActiveScheduler` is for the deployed end-to-end test only: it needs the real Supabase Cron tick running. All other write tests must run with Cron paused. */
export async function createTestDb(opts: { requireS2?: boolean; allowActiveScheduler?: boolean } = {}): Promise<Harness> {
  config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });
  resolveTarget(process.env);
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set");

  const reader = new pg.Client({ connectionString: url });
  await reader.connect();
  await reader.query("SET default_transaction_read_only = on");
  let writer: pg.Client | undefined;
  try {
    const identity = await verifyHostedIdentity(reader, { url, declaredRef: process.env.SANDBOX_TEST_EXPECTED_REF, requireS2: opts.requireS2 ?? true });
    if (identity.projectRef !== EXPECTED_PROJECT_REF) throw new Error("Identity mismatch");

    // S4: a running Supabase Cron tick would sweep and claim this run's data concurrently. Refuse unless it is paused.
    if (!opts.allowActiveScheduler && (await reader.query("select to_regclass('public.scheduler_leases') is not null as present")).rows[0].present) {
      const recent = (await reader.query("select count(*)::int n from public.scheduler_leases where name = 'tick' and last_started_at > now() - interval '3 minutes'")).rows[0].n;
      if (recent > 0) throw new Error("The scheduler tick ran in the last 3 minutes: pause the Supabase Cron job (cron.alter_job ... active := false) before running hosted write tests");
    }

    writer = new pg.Client({ connectionString: url });
    await writer.connect();
    const locked = (await writer.query("select pg_try_advisory_lock($1::bigint) as ok", [LOCK_KEY.toString()])).rows[0].ok;
    if (!locked) throw new Error("Another test run holds the database test lock; refusing to run in parallel");

    // Snapshot pre-existing rows (read-only connection).
    const baseUsers = (await reader.query(FINGERPRINT.authUsers)).rows as { id: string; fp: string }[];
    const baseCreds = (await reader.query("select id::text as id, md5(t::text) as fp from public.api_credentials t order by id")).rows as { id: string; fp: string }[];
    // Non-secret columns only, to explain a mismatch (e.g. the operator used the dashboard while the run was active).
    const credCols = "id::text as id, created_at, last_used_at, revoked_at, expires_at";
    const baseCredView = (await reader.query(`select ${credCols} from public.api_credentials order by id`)).rows as Record<string, unknown>[];
    const baseAudit = (await reader.query("select id::text as id from public.audit_logs order by id")).rows.map((r) => r.id as string);

    const runId = randomBytes(6).toString("hex");
    const created: { id: string; email: string }[] = [];
    mkdirSync(MANIFEST_DIR, { recursive: true });
    const manifest = path.join(MANIFEST_DIR, `${runId}.json`);
    const persist = () => writeFileSync(manifest, JSON.stringify({ runId, users: created }));
    persist();
    const prisma = createPrismaClient(url, { max: POOL_MAX });
    const w = writer;

    return {
      prisma,
      runId,
      identity,
      sql: (text, params = []) => { assertSafeSql(text); return w.query(text, params); },
      async user() {
        if (created.length >= MAX_TEST_USERS_PER_RUN) throw new Error("Too many test users in one run");
        const id = randomUUID();
        const email = testEmail(runId, created.length + 1);
        created.push({ id, email });
        persist(); // write-ahead: the manifest knows the user before the row exists
        await w.query("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [id, email]);
        return { id };
      },
      async deleteAuthUser(id) {
        const u = created.find((c) => c.id === id);
        if (!u) throw new Error("Refusing to delete an auth user this run did not create");
        await w.query("DELETE FROM auth.users WHERE id = $1 AND email = $2", [u.id, u.email]);
      },
      async close() {
        await prisma.$disconnect();
        const ids = created.map((c) => c.id);
        const emails = created.map((c) => c.email);
        let auditCreated = 0;
        let problem: string | undefined;
        try {
          if (ids.length) {
            auditCreated = (await w.query("select count(*)::int n from public.audit_logs where user_id = any($1::uuid[])", [ids])).rows[0].n;
            await w.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[]) AND email = ANY($2::text[])", [ids, emails]);
          }
          // Everything this run created must be gone (children cascade); everything that existed must be untouched.
          const leftover: Record<string, number> = {
            "auth.users": Number((await reader.query("select count(*) n from auth.users where id = any($1::uuid[])", [ids])).rows[0].n),
          };
          // Every user-owned table that exists in this database (S4 tables only once their migration is applied).
          const present = (await reader.query("select t from unnest($1::text[]) t where to_regclass('public.' || t) is not null", [OWNED_TABLES])).rows.map((r) => r.t as string);
          for (const t of present) leftover[t] = Number((await reader.query(`select count(*) n from public.${t} where user_id = any($1::uuid[])`, [ids])).rows[0].n);
          if (Object.values(leftover).some((n) => n !== 0)) problem = `leftover test rows: ${JSON.stringify(leftover)}`;
          const bi = baseUsers.map((u) => u.id);
          const usersNow = (await reader.query(FINGERPRINT.authUsers.replace("from auth.users", "from auth.users where id = any($1::uuid[])"), [bi])).rows as { id: string; fp: string }[];
          if (JSON.stringify(usersNow) !== JSON.stringify(baseUsers)) problem = "pre-existing auth users changed";
          const credsNow = (await reader.query("select id::text as id, md5(t::text) as fp from public.api_credentials t where id = any($1::uuid[]) order by id", [baseCreds.map((c) => c.id)])).rows;
          if (JSON.stringify(credsNow) !== JSON.stringify(baseCreds)) {
            const view = (await reader.query(`select ${credCols} from public.api_credentials where id = any($1::uuid[]) order by id`, [baseCreds.map((c) => c.id)])).rows as Record<string, unknown>[];
            const changed = new Set<string>();
            for (const b of baseCredView) { const n = view.find((v) => v.id === b.id); for (const k of Object.keys(b)) if (!n || JSON.stringify(n[k]) !== JSON.stringify(b[k])) changed.add(k); }
            problem = `pre-existing api_credentials changed (columns: ${[...changed].join(", ") || "secret columns"}). The harness never writes to them; if the operator used the dashboard while the run was active, re-run without touching the app`;
          }
          const auditNow = (await reader.query("select count(*)::int n from public.audit_logs where id = any($1::uuid[])", [baseAudit])).rows[0].n;
          if (auditNow !== baseAudit.length) problem = "pre-existing audit_logs rows missing";
        } finally {
          await w.query("select pg_advisory_unlock($1::bigint)", [LOCK_KEY.toString()]).catch(() => undefined);
          await w.end().catch(() => undefined);
          await reader.end().catch(() => undefined);
        }
        if (problem) throw new Error(`[harness] ${problem}; manifest kept at ${path.relative(process.cwd(), manifest)}`);
        rmSync(manifest, { force: true });
        console.log(`[harness] run ${runId}: ${created.length} test user(s) created and removed; ${auditCreated} immutable audit row(s) remain; ${baseUsers.length} pre-existing auth user(s), ${baseCreds.length} credential(s), ${baseAudit.length} audit row(s) verified unchanged`);
      },
    };
  } catch (e) {
    await writer?.end().catch(() => undefined);
    await reader.end().catch(() => undefined);
    throw e;
  }
}
