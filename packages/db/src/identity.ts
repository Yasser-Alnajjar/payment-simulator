/**
 * Hosted database identity verification (rule R-DB-1). Read-only: every statement here is a SELECT.
 * An environment variable never proves a database is safe to write to; this check inspects the actual connection.
 */
export const EXPECTED_PROJECT_REF = "yxyhgelnenqeulzxukrc";
export const EXPECTED_DATABASE = "postgres";
export const S1_MIGRATION = "20261113000000_s1_foundation";
export const S2_MIGRATION = "20261113120000_s2_payments";

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export class IdentityError extends Error {}

/** Derives the Supabase project ref from a connection string (pooler user `postgres.<ref>` or host `db.<ref>.supabase.co`). */
export function projectRefFromUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const user = decodeURIComponent(u.username);
  const m1 = /^[a-z_]+\.([a-z0-9]{20})$/.exec(user);
  if (m1?.[1]) return m1[1];
  const m2 = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(u.hostname);
  return m2?.[1] ?? null;
}

export interface IdentityReport {
  projectRef: string;
  database: string;
  serverVersion: string;
  s1Applied: boolean;
  s2Applied: boolean;
}

const S1_TABLES = ["api_credentials", "audit_logs"];
const S2_TABLES = ["checkout_sessions", "transactions", "events", "idempotency_keys", "api_rate_limits", "auth_failure_windows"];

/** Throws IdentityError unless the live connection is the expected hosted project, database and S1 baseline. */
export async function verifyHostedIdentity(
  q: Queryable,
  opts: { url: string; declaredRef: string | undefined; requireS2?: boolean },
): Promise<IdentityReport> {
  const fail = (m: string): never => { throw new IdentityError(`Identity check failed: ${m}`); };
  if (opts.declaredRef !== EXPECTED_PROJECT_REF) fail("the declared project ref does not match the project this repository targets");
  const ref = projectRefFromUrl(opts.url);
  if (ref !== EXPECTED_PROJECT_REF) fail("the connection does not resolve to the expected project ref");
  if (new URL(opts.url).port !== "5432") fail("tests and verification must use the session pooler or direct connection (port 5432)");

  const meta = (await q.query("select current_database() as db, current_setting('server_version_num')::int as v, current_setting('server_version') as sv")).rows[0];
  if (meta.db !== EXPECTED_DATABASE) fail("unexpected database name");
  if (Math.floor(meta.v / 10000) !== 17) fail(`expected PostgreSQL 17, got major ${Math.floor(meta.v / 10000)}`);

  const supa = (await q.query(
    `select (select count(*) from pg_namespace where nspname in ('auth','storage')) as ns,
            (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')) as roles,
            to_regclass('auth.users') is not null as users`,
  )).rows[0];
  if (Number(supa.ns) !== 2 || Number(supa.roles) !== 3 || !supa.users) fail("not a Supabase database (auth/storage/roles missing)");

  const has = async (names: string[]) => {
    const r = (await q.query("select tablename from pg_tables where schemaname = 'public' and tablename = any($1::text[])", [names])).rows;
    return r.length === names.length;
  };
  if (!(await has(S1_TABLES))) fail("S1 tables are missing");
  const mig = (await q.query("select migration_name, finished_at is not null as finished, rolled_back_at is not null as rb from public._prisma_migrations order by started_at")).rows;
  const s1 = mig.find((m: { migration_name: string }) => m.migration_name === S1_MIGRATION);
  if (!s1 || !s1.finished || s1.rb) fail("S1 migration is not recorded as applied");
  const s2Tables = await has(S2_TABLES);
  const s2Rec = mig.find((m: { migration_name: string }) => m.migration_name === S2_MIGRATION);
  const s2Applied = s2Tables && !!s2Rec?.finished && !s2Rec?.rb;
  if (opts.requireS2 && !s2Applied) fail("S2 migration is not applied");
  return { projectRef: ref as string, database: meta.db, serverVersion: meta.sv, s1Applied: true, s2Applied };
}
