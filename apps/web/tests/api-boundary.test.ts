import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../src");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const read = (p: string) => readFileSync(p, "utf8");

describe("API/dashboard authentication boundary (static)", () => {
  const apiFiles = [...walk(path.join(root, "server/api")), ...walk(path.join(root, "app/api"))];
  it("API code never reads dashboard sessions or Supabase auth", () => {
    for (const f of apiFiles) expect(read(f), f).not.toMatch(/supabase|server\/session|getSessionUser|requireUser|next\/headers|cookies\(/);
  });
  it("dashboard actions never use API credential authentication", () => {
    for (const f of walk(path.join(root, "actions"))) expect(read(f), f).not.toMatch(/server\/api|authenticate\(|parseBasic/);
  });
  it("the dashboard proxy is not applied to /api/v1", () => {
    expect(read(path.join(root, "proxy.ts"))).toMatch(/matcher:.*api\/v1\//);
  });
  it("no CORS headers are ever set and nothing logs request bodies or tokens", () => {
    for (const f of apiFiles) {
      const s = read(f);
      expect(s, f).not.toMatch(/access-control/i);
      for (const line of s.split("\n").filter((l) => /console\./.test(l))) expect(line, f).not.toMatch(/body|token|secret|authorization|payload/i);
    }
  });
  it("every merchant API route file is a thin wrapper that only calls the shared handlers", () => {
    const routes = walk(path.join(root, "app/api/v1")).filter((f) => f.endsWith("route.ts"));
    expect(routes.length).toBeGreaterThan(0);
    for (const f of routes) expect(read(f), f).toMatch(/handlers\./);
  });
  it("the only route outside /api/v1 is the scheduler tick, and it only calls the scheduler entry point", () => {
    const others = walk(path.join(root, "app/api")).filter((f) => f.endsWith("route.ts") && !f.includes(`${path.sep}v1${path.sep}`));
    expect(others.map((f) => path.relative(root, f))).toEqual([path.join("app", "api", "scheduler", "tick", "route.ts")]);
    const src = read(others[0]!);
    expect(src).toMatch(/handleSchedulerTick\(/);
    expect(src).not.toMatch(/handlers\./);
  });
  it("the dashboard proxy is not applied to the scheduler tick route", () => {
    expect(read(path.join(root, "proxy.ts"))).toMatch(/matcher:.*api\/scheduler\//);
  });
});
