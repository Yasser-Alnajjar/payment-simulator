/**
 * READ-ONLY inspection of the hosted database. Run BEFORE any migration:
 *   pnpm --filter @sandbox/db inspect
 * The session is forced read-only; this script cannot modify anything.
 */
import path from "node:path";
import { config } from "dotenv";
import pg from "pg";

config({ path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true });

const url = process.env.DIRECT_URL;
if (!url) throw new Error("DIRECT_URL is not set in the repo-root .env");

const ours = ["api_credentials", "audit_logs"];
const ourTypes: string[] = [];

async function main() {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("SET default_transaction_read_only = on");
  const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;

  console.log("== identity ==");
  console.table(await q("select current_user, current_database(), version()"));
  console.log("== current schema / search_path ==");
  console.table(await q("select current_schema() as current_schema, current_setting('search_path') as search_path"));
  console.log("== role attributes (does the connecting role bypass RLS?) ==");
  console.table(await q("select rolname, rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = current_user"));
  console.log("== non-system schemas ==");
  console.table(await q("select schema_name from information_schema.schemata where schema_name not in ('pg_catalog','information_schema','pg_toast') and schema_name not like 'pg_temp%' order by 1"));
  console.log("== tables in public (with estimated row counts) ==");
  console.table(await q("select c.relname as table, c.reltuples::bigint as est_rows, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 1"));
  console.log("== enum types in public ==");
  console.table(await q("select t.typname from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype='e' order by 1"));
  console.log("== installed extensions ==");
  console.table(await q("select e.extname, e.extversion, n.nspname as schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by 1"));
  console.log("== roles (non-internal) ==");
  console.table(await q("select rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole from pg_roles where rolname !~ '^pg_' order by 1"));
  console.log("== role memberships of current_user ==");
  console.table(await q("select r.rolname as member_of from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles u on u.oid=m.member where u.rolname=current_user"));
  console.log("== current_user privileges on public schema / database ==");
  console.table(await q("select has_schema_privilege(current_user,'public','CREATE') as create_in_public, has_schema_privilege(current_user,'public','USAGE') as usage_public, has_database_privilege(current_user,current_database(),'CREATE') as create_schema_in_db"));
  console.log("== RLS policies (all schemas except system) ==");
  console.table(await q("select schemaname, tablename, policyname, cmd, roles from pg_policies where schemaname not in ('pg_catalog','information_schema') order by 1,2,3"));
  console.log("== views / materialized views in public ==");
  console.table(await q("select schemaname, viewname as name from pg_views where schemaname='public' union all select schemaname, matviewname from pg_matviews where schemaname='public'"));
  console.log("== functions in public ==");
  console.table(await q("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1"));
  console.log("== user triggers (non-internal) ==");
  console.table(await q("select event_object_schema as schema, event_object_table as tbl, trigger_name from information_schema.triggers where event_object_schema not in ('pg_catalog','information_schema') order by 1,2,3"));
  console.log("== auth.users row count (existing Auth users) ==");
  console.table(await q("select count(*)::int as auth_users from auth.users"));
  console.log("== table owners in public ==");
  console.table(await q("select tablename, tableowner from pg_tables where schemaname='public' order by 1"));
  console.log("== grants on public tables to Data API roles (grouped) ==");
  console.table(await q("select grantee, count(distinct table_name)::int as tables, string_agg(distinct privilege_type, ',' order by privilege_type) as privileges from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated','service_role') group by grantee order by 1"));
  console.log("== default privileges (applies to NEW tables/sequences/functions) ==");
  console.table(await q("select pg_get_userbyid(defaclrole) as for_objects_created_by, defaclnamespace::regnamespace::text as in_schema, case defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' when 'T' then 'types' else defaclobjtype::text end as object_type, defaclacl::text as acl from pg_default_acl order by 1,2,3"));
  console.log("== Data API (PostgREST) config visible in the database ==");
  console.table(await q("select rolname, rolconfig::text from pg_roles where rolname in ('authenticator','anon','authenticated','service_role') order by 1"));
  console.log("== event triggers (may auto-enable RLS or alter new objects) ==");
  console.table(await q("select evtname, evtevent, evtenabled, pg_get_userbyid(evtowner) as owner from pg_event_trigger order by 1"));
  console.log("== prisma migration history (if any) ==");
  console.table(await q("select to_regclass('public._prisma_migrations') as table_exists"));

  const existing = new Set((await q("select tablename from pg_tables where schemaname='public'")).map((r) => r.tablename as string));
  const existingTypes = new Set((await q("select t.typname from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public'")).map((r) => r.typname as string));
  const tableClash = ours.filter((t) => existing.has(t));
  const typeClash = ourTypes.filter((t) => existingTypes.has(t));
  console.log("\n== collision check against migration 20261113000000_s1_foundation ==");
  console.log("tables that already exist and would collide:", tableClash.length ? tableClash : "none");
  console.log("types that already exist and would collide:", typeClash.length ? typeClash : "none");
  console.log("unrelated pre-existing tables (left untouched):", [...existing].filter((t) => !ours.includes(t)));
  await c.end();
}

main().catch((e) => {
  // Never echo hostnames/credentials that driver errors may contain.
  const msg = e instanceof Error ? e.message : String(e);
  console.error(msg.replace(/[a-z0-9.-]+\.supabase\.(co|com)/gi, "<host>").replace(/postgres(ql)?:\/\/\S+/gi, "<url>"));
  process.exit(1);
});
