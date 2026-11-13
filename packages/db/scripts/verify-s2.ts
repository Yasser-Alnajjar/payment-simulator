/**
 * READ-ONLY verification of the hosted database (rule R-DB-1). Never writes; the session is forced read-only.
 *   pnpm --filter @sandbox/db verify:s2 -- --baseline   (before the S2 migration: identity + S1 state + counts)
 *   pnpm --filter @sandbox/db verify:s2                 (after the S2 migration: identity + S1 + S2 objects)
 * Prints PASS/FAIL per check and no connection details.
 */
import path from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { EXPECTED_PROJECT_REF, verifyHostedIdentity } from "../src/identity";

config({ path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true });
const baseline = process.argv.includes("--baseline");

const S1 = ["api_credentials", "audit_logs"];
const S2 = ["checkout_sessions", "transactions", "events", "idempotency_keys", "api_rate_limits", "auth_failure_windows"];
const USER_OWNED_S2 = ["checkout_sessions", "transactions", "events", "idempotency_keys", "api_rate_limits"];

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

  const id = await verifyHostedIdentity(c, { url, declaredRef: EXPECTED_PROJECT_REF, requireS2: !baseline });
  check(`identity: project ref matches, database '${id.database}', PostgreSQL ${id.serverVersion}, S1 applied, S2 applied=${id.s2Applied}`, true);

  const counts = (await q(`select (select count(*)::int from auth.users) auth_users,
      (select count(*)::int from public.api_credentials) credentials,
      (select count(*)::int from public.audit_logs) audit_rows,
      (select count(distinct user_id)::int from public.audit_logs a where user_id is not null and not exists (select 1 from auth.users u where u.id = a.user_id)) orphan_audit_users`))[0];
  console.log(`INFO  baseline counts: ${JSON.stringify(counts)}`);

  const tables = new Set((await q("select tablename from pg_tables where schemaname='public'")).map((r) => r.tablename));
  const expected = baseline ? [...S1, "_prisma_migrations"] : [...S1, ...S2, "_prisma_migrations"];
  check(`tables are exactly ${expected.length}: ${expected.join(", ")}`, expected.length === tables.size && expected.every((t) => tables.has(t)), [...tables]);

  const rls = await q("select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r'");
  check("RLS enabled on every public table", rls.length === expected.length && rls.every((r) => r.relrowsecurity), rls);
  const grants = await q(`select c.relname, r.rolname from pg_class c cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
      where c.relnamespace='public'::regnamespace and c.relkind in ('r','S')
        and (has_table_privilege(r.rolname,c.oid,'SELECT') or has_table_privilege(r.rolname,c.oid,'INSERT') or has_table_privilege(r.rolname,c.oid,'UPDATE')
          or has_table_privilege(r.rolname,c.oid,'DELETE') or has_table_privilege(r.rolname,c.oid,'TRUNCATE'))`);
  check("anon/authenticated/service_role hold no privileges on public tables or sequences", grants.length === 0, grants);
  const pol = await q("select count(*)::int n from pg_policies where schemaname='public'");
  check("no RLS policies in public (deny-all for the Data API)", pol[0].n === 0, pol);

  const idx1 = await q("select indexdef from pg_indexes where schemaname='public' and indexname='api_credentials_one_active_per_user'");
  check("S1: partial unique index one active credential per user", idx1.length === 1 && /revoked_at IS NULL/.test(idx1[0].indexdef), idx1);
  const trg1 = await q("select tgname from pg_trigger where tgrelid='public.audit_logs'::regclass and not tgisinternal and tgenabled='O' order by 1");
  check("S1: audit_logs guard triggers present and enabled", trg1.length === 2, trg1);
  const dacl = await q("select defaclacl::text acl from pg_default_acl where defaclnamespace='public'::regnamespace and pg_get_userbyid(defaclrole)='postgres'");
  check("default privileges for postgres in public grant nothing to API roles", dacl.every((d) => !/anon|authenticated|service_role/.test(d.acl)), dacl);

  if (!baseline) {
    const fks = await q(`select conrelid::regclass::text tbl from pg_constraint where contype='f' and confrelid='auth.users'::regclass and confdeltype='c' and connamespace='public'::regnamespace`);
    const owned = new Set(fks.map((f) => f.tbl));
    check("every user-owned S1/S2 table has a direct FK to auth.users ON DELETE CASCADE", [...USER_OWNED_S2, "api_credentials"].every((t) => owned.has(t)), [...owned]);
    const unguarded = await q(`select c.relname from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attname='user_id' and not a.attisdropped
      where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname<>'audit_logs'
        and not exists (select 1 from pg_constraint k where k.conrelid=c.oid and k.contype='f' and k.confrelid='auth.users'::regclass and k.confdeltype='c')`);
    check("cascade checklist: no user_id table lacks a cascading FK (except audit_logs)", unguarded.length === 0, unguarded);
    const afw = await q("select count(*)::int n from pg_attribute where attrelid='public.auth_failure_windows'::regclass and attname='user_id' and not attisdropped");
    check("auth_failure_windows is the documented non-user-owned exception (no user_id column)", afw[0].n === 0, afw);
    const al = await q("select count(*)::int n from pg_constraint where conrelid='public.audit_logs'::regclass and contype='f'");
    check("audit_logs still has no FK", al[0].n === 0, al);

    const need = ["transactions_one_active_per_session", "checkout_sessions_token_hash_key", "events_user_id_subject_id_type_key", "checkout_sessions_id_user_id_amount_minor_currency_key",
      "checkout_sessions_user_seq_idx", "checkout_sessions_user_status_seq_idx", "checkout_sessions_user_reference_seq_idx", "checkout_sessions_open_user_expiry_idx", "checkout_sessions_open_expiry_idx",
      "transactions_user_seq_idx", "transactions_user_status_seq_idx", "transactions_session_seq_idx", "transactions_pending_due_idx", "transactions_user_pending_due_idx",
      "events_user_seq_idx", "events_user_type_seq_idx", "idempotency_keys_created_at_idx"];
    const have = new Set((await q("select indexname from pg_indexes where schemaname='public'")).map((r) => r.indexname));
    check("all S2 indexes exist", need.every((n) => have.has(n)), need.filter((n) => !have.has(n)));
    const one = await q("select indexdef from pg_indexes where indexname='transactions_one_active_per_session'");
    check("one pending/succeeded payment per session (partial unique index)", /UNIQUE/.test(one[0]?.indexdef ?? "") && /pending/.test(one[0]?.indexdef ?? "") && /succeeded/.test(one[0]?.indexdef ?? ""), one);
    const comp = await q("select pg_get_constraintdef(oid) d from pg_constraint where conname='transactions_session_fkey'");
    check("composite FK ties payment to session owner, amount and currency", /\(checkout_session_id, user_id, amount_minor, currency\)/.test(comp[0]?.d ?? "") && /ON DELETE CASCADE/.test(comp[0]?.d ?? ""), comp);

    const trg = await q(`select tgrelid::regclass::text tbl, tgname, tgenabled, pg_get_triggerdef(oid) def from pg_trigger where tgrelid in ('public.checkout_sessions'::regclass,'public.transactions'::regclass,'public.events'::regclass) and not tgisinternal`);
    const by = (n: string) => trg.find((t) => t.tgname === n);
    check("integrity triggers present and enabled", ["checkout_sessions_guard", "transactions_guard", "events_guard_row", "events_guard_truncate"].every((n) => by(n)?.tgenabled === "O"), trg.map((t) => t.tgname));
    check("events guard does NOT block DELETE (account deletion must cascade)", !/DELETE/.test(by("events_guard_row")?.def ?? "") && /UPDATE/.test(by("events_guard_row")?.def ?? ""), by("events_guard_row"));
    const fns = await q("select proname, proconfig, proacl::text acl from pg_proc where pronamespace='public'::regnamespace and proname like 'sandbox\\_%guard'");
    check("guard functions: search_path='' and no EXECUTE for PUBLIC or API roles", fns.length === 4 && fns.every((f) => JSON.stringify(f.proconfig) === '["search_path=\\"\\""]' && !/anon|authenticated|service_role/.test(f.acl ?? "") && !/(^\{|,)=X/.test(f.acl ?? "")), fns);
    const cols = await q("select 1 from information_schema.columns where table_schema='public' and table_name='api_credentials' and column_name='expires_at'");
    check("api_credentials.expires_at exists", cols.length === 1, cols);
    const mig = await q("select migration_name from public._prisma_migrations where finished_at is not null and rolled_back_at is null order by started_at");
    check("migration history: S1 then S2, both finished", JSON.stringify(mig.map((m) => m.migration_name)) === JSON.stringify(["20261113000000_s1_foundation", "20261113120000_s2_payments"]), mig);
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
