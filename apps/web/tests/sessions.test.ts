import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createTestDb, DB_TESTS_ENABLED, type Harness } from "./harness";
import { call, createSession, makeClock, makeDeps, newAccount, tokenOf, type Account } from "./api-helpers";

describe.skipIf(!DB_TESTS_ENABLED)("checkout sessions API (Hosted Supabase)", () => {
  let t: Harness;
  let a: Account, b: Account;
  const clock = makeClock();
  const deps = () => makeDeps(t, clock);
  beforeAll(async () => { t = await createTestDb(); a = await newAccount(t); b = await newAccount(t); });
  afterAll(async () => { await t?.close(); });

  it("creates a session: decimal-string amount, exponents, token only as a hash, safe DTO", async () => {
    const r = await createSession(deps(), a, { amount: "149.00", currency: "USD", external_reference: "order-1", metadata: { plan: "pro" }, scenario: "success" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ object: "checkout.session", status: "open", amount: "149.00", amount_minor: 14900, currency: "USD", external_reference: "order-1", metadata: { plan: "pro" }, scenario: "success" });
    expect(r.json.id).toMatch(/^cs_[0-9a-f-]{36}$/);
    expect(r.json.url).toMatch(/^http:\/\/localhost:3100\/checkout\/sbx_cs_/);
    expect(Object.keys(r.json)).not.toEqual(expect.arrayContaining(["user_id", "token_hash", "seq"]));
    const row = await t.prisma.checkoutSession.findFirstOrThrow({ where: { userId: a.userId, externalReference: "order-1" } });
    const token = tokenOf(r.json.url);
    expect(row.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row, (_, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(token);
    expect(row.amountMinor).toBe(14900n);
    expect(new Date(r.json.expires_at).getTime() - new Date(r.json.created).getTime()).toBe(1800_000);
    expect((await t.prisma.auditLog.findMany({ where: { userId: a.userId, action: "checkout_session.created" } })).length).toBeGreaterThanOrEqual(1);
  });

  it("zero- and three-decimal currencies", async () => {
    const j = await createSession(deps(), a, { amount: "1500", currency: "JPY" });
    expect(j.json).toMatchObject({ amount: "1500", amount_minor: 1500 });
    const k = await createSession(deps(), a, { amount: "1.234", currency: "KWD" });
    expect(k.json).toMatchObject({ amount: "1.234", amount_minor: 1234 });
    expect((await createSession(deps(), a, { amount: "1.5", currency: "JPY" })).json.error).toMatchObject({ code: "too_many_decimals", param: "amount" });
  });

  it("rejects invalid input with the error envelope and request id", async () => {
    const bad: [Record<string, unknown>, string, number][] = [
      [{ amount: 10 }, "invalid_parameter", 400],
      [{ amount: "10.001" }, "too_many_decimals", 400],
      [{ amount: "-5" }, "invalid_amount_format", 400],
      [{ amount: "0.00" }, "amount_too_small", 400],
      [{ amount: "10000000000.01" }, "amount_too_large", 400],
      [{ currency: "usd" }, "unsupported_currency", 400],
      [{ currency: "XXX" }, "unsupported_currency", 400],
      [{ user_id: "00000000-0000-0000-0000-000000000000" }, "unknown_parameter", 400],
      [{ amount_minor: 1 }, "unknown_parameter", 400],
      [{ status: "completed" }, "unknown_parameter", 400],
      [{ expires_in: 10 }, "invalid_parameter", 400],
      [{ expires_in: 999999 }, "invalid_parameter", 400],
      [{ scenario: "nope" }, "invalid_parameter", 400],
      [{ metadata: { "bad key!": "x" } }, "invalid_parameter", 400],
      [{ metadata: { k: "x".repeat(501) } }, "invalid_parameter", 400],
      [{ metadata: { k: 1 } }, "invalid_parameter", 400],
      [{ metadata: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, "v"])) }, "invalid_parameter", 400],
      [{ external_reference: "" }, "invalid_parameter", 400],
      [{ external_reference: "a".repeat(256) }, "invalid_parameter", 400],
    ];
    for (const [patch, code, status] of bad) {
      const r = await createSession(deps(), a, patch);
      expect(r.status, JSON.stringify(patch).slice(0, 60)).toBe(status);
      expect(r.json.error.code, JSON.stringify(patch).slice(0, 60)).toBe(code);
      expect(r.json.error.request_id).toBe(r.headers.get("request-id"));
      expect(r.json.error.type).toBe("invalid_request_error");
    }
  });

  it("enforces body size, content type and JSON shape", async () => {
    const big = await call(deps(), "POST", "/api/v1/checkout/sessions", { auth: a.auth, rawBody: JSON.stringify({ amount: "1", currency: "USD", metadata: { k: "x".repeat(70_000) } }) });
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe("body_too_large");
    expect((await call(deps(), "POST", "/api/v1/checkout/sessions", { auth: a.auth, rawBody: "amount=1", headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await call(deps(), "POST", "/api/v1/checkout/sessions", { auth: a.auth, rawBody: "{not json" })).json.error.code).toBe("invalid_json");
    expect((await call(deps(), "POST", "/api/v1/checkout/sessions", { auth: a.auth, rawBody: "[1]" })).json.error.code).toBe("invalid_json");
    expect((await call(deps(), "POST", "/api/v1/checkout/sessions", { auth: a.auth, rawBody: "" })).json.error.code).toBe("invalid_json");
    const none = await call(deps(), "POST", "/api/v1/checkout/sessions", { auth: a.auth });
    expect(none.status).toBe(415); // no body, no content type
  });

  it("retrieves, lists with filters and keyset pagination, newest first", async () => {
    const c = await newAccount(t);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await createSession(deps(), c, { external_reference: i % 2 ? "odd" : "even" })).json.id);
    const one = await call(deps(), "GET", `/api/v1/checkout/sessions/${ids[0]}`, { auth: c.auth });
    expect(one.status).toBe(200);
    expect(one.json.url).toBeUndefined(); // the token is never returned again
    const p1 = await call(deps(), "GET", "/api/v1/checkout/sessions?limit=2", { auth: c.auth });
    expect(p1.json.data.map((s: { id: string }) => s.id)).toEqual([ids[4], ids[3]]);
    expect(p1.json.has_more).toBe(true);
    const p2 = await call(deps(), "GET", `/api/v1/checkout/sessions?limit=2&starting_after=${ids[3]}`, { auth: c.auth });
    expect(p2.json.data.map((s: { id: string }) => s.id)).toEqual([ids[2], ids[1]]);
    const p3 = await call(deps(), "GET", `/api/v1/checkout/sessions?limit=2&starting_after=${ids[1]}`, { auth: c.auth });
    expect(p3.json).toMatchObject({ has_more: false });
    expect(p3.json.data.map((s: { id: string }) => s.id)).toEqual([ids[0]]);
    const odd = await call(deps(), "GET", "/api/v1/checkout/sessions?external_reference=odd", { auth: c.auth });
    expect(odd.json.data.length).toBe(2);
    expect((await call(deps(), "GET", "/api/v1/checkout/sessions?status=cancelled", { auth: c.auth })).json.data).toEqual([]);
    for (const q of ["limit=0", "limit=101", "limit=abc", "status=bogus", "unknown=1", "starting_after=cs_00000000-0000-0000-0000-000000000000"]) {
      expect((await call(deps(), "GET", `/api/v1/checkout/sessions?${q}`, { auth: c.auth })).status, q).toBe(400);
    }
  });

  it("cross-user isolation: another user's ids behave exactly like missing ones, everywhere", async () => {
    const s = await createSession(deps(), a, { scenario: "pending" });
    const missing = "cs_00000000-0000-4000-8000-000000000000";
    for (const [method, path] of [["GET", `/api/v1/checkout/sessions/${s.json.id}`], ["POST", `/api/v1/checkout/sessions/${s.json.id}/cancel`]] as const) {
      const foreign = await call(deps(), method, path, { auth: b.auth });
      const none = await call(deps(), method, path.replace(s.json.id, missing), { auth: b.auth });
      expect(foreign.status).toBe(404);
      expect({ ...foreign.json.error, request_id: "" }).toEqual({ ...none.json.error, request_id: "" });
    }
    expect((await call(deps(), "GET", `/api/v1/checkout/sessions?starting_after=${s.json.id}`, { auth: b.auth })).status).toBe(400);
    expect((await call(deps(), "GET", "/api/v1/checkout/sessions", { auth: b.auth })).json.data.some((x: { id: string }) => x.id === s.json.id)).toBe(false);
    expect((await call(deps(), "GET", `/api/v1/checkout/sessions/${s.json.id}`, { auth: a.auth })).json.status).toBe("open");
    for (const bad of ["x", "cs_", "cs_zzz", "../x", "pay_00000000-0000-4000-8000-000000000000", "CS_00000000-0000-4000-8000-000000000000"]) {
      expect((await call(deps(), "GET", `/api/v1/checkout/sessions/${encodeURIComponent(bad)}`, { auth: a.auth })).status, bad).toBe(404);
    }
  });

  it("cancels an open session; repeating is idempotent; a cancelled session stays cancelled", async () => {
    const s = await createSession(deps(), a);
    const c1 = await call(deps(), "POST", `/api/v1/checkout/sessions/${s.json.id}/cancel`, { auth: a.auth });
    expect(c1.status).toBe(200);
    expect(c1.json.status).toBe("cancelled");
    const c2 = await call(deps(), "POST", `/api/v1/checkout/sessions/${s.json.id}/cancel`, { auth: a.auth });
    expect(c2.status).toBe(200);
    expect(c2.json.status).toBe("cancelled");
    const events = await t.prisma.event.findMany({ where: { userId: a.userId, subjectId: s.json.id.slice(3) } });
    expect(events.map((e) => e.type)).toEqual(["checkout.session.cancelled"]);
    expect((await t.prisma.auditLog.count({ where: { userId: a.userId, action: "checkout_session.cancelled", targetId: s.json.id.slice(3) } }))).toBe(1);
  });

  it("expiration: an open session past expires_at becomes expired on read, list and cancel, with one event", async () => {
    const local = { t: Date.now() };
    const d = makeDeps(t, local);
    const s1 = await createSession(d, a, { expires_in: 300 });
    const s2 = await createSession(d, a, { expires_in: 300 });
    const s3 = await createSession(d, a, { expires_in: 300 });
    expect((await call(d, "GET", `/api/v1/checkout/sessions/${s1.json.id}`, { auth: a.auth })).json.status).toBe("open");
    local.t += 301_000;
    expect((await call(d, "GET", `/api/v1/checkout/sessions/${s1.json.id}`, { auth: a.auth })).json.status).toBe("expired");
    expect((await call(d, "GET", `/api/v1/checkout/sessions/${s1.json.id}`, { auth: a.auth })).json.status).toBe("expired");
    const cancel = await call(d, "POST", `/api/v1/checkout/sessions/${s2.json.id}/cancel`, { auth: a.auth });
    expect(cancel.status).toBe(409);
    expect(cancel.json.error.code).toBe("invalid_state_transition");
    const list = await call(d, "GET", "/api/v1/checkout/sessions?status=expired&limit=100", { auth: a.auth });
    expect(list.json.data.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining([s1.json.id, s2.json.id, s3.json.id]));
    for (const s of [s1, s2, s3]) {
      const ev = await t.prisma.event.findMany({ where: { userId: a.userId, subjectId: s.json.id.slice(3) } });
      expect(ev.map((e) => e.type)).toEqual(["checkout.session.expired"]);
    }
  });

  it("database constraints: amount/currency/token immutable, terminal sessions frozen, ownership and amount tied by composite FK", async () => {
    const s = await createSession(deps(), a, { amount: "5.00", currency: "EUR" });
    const id = s.json.id.slice(3);
    await expect(t.sql("UPDATE checkout_sessions SET amount_minor = 1 WHERE id = $1", [id])).rejects.toThrow(/immutable/);
    await expect(t.sql("UPDATE checkout_sessions SET currency = 'USD' WHERE id = $1", [id])).rejects.toThrow(/immutable/);
    await expect(t.sql("UPDATE checkout_sessions SET token_hash = 'x' WHERE id = $1", [id])).rejects.toThrow(/immutable/);
    await expect(t.sql("UPDATE checkout_sessions SET user_id = $2 WHERE id = $1", [id, b.userId])).rejects.toThrow();
    await t.sql("UPDATE checkout_sessions SET status = 'cancelled' WHERE id = $1", [id]);
    await expect(t.sql("UPDATE checkout_sessions SET status = 'open' WHERE id = $1", [id])).rejects.toThrow(/terminal/);
    await expect(t.sql("UPDATE checkout_sessions SET status = 'completed' WHERE id = $1", [id])).rejects.toThrow(/terminal/);
    const s2 = await createSession(deps(), a, { amount: "5.00", currency: "EUR" });
    const id2 = s2.json.id.slice(3);
    const ins = (uid: string, sess: string, amt: number, cur: string) => t.sql(
      "INSERT INTO transactions (id, user_id, checkout_session_id, amount_minor, currency, status, scenario) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'pending', 'pending')", [uid, sess, amt, cur]);
    await expect(ins(a.userId, id2, 999, "EUR")).rejects.toThrow(/transactions_session_fkey/); // wrong amount
    await expect(ins(a.userId, id2, 500, "USD")).rejects.toThrow(/transactions_session_fkey/); // wrong currency
    await expect(ins(b.userId, id2, 500, "EUR")).rejects.toThrow(/transactions_session_fkey/); // other owner
    await expect(ins(a.userId, id2, 500, "EUR")).resolves.toBeTruthy();
  });

  it("schema: RLS, no API-role grants, cascading owner FKs, indexes, hardened guard functions", async () => {
    const tables = ["checkout_sessions", "transactions", "events", "idempotency_keys", "api_rate_limits", "auth_failure_windows"];
    const rls = await t.sql("select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[]) order by 1", [tables]);
    expect(rls.rows.length).toBe(6);
    expect(rls.rows.every((r) => r.relrowsecurity === true)).toBe(true);
    const grants = await t.sql(`select c.relname, r.rolname from pg_class c cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
      where c.relnamespace = 'public'::regnamespace and c.relname = any($1::text[]) and (has_table_privilege(r.rolname, c.oid, 'SELECT') or has_table_privilege(r.rolname, c.oid, 'INSERT') or has_table_privilege(r.rolname, c.oid, 'UPDATE') or has_table_privilege(r.rolname, c.oid, 'DELETE'))`, [tables]);
    expect(grants.rows).toEqual([]);
    const fks = await t.sql("select conrelid::regclass::text tbl from pg_constraint where contype = 'f' and confrelid = 'auth.users'::regclass and confdeltype = 'c'");
    expect(fks.rows.map((r) => r.tbl).sort()).toEqual(expect.arrayContaining(["api_credentials", "checkout_sessions", "transactions", "events", "idempotency_keys", "api_rate_limits"]));
    const idx = await t.sql("select indexname from pg_indexes where schemaname = 'public'");
    const have = new Set(idx.rows.map((r) => r.indexname));
    for (const n of ["checkout_sessions_user_seq_idx", "checkout_sessions_user_status_seq_idx", "checkout_sessions_open_expiry_idx", "transactions_one_active_per_session", "transactions_user_seq_idx", "events_user_seq_idx", "events_user_type_seq_idx", "events_user_id_subject_id_type_key"]) expect(have.has(n), n).toBe(true);
    const fn = await t.sql("select proname, proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname like 'sandbox\\_%guard'");
    expect(fn.rows.length).toBe(4);
    expect(fn.rows.every((r) => JSON.stringify(r.proconfig) === '["search_path=\\"\\""]')).toBe(true);
  });
});
