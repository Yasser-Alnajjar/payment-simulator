import { describe, expect, it } from "vitest";
import { assertDisposable, HOSTED_DEV_FLAG, resolveTarget } from "./harness";

describe("test harness default protection", () => {
  it("rejects the primary project in any form (disposable path)", () => {
    expect(() => assertDisposable("postgresql://u:p@db.yxyhgelnenqeulzxukrc.supabase.co:5432/postgres")).toThrow(/primary/);
    expect(() => assertDisposable("postgresql://postgres.yxyhgelnenqeulzxukrc:p@aws-0-eu.pooler.supabase.com:5432/postgres")).toThrow(/primary/);
    expect(() => resolveTarget({ TEST_DATABASE_URL: "postgresql://postgres.yxyhgelnenqeulzxukrc:p@h.pooler.supabase.com:5432/postgres" })).toThrow(/primary/);
  });
  it("rejects any Supabase host without the explicit opt-in", () => {
    expect(() => assertDisposable("postgresql://u:p@db.otherref.supabase.co:5432/postgres", {})).toThrow(/ALLOW_SUPABASE_TEST_DB/);
    expect(() => assertDisposable("postgresql://u:p@db.otherref.supabase.co:5432/postgres", { ALLOW_SUPABASE_TEST_DB: "1" })).not.toThrow();
  });
  it("accepts a local Postgres", () => {
    expect(resolveTarget({ TEST_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54329/test" })).toBe("disposable");
  });
  it("hosted-dev mode needs the exact flag value; nothing else enables it", () => {
    expect(() => resolveTarget({})).toThrow();
    expect(() => resolveTarget({ SANDBOX_TEST_TARGET: "1" })).toThrow(/Unrecognised/);
    expect(() => resolveTarget({ SANDBOX_TEST_TARGET: "hosted-dev" })).toThrow(/Unrecognised/);
    expect(resolveTarget({ SANDBOX_TEST_TARGET: HOSTED_DEV_FLAG })).toBe("hosted-dev");
  });
  it("hosted-dev flag cannot be combined with a TEST_DATABASE_URL", () => {
    expect(() => resolveTarget({ SANDBOX_TEST_TARGET: HOSTED_DEV_FLAG, TEST_DATABASE_URL: "postgresql://x@127.0.0.1/db" })).toThrow(/not both/);
  });
});
