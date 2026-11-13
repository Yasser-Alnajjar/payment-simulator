import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openBound } from "@sandbox/core";
import { createTestDb, DB_TESTS_ENABLED, type Harness } from "./harness";
import { call, createSession, ENC_KEY, makeClock, makeDeps, newAccount, tokenOf, type Account } from "./api-helpers";

describe.skipIf(!DB_TESTS_ENABLED)("idempotency (Hosted Supabase)", () => {
  let t: Harness;
  let a: Account, b: Account;
  const clock = makeClock();
  const deps = () => makeDeps(t, clock);
  beforeAll(async () => { t = await createTestDb(); a = await newAccount(t); b = await newAccount(t); });
  afterAll(async () => { await t?.close(); });
  const count = (userId: string) => t.prisma.checkoutSession.count({ where: { userId } });

  it("same key and same body replays the same response (same id, same checkout url) without creating anything", async () => {
    const h = { "idempotency-key": `k-${t.runId}-1` };
    const r1 = await createSession(deps(), a, { amount: "9.99", external_reference: "idem-1" }, h);
    const before = await count(a.userId);
    const r2 = await createSession(deps(), a, { external_reference: "idem-1", amount: "9.99" }, h); // key order differs: canonical body is equal
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect(r1.headers.get("idempotent-replayed")).toBeNull();
    expect(r2.json).toEqual(r1.json);
    expect(await count(a.userId)).toBe(before);
    expect(await t.prisma.auditLog.count({ where: { userId: a.userId, action: "checkout_session.created", targetId: r1.json.id.slice(3) } })).toBe(1);
  });

  it("same key with a different body is rejected with 422 and creates nothing", async () => {
    const h = { "idempotency-key": `k-${t.runId}-2` };
    await createSession(deps(), a, { amount: "1.00" }, h);
    const before = await count(a.userId);
    const r = await createSession(deps(), a, { amount: "2.00" }, h);
    expect(r.status).toBe(422);
    expect(r.json.error).toMatchObject({ type: "idempotency_error", code: "idempotency_key_reused" });
    expect(await count(a.userId)).toBe(before);
  });

  it("keys are scoped per user", async () => {
    const h = { "idempotency-key": `k-${t.runId}-3` };
    const ra = await createSession(deps(), a, { amount: "3.00" }, h);
    const rb = await createSession(deps(), b, { amount: "3.00" }, h);
    expect(ra.json.id).not.toBe(rb.json.id);
    expect(rb.headers.get("idempotent-replayed")).toBeNull();
  });

  it("failed requests do not consume the key", async () => {
    const h = { "idempotency-key": `k-${t.runId}-4` };
    expect((await createSession(deps(), a, { amount: "nope" }, h)).status).toBe(400);
    expect((await createSession(deps(), a, { amount: "4.00" }, h)).status).toBe(201);
  });

  it("rejects malformed keys", async () => {
    for (const k of ["", "a b", "x".repeat(256), "café"]) {
      const r = await call(deps(), "POST", "/api/v1/checkout/sessions", { auth: a.auth, body: { amount: "1", currency: "USD" }, headers: { "idempotency-key": k } });
      expect(r.status, k).toBe(400);
    }
  });

  it("keys expire after 24 hours: the old key is replaced by a fresh creation", async () => {
    const key = `k-${t.runId}-5`;
    const r1 = await createSession(deps(), a, { amount: "5.00" }, { "idempotency-key": key });
    await t.sql("UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE user_id = $1 AND key = $2", [a.userId, key]);
    const r2 = await createSession(deps(), a, { amount: "5.00" }, { "idempotency-key": key });
    expect(r2.status).toBe(201);
    expect(r2.headers.get("idempotent-replayed")).toBeNull();
    expect(r2.json.id).not.toBe(r1.json.id);
    const r3 = await createSession(deps(), a, { amount: "5.00" }, { "idempotency-key": key });
    expect(r3.json.id).toBe(r2.json.id);
  });

  it("the stored replay data holds no plaintext checkout token and cannot be opened for another record, owner or purpose", async () => {
    const key = `k-${t.runId}-6`;
    const r = await createSession(deps(), a, { amount: "6.00" }, { "idempotency-key": key });
    const token = tokenOf(r.json.url);
    const row = await t.prisma.idempotencyKey.findUniqueOrThrow({ where: { userId_key: { userId: a.userId, key } } });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row.response)).not.toContain("url");
    const sid = r.json.id.slice(3);
    const ctx = (u: string, k: string, s: string) => `${u}|${k}|${s}`;
    expect(openBound(row.tokenEnc, ENC_KEY, "idempotency-checkout-token", ctx(a.userId, key, sid))).toBe(token);
    expect(() => openBound(row.tokenEnc, ENC_KEY, "idempotency-checkout-token", ctx(b.userId, key, sid))).toThrow();
    expect(() => openBound(row.tokenEnc, ENC_KEY, "idempotency-checkout-token", ctx(a.userId, `${key}x`, sid))).toThrow();
    expect(() => openBound(row.tokenEnc, ENC_KEY, "idempotency-checkout-token", ctx(a.userId, key, "00000000-0000-4000-8000-000000000000"))).toThrow();
    expect(() => openBound(row.tokenEnc, ENC_KEY, "webhook-secret", ctx(a.userId, key, sid))).toThrow();
    // a ciphertext copied onto another key row cannot be replayed: the replay fails closed and leaks nothing
    const key2 = `k-${t.runId}-7`;
    await createSession(deps(), a, { amount: "7.00" }, { "idempotency-key": key2 });
    await t.sql("UPDATE idempotency_keys SET token_enc = $3 WHERE user_id = $1 AND key = $2", [a.userId, key2, row.tokenEnc]);
    const bad = await createSession(deps(), a, { amount: "7.00" }, { "idempotency-key": key2 });
    expect(bad.status).toBe(500);
    expect(bad.text).not.toContain(token);
  });

  it("concurrent requests with the same key create exactly one session and all return it", async () => {
    const key = `k-${t.runId}-8`;
    const before = await count(a.userId);
    const rs = await Promise.all(Array.from({ length: 8 }, () => createSession(deps(), a, { amount: "8.00" }, { "idempotency-key": key })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.json.id)).size).toBe(1);
    expect(new Set(rs.map((r) => r.json.url)).size).toBe(1);
    expect(rs.filter((r) => r.headers.get("idempotent-replayed") === null).length).toBe(1);
    expect(await count(a.userId)).toBe(before + 1);
  });

  it("concurrent requests with the same key but different bodies: one wins, the others get 422, one session exists", async () => {
    const key = `k-${t.runId}-9`;
    const before = await count(a.userId);
    const rs = await Promise.all(["11.00", "12.00", "13.00", "14.00"].map((amount) => createSession(deps(), a, { amount }, { "idempotency-key": key })));
    expect(rs.filter((r) => r.status === 201).length).toBe(1);
    expect(rs.filter((r) => r.status === 422).length).toBe(3);
    expect(await count(a.userId)).toBe(before + 1);
  });

  it("without a key, identical requests create distinct sessions", async () => {
    const r1 = await createSession(deps(), a, { amount: "15.00" });
    const r2 = await createSession(deps(), a, { amount: "15.00" });
    expect(r1.json.id).not.toBe(r2.json.id);
  });
});
