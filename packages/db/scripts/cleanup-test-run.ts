/**
 * Targeted cleanup of ONE interrupted test run (rule R-DB-1). Never broad:
 *   pnpm --filter @sandbox/db exec tsx scripts/cleanup-test-run.ts <runId>            (dry run: lists what would be deleted)
 *   pnpm --filter @sandbox/db exec tsx scripts/cleanup-test-run.ts <runId> --confirm   (deletes)
 * Matches only auth.users rows whose email is exactly sbx-test-<runId>-<n>@sbx-test.invalid for the given 12-hex run id,
 * at most 200 rows. The real account can never match. Children (sessions, payments, events, ...) cascade; audit rows stay.
 */
import path from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { EXPECTED_PROJECT_REF, verifyHostedIdentity } from "../src/identity";

config({ path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true });

async function main() {
  const runId = process.argv[2];
  if (!runId || !/^[0-9a-f]{12}$/.test(runId)) throw new Error("usage: cleanup-test-run.ts <12-hex runId> [--confirm]");
  const confirm = process.argv.includes("--confirm");
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("SET default_transaction_read_only = on");
    await verifyHostedIdentity(c, { url, declaredRef: EXPECTED_PROJECT_REF });
    const re = `^sbx-test-${runId}-[0-9]{1,3}@sbx-test\\.invalid$`;
    const rows = (await c.query("select id::text as id, email from auth.users where email ~ $1 order by email limit 201", [re])).rows as { id: string; email: string }[];
    console.log(`${rows.length} test user(s) match run ${runId}`);
    if (rows.length > 200) throw new Error("Refusing: more than 200 matches");
    if (!confirm || rows.length === 0) return console.log(confirm ? "nothing to delete" : "dry run only; pass --confirm to delete");
    await c.query("SET default_transaction_read_only = off");
    const ids = rows.map((r) => r.id);
    const emails = rows.map((r) => r.email);
    const res = await c.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[]) AND email = ANY($2::text[])", [ids, emails]);
    console.log(`deleted ${res.rowCount} test user(s) (their sessions, payments, events and credentials cascade; audit rows remain)`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(msg.replace(/[a-z0-9.-]+\.supabase\.(co|com)/gi, "<host>").replace(/postgres(ql)?:\/\/\S+/gi, "<url>"));
  process.exit(1);
});
