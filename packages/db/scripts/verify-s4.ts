/**
 * READ-ONLY verification of the hosted database for S4 (rule R-DB-1). Never writes; the session is forced read-only.
 *   pnpm --filter @sandbox/db verify:s4 -- --baseline   (before the S4 migration: identity, migration history incl. payment methods,
 *                                                        pg_cron / pg_net / supabase_vault availability, database size, counts)
 *   pnpm --filter @sandbox/db verify:s4                 (after the S4 migration: every S4 object, constraint, index, trigger, grant)
 * Prints PASS/FAIL/INFO per check and no connection details or secrets.
 */
import path from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { EXPECTED_PROJECT_REF, verifyHostedIdentity } from "../src/identity";

config({ path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true });
const baseline = process.argv.includes("--baseline");

const PAYMENT_METHODS_MIGRATION = "20261113200000_payment_methods";
const S4_MIGRATION = "20261114120000_s4_webhooks";
const S4_TABLES = ["webhook_endpoints", "webhook_deliveries", "webhook_delivery_attempts", "scheduler_leases"];
const S4_USER_OWNED = ["webhook_endpoints", "webhook_deliveries", "webhook_delivery_attempts"];

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("SET default_transaction_read_only = on");
  const q = async (s: string, p: unknown[] = []) => (await c.query(s, p)).rows;
  let failed = 0;
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
  };
  const info = (name: string, v: unknown) => console.log(`INFO  ${name}: ${JSON.stringify(v)}`);

  const ro = await q("show default_transaction_read_only");
  check("session is read-only", ro[0]?.default_transaction_read_only === "on", ro);
  const id = await verifyHostedIdentity(c, { url, declaredRef: EXPECTED_PROJECT_REF, requireS2: true });
  check(`identity: project ref matches, database '${id.database}', PostgreSQL ${id.serverVersion}, S1 and S2 applied`, true);

  const mig = await q("select migration_name, finished_at is not null as finished, rolled_back_at is not null as rb from public._prisma_migrations order by started_at");
  info("migration history", mig.map((m) => `${m.migration_name}${m.finished ? "" : " (NOT finished)"}${m.rb ? " (rolled back)" : ""}`));
  const pm = mig.find((m) => m.migration_name === PAYMENT_METHODS_MIGRATION);
  check(`${PAYMENT_METHODS_MIGRATION} is applied (S4 builds on it)`, !!pm?.finished && !pm?.rb, pm ?? "not recorded");
  const occ = await q("select 1 from information_schema.columns where table_schema='public' and table_name='events' and column_name='occurrence'");
  check("events.occurrence exists (from the payment-methods migration)", occ.length === 1);

  const ext = await q("select name, default_version, installed_version from pg_available_extensions where name in ('pg_cron','pg_net','supabase_vault') order by name");
  info("extensions (available / installed)", ext);
  for (const n of ["pg_cron", "pg_net", "supabase_vault"]) check(`extension ${n} is available on this project`, ext.some((e) => e.name === n), ext);
  const cronJobs = await q("select exists(select 1 from pg_namespace where nspname='cron') as has_cron_schema");
  if (cronJobs[0]?.has_cron_schema) {
    const jobs = await q("select jobname, schedule, active from cron.job order by jobid").catch(() => [] as unknown[]);
    info("existing cron jobs (name, schedule, active)", jobs);
  }

  const size = await q("select pg_size_pretty(pg_database_size(current_database())) as size, pg_database_size(current_database()) as bytes");
  info("database size", size[0]);
  const counts = await q(`select (select count(*)::int from auth.users) auth_users, (select count(*)::int from public.events) events,
      (select count(*)::int from public.checkout_sessions) sessions, (select count(*)::int from public.transactions) payments,
      (select count(*)::int from public.checkout_sessions where status='open' and expires_at <= now()) due_expired_sessions`);
  info("baseline counts", counts[0]);
  const optional = await q("select t, to_regclass('public.' || t) is not null as present from unnest(array['payment_methods','setup_sessions','api_idempotency_keys']) t");
  info("S3 tables present", optional);

  if (!baseline) {
    const s4 = mig.find((m) => m.migration_name === S4_MIGRATION);
    check(`${S4_MIGRATION} is applied`, !!s4?.finished && !s4?.rb, s4 ?? "not recorded");
    const tables = new Set((await q("select tablename from pg_tables where schemaname='public'")).map((r) => r.tablename));
    check("S4 tables exist", S4_TABLES.every((t) => tables.has(t)), S4_TABLES.filter((t) => !tables.has(t)));
    const rls = await q("select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname = any($1::text[])", [S4_TABLES]);
    check("RLS enabled on every S4 table", rls.length === S4_TABLES.length && rls.every((r) => r.relrowsecurity), rls);
    const grants = await q(`select c.relname, r.rolname from pg_class c cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
        where c.relnamespace='public'::regnamespace and c.relkind in ('r','S')
          and (has_table_privilege(r.rolname,c.oid,'SELECT') or has_table_privilege(r.rolname,c.oid,'INSERT') or has_table_privilege(r.rolname,c.oid,'UPDATE')
            or has_table_privilege(r.rolname,c.oid,'DELETE') or has_table_privilege(r.rolname,c.oid,'TRUNCATE'))`);
    check("anon/authenticated/service_role hold no privileges on public tables or sequences", grants.length === 0, grants);
    const pol = await q("select count(*)::int n from pg_policies where schemaname='public'");
    check("no RLS policies in public", pol[0].n === 0, pol);

    const fks = await q(`select conrelid::regclass::text tbl from pg_constraint where contype='f' and confrelid='auth.users'::regclass and confdeltype='c' and connamespace='public'::regnamespace`);
    const owned = new Set(fks.map((f) => f.tbl));
    check("every user-owned S4 table cascades from auth.users", S4_USER_OWNED.every((t) => owned.has(t)), [...owned]);
    const comp = await q("select conname, pg_get_constraintdef(oid) d from pg_constraint where conname in ('webhook_deliveries_event_fkey','webhook_deliveries_endpoint_fkey','webhook_delivery_attempts_delivery_fkey')");
    check("composite tenant FKs (event, endpoint, delivery) include user_id and cascade", comp.length === 3 && comp.every((x) => /user_id\)/.test(x.d) && /ON DELETE CASCADE/.test(x.d)), comp);

    const need = ["events_id_user_id_key", "webhook_endpoints_id_user_id_key", "webhook_endpoints_user_seq_idx", "webhook_endpoints_fanout_idx",
      "webhook_deliveries_event_endpoint_key", "webhook_deliveries_id_user_id_key", "webhook_deliveries_due_idx", "webhook_deliveries_user_seq_idx",
      "webhook_deliveries_user_status_seq_idx", "webhook_deliveries_endpoint_seq_idx", "webhook_delivery_attempts_delivery_attempt_key"];
    const have = new Set((await q("select indexname from pg_indexes where schemaname='public'")).map((r) => r.indexname));
    check("all S4 indexes exist", need.every((n) => have.has(n)), need.filter((n) => !have.has(n)));
    const uniq = await q("select indexname, indexdef from pg_indexes where indexname in ('webhook_deliveries_event_endpoint_key','webhook_delivery_attempts_delivery_attempt_key')");
    check("one delivery per (event, endpoint) and one attempt per number are UNIQUE", uniq.length === 2 && uniq.every((u) => /UNIQUE/.test(u.indexdef)), uniq);

    const types = await q("select pg_get_constraintdef(oid) d, convalidated from pg_constraint where conname='events_type_check'");
    check("events_type_check includes webhook_endpoint.test and is validated", /webhook_endpoint\.test/.test(types[0]?.d ?? "") && types[0]?.convalidated === true, types);
    const scope = await q("select pg_get_constraintdef(oid) d, convalidated from pg_constraint where conname='api_idempotency_keys_scope_check'");
    check("api_idempotency_keys scope includes webhook_endpoint.create and is validated", /webhook_endpoint\.create/.test(scope[0]?.d ?? "") && scope[0]?.convalidated === true, scope);

    const trg = await q(`select tgname, tgenabled, pg_get_triggerdef(oid) def from pg_trigger where tgrelid in ('public.webhook_endpoints'::regclass,'public.webhook_deliveries'::regclass,'public.webhook_delivery_attempts'::regclass) and not tgisinternal`);
    const by = (n: string) => trg.find((t) => t.tgname === n);
    check("S4 integrity triggers present and enabled", ["webhook_endpoints_guard", "webhook_deliveries_guard", "webhook_delivery_attempts_guard_row", "webhook_delivery_attempts_guard_truncate"].every((n) => by(n)?.tgenabled === "O"), trg.map((t) => t.tgname));
    check("attempts guard does NOT block DELETE (account deletion must cascade)", !/DELETE/.test(by("webhook_delivery_attempts_guard_row")?.def ?? "x DELETE"), by("webhook_delivery_attempts_guard_row"));
    const fns = await q("select proname, proconfig, proacl::text acl from pg_proc where pronamespace='public'::regnamespace and proname in ('sandbox_webhook_endpoints_guard','sandbox_webhook_deliveries_guard','sandbox_webhook_attempts_guard')");
    check("S4 guard functions: search_path='' and no EXECUTE for PUBLIC or API roles", fns.length === 3 && fns.every((f) => JSON.stringify(f.proconfig) === '["search_path=\\"\\""]' && !/anon|authenticated|service_role/.test(f.acl ?? "") && !/(^\{|,)=X/.test(f.acl ?? "")), fns);
    const lease = await q("select name from public.scheduler_leases");
    check("scheduler_leases holds exactly the 'tick' row", lease.length === 1 && lease[0].name === "tick", lease);
  }
  await c.end();
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(msg.replace(/[a-z0-9.-]+\.supabase\.(co|com)/gi, "<host>").replace(/postgres(ql)?:\/\/\S+/gi, "<url>"));
  process.exit(1);
});
