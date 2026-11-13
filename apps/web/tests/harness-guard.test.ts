import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_PROJECT_REF, projectRefFromUrl } from "@sandbox/db";
import { assertSafeSql, HOSTED_TEST_FLAG, isTestEmailOfRun, resolveTarget, testEmail, testEmailPattern } from "./harness-safety";

const ok = { SANDBOX_TEST_TARGET: HOSTED_TEST_FLAG, SANDBOX_TEST_EXPECTED_REF: EXPECTED_PROJECT_REF };

describe("hosted test harness safety (unit)", () => {
  it("needs the exact target flag AND the declared project ref; either alone is refused", () => {
    expect(resolveTarget(ok)).toBe("hosted");
    expect(() => resolveTarget({})).toThrow();
    expect(() => resolveTarget({ SANDBOX_TEST_TARGET: HOSTED_TEST_FLAG })).toThrow(/EXPECTED_REF/);
    expect(() => resolveTarget({ SANDBOX_TEST_EXPECTED_REF: EXPECTED_PROJECT_REF })).toThrow(/SANDBOX_TEST_TARGET/);
    expect(() => resolveTarget({ SANDBOX_TEST_TARGET: "1", SANDBOX_TEST_EXPECTED_REF: EXPECTED_PROJECT_REF })).toThrow();
    expect(() => resolveTarget({ ...ok, SANDBOX_TEST_EXPECTED_REF: "otherrefotherrefother" })).toThrow();
  });
  it("rejects the removed disposable-database variable", () => {
    expect(() => resolveTarget({ ...ok, TEST_DATABASE_URL: "postgresql://x@127.0.0.1/db" })).toThrow(/no longer supported/);
  });
  it("derives the project ref from pooler and direct connection strings only", () => {
    expect(projectRefFromUrl(`postgresql://postgres.${EXPECTED_PROJECT_REF}:p@aws-0-eu.pooler.supabase.com:5432/postgres`)).toBe(EXPECTED_PROJECT_REF);
    expect(projectRefFromUrl(`postgresql://postgres:p@db.${EXPECTED_PROJECT_REF}.supabase.co:5432/postgres`)).toBe(EXPECTED_PROJECT_REF);
    expect(projectRefFromUrl("postgresql://postgres:p@127.0.0.1:5432/postgres")).toBeNull();
    expect(projectRefFromUrl("postgresql://postgres:p@localhost:54322/postgres")).toBeNull();
    expect(projectRefFromUrl("not a url")).toBeNull();
  });
  it("blocks DDL, DROP, TRUNCATE and unbounded DELETE/UPDATE; allows scoped statements", () => {
    for (const bad of ["TRUNCATE audit_logs", "drop table x", "DROP SCHEMA public CASCADE", "DELETE FROM audit_logs", "update events set payload = 'x'", "DELETE FROM x WHERE true",
      "delete from x where 1 = 1", "ALTER TABLE x ADD COLUMN y int", "CREATE SCHEMA s", "GRANT ALL ON x TO y", "/* c */ truncate x"]) {
      expect(() => assertSafeSql(bad), bad).toThrow();
    }
    for (const good of ["INSERT INTO x (a) VALUES ($1)", "DELETE FROM auth.users WHERE id = $1 AND email = $2", "UPDATE x SET a = 1 WHERE id = $1", "select * from x for update", "select 1"]) {
      expect(() => assertSafeSql(good), good).not.toThrow();
    }
  });
  it("tags test users per run so interrupted runs can be cleaned without touching real users", () => {
    const run = "0123456789ab";
    expect(isTestEmailOfRun(testEmail(run, 3), run)).toBe(true);
    expect(isTestEmailOfRun(testEmail(run, 3), "ba9876543210")).toBe(false);
    expect(isTestEmailOfRun("real.person@gmail.com", run)).toBe(false);
    expect(testEmailPattern(run)).toBe("sbx-test-0123456789ab-%@sbx-test.invalid");
  });
  it("the harness source contains no schema drop, truncate or disposable-database code", () => {
    const src = readFileSync(path.resolve(__dirname, "harness.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/drop\s+schema|drop\s+table|truncate|TEST_DATABASE_URL|ALLOW_SUPABASE/i);
    expect(src).not.toMatch(/DELETE FROM [\w.]+\s*(["'`;]|$)/); // every DELETE in the harness carries a predicate
  });
});
