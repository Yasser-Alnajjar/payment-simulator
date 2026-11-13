> Historical. Rule R-DB-1 (`arch-plan.md`) excludes any local or disposable test database; ignore such references here.

> **SUPERSEDED by `docs/S1-revised-plan.md` (v2).** Workspace/project tables no longer exist, and section E (audit purge function) is removed from S1; retention is deferred to S6. Kept only as a record of the hardening reasoning for A, B, C and D.

# S1 migration: revised proposal (NOT applied; SQL below has not been executed anywhere)

Status: proposal only. `packages/db/prisma/migrations/20261113000000_s1_foundation/migration.sql` is unchanged. If approved, A-C below are folded into it (it has never been applied), and D/E become a separate operator-run ops script, not a Prisma migration.

Design note: with a single connecting role (`postgres`, table owner) the database cannot truly stop its own owner from changing `audit_logs`. Triggers are guard rails against bugs and SQL injection through the app. Real immutability needs a **separate runtime role** that is not the owner and has only `INSERT, SELECT` on `audit_logs` (see F). Everything here is built so F can be added later without redesign.

## A. Protect `_prisma_migrations` (ops script, run once, after the first `migrate deploy`)
Prisma creates this table itself, before it runs our SQL, so it cannot be hardened from inside our migration file in a portable way (it also wouldn't exist in other databases we diff against).
```sql
ALTER TABLE public."_prisma_migrations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."_prisma_migrations" FROM anon, authenticated, service_role;
```
- Effect: with RLS enabled and no policies, `anon`/`authenticated` read nothing through the Data API; the REVOKE additionally removes the table grants those roles receive from Supabase's default privileges, so it is closed even if RLS were later disabled. `service_role` bypasses RLS, so only the REVOKE protects against it; this app never uses that key.
- Privileges required: owner of the table (the role that ran `migrate deploy`, normally `postgres`).
- Prisma impact: none. Prisma connects as the owner, which bypasses RLS (to be confirmed by the inspection: `rolbypassrls` / ownership).
- Gap this closes: until it runs, the table is created with Supabase's default grants and no RLS, so it is readable through the Data API if `public` is an exposed schema. Run A immediately after the first deploy (or do B first so it is born closed).

## B. Default privileges so future tables are born closed (ops script, OPTIONAL; decide after the inspection shows `pg_default_acl`)
```sql
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
```
- Effect: tables, sequences and functions that `postgres` creates in `public` from now on do not automatically grant access to the Data API roles. Existing objects are unchanged.
- Privileges: `postgres` itself (or a member of it). Scope warning: project-wide for all future objects created by `postgres` in `public`, including ones made in the Supabase dashboard. Only appropriate if this project is dedicated to the sandbox.
- Order: run B before the first `migrate deploy`, then A still applies (RLS).
- Better, dashboard-level alternative: Settings → API → remove `public` from "Exposed schemas" (the app never uses the Data API). Needs project owner access, no SQL. Recommended in addition to or instead of B.

## C. Revoke Data API access on our six tables (inside the migration, after the RLS statements)
```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "users", "workspaces", "workspace_members", "projects", "api_credentials", "audit_logs"
      FROM anon, authenticated, service_role;
  END IF;
END $$;
```
- Effect: belt-and-braces on top of RLS-without-policies. The `IF EXISTS` keeps the migration valid on plain Postgres (e.g. a separate test database) where these roles do not exist.
- Privileges: table owner (the migrating role).

## D. Harden the audit trigger function and block TRUNCATE (inside the migration; replaces the current function/trigger)
```sql
CREATE OR REPLACE FUNCTION sandbox_audit_logs_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'audit_logs cannot be truncated';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_logs is append-only';
  END IF;
  -- DELETE: only the sanctioned purge path (see E), only for rows older than the hard 90-day floor,
  -- and only as the table owner.
  IF TG_OP = 'DELETE'
     AND pg_catalog.current_setting('sandbox.audit_purge', true) = 'on'
     AND OLD.created_at < pg_catalog.now() - interval '90 days'
     AND pg_catalog.current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID)
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;

REVOKE ALL ON FUNCTION sandbox_audit_logs_guard() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION sandbox_audit_logs_guard() FROM anon, authenticated, service_role;
  END IF;
END $$;

CREATE TRIGGER audit_logs_guard_row
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION sandbox_audit_logs_guard();

CREATE TRIGGER audit_logs_guard_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION sandbox_audit_logs_guard();
```
- Effects: UPDATE is always rejected. TRUNCATE is always rejected (row triggers never fire on TRUNCATE; a separate statement-level trigger is required). DELETE is rejected unless the purge flag is on, the row is older than 90 days, and the session user is the table owner.
- `SET search_path = ''` stops a malicious schema from shadowing functions/operators the body uses (Supabase linter "function_search_path_mutable"); everything is schema-qualified. The body does not reference our tables, so it works in any schema.
- `REVOKE ... FROM PUBLIC/anon/authenticated/service_role`: PostgreSQL grants EXECUTE to PUBLIC by default and Supabase's default privileges grant it to the API roles; with the function in an exposed schema it would otherwise be callable as `/rpc/...`. Trigger functions are not checked for EXECUTE when a trigger fires, so revoking is safe.
- Privileges: `CREATE` on the schema (function), owner of `audit_logs` (triggers).
- Limit: a table owner can still `DROP TRIGGER` or `ALTER TABLE ... DISABLE TRIGGER`; fixed only by F.

## E. Deliberate audit retention (ops script, run by the owner on a schedule; NOT in the app)
```sql
CREATE OR REPLACE FUNCTION public.sandbox_purge_audit_logs(retain interval DEFAULT interval '365 days')
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE n bigint;
BEGIN
  IF retain < interval '90 days' THEN
    RAISE EXCEPTION 'retention floor is 90 days';
  END IF;
  PERFORM pg_catalog.set_config('sandbox.audit_purge', 'on', true);   -- transaction-local
  DELETE FROM public.audit_logs WHERE created_at < pg_catalog.now() - retain;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_catalog.set_config('sandbox.audit_purge', 'off', true);
  INSERT INTO public.audit_logs (action, target_type, metadata)
  VALUES ('audit.purged', 'audit_logs', pg_catalog.jsonb_build_object('deleted', n, 'retain', retain::text));
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.sandbox_purge_audit_logs(interval) FROM PUBLIC, anon, authenticated, service_role;
-- (when F exists) only the operator role may call it:
-- GRANT EXECUTE ON FUNCTION public.sandbox_purge_audit_logs(interval) TO sandbox_operator;
```
- Why this keeps normal immutability: nothing in the app can DELETE (the guard rejects it without the flag, and the app never sets it). The flag is transaction-local and only set inside this function, which only an operator may execute; the guard additionally enforces a hard 90-day floor and owner-only, so even a mistaken `retain` or a stray flag cannot remove recent history. Every purge writes its own `audit.purged` row recording count and cutoff, so purging is itself audited.
- `SECURITY DEFINER` runs as the function owner (the migrating role, i.e. the table owner), which is what the guard requires. `SET search_path = ''` is mandatory for definer functions.
- Privileges to create: `CREATE` on `public`; to run: EXECUTE (owner by default).
- Written against `public` deliberately; it is an ops script, so the schema-scoped test harness never touches it.

## F. Least-privilege runtime role (separate approval; needs `CREATE ROLE`)
```sql
CREATE ROLE sandbox_app LOGIN PASSWORD '<set in Supabase, never in git>' NOBYPASSRLS NOINHERIT;
GRANT USAGE ON SCHEMA public TO sandbox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, workspaces, workspace_members, projects, api_credentials TO sandbox_app;
GRANT SELECT, INSERT ON audit_logs TO sandbox_app;     -- no UPDATE/DELETE/TRUNCATE, cannot drop triggers
```
With a non-owner role, RLS **would** apply to Prisma, so we'd also add explicit policies (`USING (true)` for `sandbox_app` only) to every table; authorization stays in the app. Not proposed for execution now: only recorded so the design can adopt it.

## Order of operations if approved
1. (Optional) B and the dashboard "exposed schemas" change.
2. Revised migration (A-less) via `prisma migrate deploy` with `DIRECT_URL`.
3. A immediately after.
4. E when retention is wanted (S6).
5. F in a later phase.

## Status of the hosted inspection
Done (read-only, nothing changed). Key facts: PostgreSQL 17.11; connected as `postgres` (not superuser, `rolbypassrls = true`, CREATEROLE/CREATEDB); `public` has no tables, enums, policies, functions, views or triggers; 0 Auth users; no `_prisma_migrations`; no name collisions. Default privileges for objects `postgres` creates in `public` grant `arwdDxtm` (tables), `rwU` (sequences) and `X` (functions) to `anon`, `authenticated` and `service_role`; there is no event trigger that auto-enables RLS. Consequence: `_prisma_migrations` (and our tables before RLS) would be created fully granted to the Data API roles, so A is required and B is recommended before the first deploy (the project is empty and dedicated, so B's blast radius is nil).
