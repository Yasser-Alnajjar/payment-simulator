/** READ-ONLY post-migration verification of the S1 objects. Prints PASS/FAIL per check; exits 1 on any FAIL. */
import path from "node:path";
import { config } from "dotenv";
import pg from "pg";

config({ path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true });

async function main() {
  if (!process.env.DIRECT_URL) throw new Error("DIRECT_URL is not set");
  const c = new pg.Client({ connectionString: process.env.DIRECT_URL });
  await c.connect();
  await c.query("SET default_transaction_read_only = on");
  const q = async (s: string) => (await c.query(s)).rows;
  let failed = 0;
  const check = (name: string, ok: boolean, detail: unknown) => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
  };

  const tables = (await q("select tablename from pg_tables where schemaname='public' order by 1")).map((r) => r.tablename);
  check("1 tables are exactly _prisma_migrations, api_credentials, audit_logs", JSON.stringify(tables) === JSON.stringify(["_prisma_migrations", "api_credentials", "audit_logs"]), tables);

  const rls = await q("select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1");
  check("2 RLS enabled on every public table", rls.length === 3 && rls.every((r) => r.relrowsecurity === true), rls);

  const grants = await q(`select c.relname, r.rolname,
      has_table_privilege(r.rolname,c.oid,'SELECT') s, has_table_privilege(r.rolname,c.oid,'INSERT') i,
      has_table_privilege(r.rolname,c.oid,'UPDATE') u, has_table_privilege(r.rolname,c.oid,'DELETE') d,
      has_table_privilege(r.rolname,c.oid,'TRUNCATE') t
    from pg_class c cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
    where c.relnamespace='public'::regnamespace and c.relkind='r'`);
  check("3 anon/authenticated/service_role hold no table privileges", grants.length === 9 && grants.every((g) => !g.s && !g.i && !g.u && !g.d && !g.t), grants.filter((g) => g.s || g.i || g.u || g.d || g.t));

  const idx = await q("select indexdef from pg_indexes where schemaname='public' and indexname='api_credentials_one_active_per_user'");
  check("4 partial unique index (user_id) WHERE revoked_at IS NULL", idx.length === 1 && /UNIQUE/.test(idx[0].indexdef) && /\(user_id\)/.test(idx[0].indexdef) && /revoked_at IS NULL/.test(idx[0].indexdef), idx);

  const fks = await q("select conrelid::regclass::text tbl, confrelid::regclass::text refs, confdeltype from pg_constraint where contype='f' and connamespace='public'::regnamespace");
  check("5 exactly one FK: api_credentials -> auth.users ON DELETE CASCADE; none on audit_logs", fks.length === 1 && fks[0].tbl === "api_credentials" && fks[0].refs === "auth.users" && fks[0].confdeltype === "c", fks);

  const trg = await q("select tgname, tgenabled, pg_get_triggerdef(oid) def from pg_trigger where tgrelid='public.audit_logs'::regclass and not tgisinternal order by 1");
  check("6 audit triggers present, enabled, row (UPDATE/DELETE) and statement (TRUNCATE)",
    trg.length === 2 && trg.every((t) => t.tgenabled === "O") &&
    trg.some((t) => t.tgname === "audit_logs_guard_row" && /BEFORE (UPDATE OR DELETE|DELETE OR UPDATE).*FOR EACH ROW/.test(t.def)) &&
    trg.some((t) => t.tgname === "audit_logs_guard_truncate" && /BEFORE TRUNCATE.*FOR EACH STATEMENT/.test(t.def)), trg);

  const fn = await q("select proconfig, proacl::text acl from pg_proc where proname='sandbox_audit_logs_guard' and pronamespace='public'::regnamespace");
  const acl = fn[0]?.acl ?? "";
  check("7 guard function: search_path='' and no PUBLIC/anon/authenticated/service_role EXECUTE", fn.length === 1 && JSON.stringify(fn[0].proconfig) === '["search_path=\\"\\""]' && !/anon|authenticated|service_role/.test(acl) && !/(^\{|,)=X/.test(acl), fn);

  const dacl = await q("select defaclobjtype, defaclacl::text acl from pg_default_acl where defaclnamespace='public'::regnamespace and pg_get_userbyid(defaclrole)='postgres'");
  check("8 default privileges for postgres in public no longer grant anon/authenticated/service_role", dacl.every((d) => !/anon|authenticated|service_role/.test(d.acl)), dacl);

  const mig = await q("select migration_name, finished_at is not null fin, rolled_back_at is not null rb from _prisma_migrations order by started_at");
  check("9 migration history: only 20261113000000_s1_foundation, finished, not rolled back", mig.length === 1 && mig[0].migration_name === "20261113000000_s1_foundation" && mig[0].fin && !mig[0].rb, mig);

  const nopol = await q("select count(*)::int n from pg_policies where schemaname='public'");
  check("10 no RLS policies in public (deny-all for API roles)", nopol[0].n === 0, nopol);

  await c.end();
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(msg.replace(/[a-z0-9.-]+\.supabase\.(co|com)/gi, "<host>").replace(/postgres(ql)?:\/\/\S+/gi, "<url>"));
  process.exit(1);
});
