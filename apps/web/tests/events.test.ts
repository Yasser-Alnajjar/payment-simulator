import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPayment, lockSession } from "@/server/lifecycle";
import { attemptPaymentByToken } from "@/server/services/payments";
import { createTestDb, DB_TESTS_ENABLED, type Harness } from "./harness";
import { call, createSession, makeClock, makeDeps, newAccount, tokenOf, type Account } from "./api-helpers";

describe.skipIf(!DB_TESTS_ENABLED)("events, atomicity and account deletion (Hosted Supabase)", () => {
  let t: Harness;
  let a: Account, b: Account;
  const clock = makeClock();
  const deps = () => makeDeps(t, clock);
  beforeAll(async () => { t = await createTestDb(); a = await newAccount(t); b = await newAccount(t); });
  afterAll(async () => { await t?.close(); });

  it("events are returned byte-for-byte as persisted, newest first, with a documented envelope", async () => {
    const s = await createSession(deps(), a, { amount: "20.00", currency: "USD", external_reference: "evt-1", metadata: { k: "v" } });
    const p = (await attemptPaymentByToken(t.prisma, { token: tokenOf(s.json.url), scenario: "success" }, new Date(clock.t))).payment;
    const rows = await t.prisma.event.findMany({ where: { userId: a.userId }, orderBy: { seq: "desc" } });
    expect(rows.length).toBe(2);
    const list = await call(deps(), "GET", "/api/v1/events", { auth: a.auth });
    expect(list.status).toBe(200);
    expect(list.text).toBe(`{"object":"list","data":[${rows.map((r) => r.payload).join(",")}],"has_more":false}`);
    const one = await call(deps(), "GET", `/api/v1/events/evt_${rows[1]!.id}`, { auth: a.auth });
    expect(one.text).toBe(rows[1]!.payload);
    expect(one.json).toMatchObject({
      id: `evt_${rows[1]!.id}`, object: "event", type: "payment.succeeded", api_version: "2026-11-01",
      data: { payment_id: `pay_${p.id}`, checkout_session_id: s.json.id, external_reference: "evt-1", amount: "20.00", amount_minor: 2000, currency: "USD", status: "succeeded", failure_code: null, metadata: { k: "v" } },
    });
    expect(Object.keys(one.json)).toEqual(["id", "object", "type", "created", "api_version", "data"]);
    const types = await call(deps(), "GET", "/api/v1/events?type=checkout.session.completed", { auth: a.auth });
    expect(types.json.data.map((e: { type: string }) => e.type)).toEqual(["checkout.session.completed"]);
    const page = await call(deps(), "GET", `/api/v1/events?limit=1&starting_after=evt_${rows[0]!.id}`, { auth: a.auth });
    expect(page.json.data.map((e: { id: string }) => e.id)).toEqual([`evt_${rows[1]!.id}`]);
    expect((await call(deps(), "GET", "/api/v1/events?type=nope", { auth: a.auth })).status).toBe(400);
  });

  it("events are isolated per user", async () => {
    const rows = await t.prisma.event.findMany({ where: { userId: a.userId }, take: 1 });
    expect((await call(deps(), "GET", `/api/v1/events/evt_${rows[0]!.id}`, { auth: b.auth })).status).toBe(404);
    expect((await call(deps(), "GET", "/api/v1/events", { auth: b.auth })).json.data).toEqual([]);
    expect((await call(deps(), "GET", `/api/v1/events?starting_after=evt_${rows[0]!.id}`, { auth: b.auth })).status).toBe(400);
  });

  it("events cannot be updated (trigger) and a duplicate (user, subject, type) is rejected by the database", async () => {
    const e = await t.prisma.event.findFirstOrThrow({ where: { userId: a.userId } });
    await expect(t.sql("UPDATE events SET payload = 'x' WHERE id = $1", [e.id])).rejects.toThrow(/immutable/);
    await expect(t.prisma.event.update({ where: { id: e.id }, data: { payload: "x" } })).rejects.toThrow();
    // TRUNCATE is never executed on the shared hosted database; its guard is asserted from the catalog.
    const g = await t.sql("select tgenabled, pg_get_triggerdef(oid) def from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'events_guard_truncate'");
    expect(g.rows[0].tgenabled).toBe("O");
    expect(g.rows[0].def).toMatch(/BEFORE TRUNCATE/);
    const del = await t.sql("select pg_get_triggerdef(oid) def from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'events_guard_row'");
    expect(del.rows[0].def).not.toMatch(/DELETE/);
  });

  it("event persistence is atomic with the state change: a failure after the payment insert leaves no payment and no event", async () => {
    const s = await createSession(deps(), a);
    const sid = s.json.id.slice(3);
    const eventsBefore = await t.prisma.event.count({ where: { userId: a.userId } });
    await expect(
      t.prisma.$transaction(async (tx) => {
        const row = await lockSession(tx, a.userId, sid);
        await createPayment(tx, row!, "success", 5, new Date(clock.t));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await t.prisma.transaction.count({ where: { checkoutSessionId: sid } })).toBe(0);
    expect(await t.prisma.event.count({ where: { userId: a.userId } })).toBe(eventsBefore);
    expect((await t.prisma.checkoutSession.findUniqueOrThrow({ where: { id: sid } })).status).toBe("open");
  });

  it("account deletion cascades through every user-owned table (no immutability trigger blocks it); audit rows stay", async () => {
    const c = await newAccount(t);
    const s = await createSession(deps(), c, {}, { "idempotency-key": `del-${t.runId}` });
    await attemptPaymentByToken(t.prisma, { token: tokenOf(s.json.url), scenario: "success" }, new Date(clock.t));
    const s2 = await createSession(deps(), c);
    await attemptPaymentByToken(t.prisma, { token: tokenOf(s2.json.url), scenario: "pending" }, new Date(clock.t));
    expect((await call(deps(), "GET", "/api/v1/payments", { auth: c.auth })).status).toBe(200); // creates a rate-limit window row
    const count = async (table: string) => Number((await t.sql(`select count(*)::int n from ${table} where user_id = $1`, [c.userId])).rows[0].n);
    for (const table of ["checkout_sessions", "transactions", "events", "idempotency_keys", "api_rate_limits", "api_credentials"]) expect(await count(table), table).toBeGreaterThan(0);
    const auditBefore = await count("audit_logs");
    expect(auditBefore).toBeGreaterThan(0);
    const other = await count("checkout_sessions");
    expect(other).toBe(2);
    await t.deleteAuthUser(c.userId);
    for (const table of ["checkout_sessions", "transactions", "events", "idempotency_keys", "api_rate_limits", "api_credentials"]) expect(await count(table), table).toBe(0);
    expect(await count("audit_logs")).toBe(auditBefore);
    // other users untouched
    expect(await t.prisma.event.count({ where: { userId: a.userId } })).toBeGreaterThan(0);
  });
});
