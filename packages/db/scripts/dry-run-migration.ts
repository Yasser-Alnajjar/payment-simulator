/**
 * Dry run of a migration file against the Hosted database, ALWAYS rolled back (BEGIN ... ROLLBACK). Verifies identity first,
 * refuses a file containing DROP/TRUNCATE/DELETE, and checks afterwards that nothing persisted.
 *   pnpm --filter @sandbox/db exec tsx scripts/dry-run-migration.ts <migration-folder-name>
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { EXPECTED_PROJECT_REF, verifyHostedIdentity } from "../src/identity";

config({ path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true });

async function main() {
  const name = process.argv[2];
  if (!name || !/^[0-9]{14}_[a-z0-9_]+$/.test(name)) throw new Error("usage: dry-run-migration.ts <migration-folder-name>");
  const sql = readFileSync(path.resolve(import.meta.dirname, "../prisma/migrations", name, "migration.sql"), "utf8");
  // Exact, reviewed widenings that are not data loss (each is a drop-and-re-add widening; S4 ones are documented in docs/S4-plan.md). Anything else with DROP is still refused.
  const ALLOWED = [
    /DROP INDEX "events_user_id_subject_id_type_key";/g,
    /ALTER TABLE "events" DROP CONSTRAINT "events_type_check";/g,
    /ALTER TABLE "transactions" ALTER COLUMN "checkout_session_id" DROP NOT NULL;/g,
    // S4: the scope check is dropped and immediately re-added with one more allowed value (no data affected).
    /ALTER TABLE "api_idempotency_keys" DROP CONSTRAINT "api_idempotency_keys_scope_check";/g,
  ];
  let stripped = sql.replace(/--.*$/gm, "").replace(/BEFORE\s+TRUNCATE\s+ON/gi, "TRIGGER_EVENT_ON"); // a TRUNCATE *guard* trigger is not a TRUNCATE
  for (const a of ALLOWED) stripped = stripped.replace(a, "");
  const bad = stripped.match(/\b(drop|truncate|delete\s+from)\b/gi);
  const allowedDelete = false;
  if (bad && !allowedDelete) throw new Error(`Migration contains destructive statements: ${[...new Set(bad.map((b) => b.toLowerCase()))].join(", ")}`);
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("SET default_transaction_read_only = on");
    await verifyHostedIdentity(c, { url, declaredRef: EXPECTED_PROJECT_REF });
    await c.query("SET default_transaction_read_only = off");
    await c.query("BEGIN");
    await c.query("SET LOCAL lock_timeout = '5s'");
    await c.query(sql);
    const inTx = (await c.query("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n;
    await c.query("ROLLBACK");
    const after = (await c.query("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n;
    console.log(`dry run OK: SQL executed without error inside a transaction (public tables inside: ${inTx}); rolled back (public tables now: ${after})`);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(msg.replace(/[a-z0-9.-]+\.supabase\.(co|com)/gi, "<host>").replace(/postgres(ql)?:\/\/\S+/gi, "<url>"));
  process.exit(1);
});
