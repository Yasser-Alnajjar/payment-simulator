import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { revokeCredential, rotateCredential } from "@/server/services/credentials";
import { createTestDb, DB_TESTS_ENABLED, type Harness } from "./harness";
import { basic, call, createSession, ENC_KEY, makeClock, makeDeps, newAccount } from "./api-helpers";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe.skipIf(!DB_TESTS_ENABLED)("API authentication and credential lifecycle (Hosted Supabase)", () => {
  let t: Harness;
  const clock = makeClock();
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t?.close(); });

  it("authenticates with Basic client_id:client_secret and returns a request id", async () => {
    const a = await newAccount(t);
    const r = await call(makeDeps(t, clock), "GET", "/api/v1/checkout/sessions", { auth: a.auth });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ object: "list", data: [], has_more: false });
    expect(r.headers.get("request-id")).toMatch(/^req_/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-ratelimit-limit")).toBe("100");
    expect(Object.fromEntries(r.headers)).not.toHaveProperty("access-control-allow-origin");
  });

  it("every unauthenticated case is the same 401 with WWW-Authenticate: Basic and the error envelope", async () => {
    const a = await newAccount(t);
    const deps = makeDeps(t, clock);
    const cases: (string | null)[] = [null, "", "Bearer abc", "Basic", "Basic !!!", basic(a.clientId, "wrong"), basic("sbx_cid_unknown", a.clientSecret), basic("sbx_cid_unknown", "x"), `Basic ${Buffer.from("nocolon").toString("base64")}`, basic(a.clientId, "")];
    for (const auth of cases) {
      const r = await call(deps, "GET", "/api/v1/payments", { auth });
      expect(r.status, String(auth)).toBe(401);
      expect(r.json.error).toMatchObject({ type: "authentication_error", code: "invalid_credentials", message: "Invalid API credentials" });
      expect(r.json.error.request_id).toBe(r.headers.get("request-id"));
      expect(r.headers.get("www-authenticate")).toMatch(/^Basic /);
    }
  });

  it("dashboard cookies and Supabase-style tokens never authorize the API", async () => {
    const deps = makeDeps(t, clock);
    const r = await call(deps, "GET", "/api/v1/payments", { auth: null, headers: { cookie: "sb-access-token=abc; sb-refresh-token=def", "x-supabase-auth": "x" } });
    expect(r.status).toBe(401);
    const r2 = await call(deps, "GET", "/api/v1/payments", { auth: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.x" });
    expect(r2.status).toBe(401);
  });

  it("revoked credentials are rejected immediately, and only after the secret verified (wrong secret stays generic)", async () => {
    const a = await newAccount(t);
    const deps = makeDeps(t, clock);
    expect((await call(deps, "GET", "/api/v1/payments", { auth: a.auth })).status).toBe(200);
    await revokeCredential(t.prisma, a.userId, a.credentialId);
    const r = await call(deps, "GET", "/api/v1/payments", { auth: a.auth });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("credential_revoked");
    expect((await call(deps, "GET", "/api/v1/payments", { auth: basic(a.clientId, "wrong-secret") })).json.error.code).toBe("invalid_credentials");
  });

  it("rotation: the old pair stops working at once and the new pair works", async () => {
    const a = await newAccount(t);
    const deps = makeDeps(t, clock);
    const next = await rotateCredential(t.prisma, a.userId, a.credentialId, ENC_KEY);
    expect((await call(deps, "GET", "/api/v1/payments", { auth: a.auth })).json.error.code).toBe("credential_revoked");
    expect((await call(deps, "GET", "/api/v1/payments", { auth: basic(next.credential.clientId, next.clientSecret) })).status).toBe(200);
  });

  it("expired credentials are rejected (expires_at set directly in the database)", async () => {
    const a = await newAccount(t);
    const deps = makeDeps(t, clock);
    await t.sql("UPDATE api_credentials SET expires_at = now() + interval '1 hour' WHERE id = $1", [a.credentialId]);
    expect((await call(deps, "GET", "/api/v1/payments", { auth: a.auth })).status).toBe(200);
    await t.sql("UPDATE api_credentials SET expires_at = now() - interval '1 minute' WHERE id = $1", [a.credentialId]);
    const r = await call(deps, "GET", "/api/v1/payments", { auth: a.auth });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("credential_expired");
    expect(r.headers.get("www-authenticate")).toMatch(/^Basic /);
  });

  it("last_used_at is set and throttled to one write per minute", async () => {
    const a = await newAccount(t);
    const deps = makeDeps(t, clock);
    await call(deps, "GET", "/api/v1/payments", { auth: a.auth });
    const first = (await t.prisma.apiCredential.findUniqueOrThrow({ where: { id: a.credentialId } })).lastUsedAt;
    expect(first).not.toBeNull();
    clock.t += 5_000;
    await call(deps, "GET", "/api/v1/payments", { auth: a.auth });
    expect((await t.prisma.apiCredential.findUniqueOrThrow({ where: { id: a.credentialId } })).lastUsedAt?.getTime()).toBe(first!.getTime());
    clock.t += 120_000;
    await call(deps, "GET", "/api/v1/payments", { auth: a.auth });
    expect((await t.prisma.apiCredential.findUniqueOrThrow({ where: { id: a.credentialId } })).lastUsedAt!.getTime()).toBeGreaterThan(first!.getTime());
  });

  it("failed-authentication abuse: an address is blocked after repeated failures; other addresses are unaffected", async () => {
    const a = await newAccount(t);
    const deps = makeDeps(t, clock, { authFailureLimits: { ip: 3, clientId: 1000, global: 100000 } });
    const ip = `203.0.113.${t.runId}-ip`;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await call(deps, "GET", "/api/v1/payments", { auth: basic(`sbx_cid_x${t.runId}`, "y"), ip })).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    const blocked = await call(deps, "GET", "/api/v1/payments", { auth: a.auth, ip });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("too_many_failed_attempts");
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect((await call(deps, "GET", "/api/v1/payments", { auth: a.auth, ip: `198.51.100.${Math.floor(Math.random() * 200) + 1}` })).status).toBe(200);
    await t.sql("DELETE FROM auth_failure_windows WHERE scope = 'ip' AND bucket = $1", [sha(`ip:${ip}`)]);
    await t.sql("DELETE FROM auth_failure_windows WHERE scope = 'client_id' AND bucket = $1", [sha(`cid:sbx_cid_x${t.runId}`)]);
  });

  it("failed-authentication abuse: guessing one client id from many addresses is cut off with 429", async () => {
    const deps = makeDeps(t, clock, { authFailureLimits: { ip: 1000, clientId: 3, global: 100000 } });
    const clientId = `sbx_cid_${t.runId}`;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await call(deps, "GET", "/api/v1/payments", { auth: basic(clientId, "guess"), ip: `192.0.2.${i + 1}` })).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    await t.sql("DELETE FROM auth_failure_windows WHERE scope = 'client_id' AND bucket = $1", [sha(`cid:${clientId}`)]);
    for (let i = 0; i < 5; i++) await t.sql("DELETE FROM auth_failure_windows WHERE scope = 'ip' AND bucket = $1", [sha(`ip:192.0.2.${i + 1}`)]);
  });

  it("per-user rate limit returns 429 with Retry-After and rate-limit headers; other users are unaffected", async () => {
    const a = await newAccount(t), b = await newAccount(t);
    const deps = makeDeps(t, clock, { rateLimitPerMinute: 3 });
    const replies = [];
    for (let i = 0; i < 8; i++) replies.push(await call(deps, "GET", "/api/v1/payments", { auth: a.auth }));
    const limited = replies.filter((r) => r.status === 429);
    expect(replies[0]!.status).toBe(200);
    expect(replies[0]!.headers.get("x-ratelimit-remaining")).toMatch(/^[0-2]$/);
    expect(limited.length).toBeGreaterThanOrEqual(2); // holds even if the minute rolled over once
    expect(limited[0]!.json.error).toMatchObject({ type: "rate_limit_error", code: "rate_limited" });
    expect(Number(limited[0]!.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(limited[0]!.headers.get("x-ratelimit-remaining")).toBe("0");
    expect((await call(deps, "GET", "/api/v1/payments", { auth: b.auth })).status).toBe(200);
  });

  it("a session created with one user's credential is invisible to another user's credential (smoke; full matrix in sessions tests)", async () => {
    const a = await newAccount(t), b = await newAccount(t);
    const deps = makeDeps(t, clock);
    const s = await createSession(deps, a);
    expect(s.status).toBe(201);
    expect((await call(deps, "GET", `/api/v1/checkout/sessions/${s.json.id}`, { auth: b.auth })).status).toBe(404);
  });
});
