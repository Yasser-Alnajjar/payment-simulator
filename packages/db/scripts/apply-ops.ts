/**
 * Applies ONE approved ops SQL file in a single transaction using DIRECT_URL (session pooler).
 *   pnpm --filter @sandbox/db exec tsx scripts/apply-ops.ts pre|post
 * Only the whitelisted files below can be run. Prints the statements, never URLs or credentials.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import pg from "pg";

config({ path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true });

const FILES: Record<string, string> = {
  pre: "001_pre_migration_default_privileges.sql",
  post: "002_post_migration_protect_prisma_table.sql",
};

async function main() {
  const which = process.argv[2] ?? "";
  const file = FILES[which];
  if (!file) throw new Error(`Usage: apply-ops <${Object.keys(FILES).join("|")}>`);
  if (!process.env.DIRECT_URL) throw new Error("DIRECT_URL is not set");
  const sql = readFileSync(path.resolve(import.meta.dirname, "../ops", file), "utf8");
  console.log(`Applying ${file} in one transaction:\n${sql}`);
  const c = new pg.Client({ connectionString: process.env.DIRECT_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(sql);
    await c.query("COMMIT");
    console.log("COMMITTED");
  } catch (e) {
    await c.query("ROLLBACK");
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
