import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attemptSetupByToken } from "@/server/services/setup-sessions";
import { call, ENC_KEY, makeClock, makeDeps, newAccount, tokenOf, type Account } from "./api-helpers";
import { createTestDb, DB_TESTS_ENABLED } from "./harness";

/**
 * S6 gap tests (hosted database, rule R-DB-1): saved-card, setup-session and charge paths through the real handlers.
 * Cross-tenant access, concurrency, idempotency and "no card data at rest".
 */
const GOOD = { number: "4242424242424242", exp_month: 12, exp_year: 2031, cvc: "123" };
const GOOD2 = { number: "5555555555554444", exp_month: 12, exp_year: 2031, cvc: "123" };
const DECLINE = { number: "4000000000000002", exp_month: 12, exp_year: 2031, cvc: "123" };
const SETUP_DECLINED = { number: "4000000000000341", exp_month: 12, exp_year: 2031, cvc: "123" };

describe.skipIf(!DB_TESTS_ENABLED)("saved cards, setup sessions and charges (Hosted Supabase)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const clock = makeClock();
  let deps: ReturnType<typeof makeDeps>;
  beforeAll(async () => { t = await createTestDb(); deps = makeDeps(t, clock, { rateLimitPerMinute: 100_000 } as never); });
  afterAll(async () => { await t?.close(); });

  const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? `other:${(e as Error).message}`; } };
  const addCard = (a: Account, customer: string, card: Record<string, unknown> = GOOD, extra: Record<string, unknown> = {}) =>
    call(deps, "POST", "/api/v1/payment-methods", { auth: a.auth, body: { customer, card, ...extra } });
  const charge = (a: Account, pm: string, key: string, extra: Record<string, unknown> = {}) =>
    call(deps, "POST", "/api/v1/payments", { auth: a.auth, body: { payment_method: pm, amount: "10.00", currency: "USD", ...extra }, headers: { "idempotency-key": key } });
  const newSetup = async (a: Account, customer: string) => {
    const r = await call(deps, "POST", "/api/v1/checkout/sessions", { auth: a.auth, body: { mode: "setup", customer } });
    expect(r.status).toBe(201);
    return { id: r.json.id as string, token: tokenOf(r.json.url as string) };
  };

  it("saves a card without storing the card number or security code anywhere in the row or its events", async () => {
    const a = await newAccount(t);
    const r = await addCard(a, "cust_rest");
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ object: "payment_method", status: "active", is_default: true, card: { brand: "visa", last4: "4242" } });
    expect(r.text).not.toContain(GOOD.number);
    const rows = await t.sql("select row_to_json(p)::text as j from payment_methods p where user_id = $1", [a.userId]);
    const evs = await t.sql("select payload::text as j from events where user_id = $1", [a.userId]);
    for (const x of [...rows.rows, ...evs.rows]) {
      expect(x.j).not.toContain(GOOD.number);
      expect(x.j).not.toMatch(/"cvc"|cvv/i);
    }
    expect((await t.sql("select count(*)::int n from events where user_id = $1 and type = 'payment_method.created'", [a.userId])).rows[0].n).toBe(1);
  });

  it("a second user gets 404 on every operation against another user's payment method and setup session", async () => {
    const a = await newAccount(t), b = await newAccount(t);
    const pm = (await addCard(a, "cust_a")).json.id as string;
    const setup = await newSetup(a, "cust_a");
    for (const [m, p] of [["GET", `/api/v1/payment-methods/${pm}`], ["POST", `/api/v1/payment-methods/${pm}/default`], ["POST", `/api/v1/payment-methods/${pm}/disable`], ["DELETE", `/api/v1/payment-methods/${pm}`], ["GET", `/api/v1/checkout/sessions/${setup.id}`], ["POST", `/api/v1/checkout/sessions/${setup.id}/cancel`]] as const) {
      const r = await call(deps, m, p, { auth: b.auth });
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.json.error.code).toBe("resource_not_found");
    }
    const ch = await charge(b, pm, "xt-1");
    expect(ch.status).toBe(404);
    expect((await call(deps, "GET", "/api/v1/payment-methods", { auth: b.auth })).json.data).toEqual([]);
    expect((await call(deps, "GET", "/api/v1/payment-methods?customer=cust_a", { auth: b.auth })).json.data).toEqual([]);
    // Nothing changed for the owner.
    expect((await call(deps, "GET", `/api/v1/payment-methods/${pm}`, { auth: a.auth })).json).toMatchObject({ status: "active", is_default: true });
    expect((await call(deps, "GET", `/api/v1/checkout/sessions/${setup.id}`, { auth: a.auth })).json.status).toBe("open");
    expect((await t.sql("select count(*)::int n from transactions where user_id = any($1::uuid[])", [[a.userId, b.userId]])).rows[0].n).toBe(0);
  });

  it("a setup session completes exactly once under concurrent attempts and cannot be reused or cancelled afterwards", async () => {
    const a = await newAccount(t);
    const s = await newSetup(a, "cust_setup");
    const cards = [GOOD, GOOD2, { ...GOOD, number: "6011111111111117" }, { ...GOOD, number: "378282246310005", cvc: "1234" }, { ...GOOD, number: "5078030000000003" }, { ...GOOD, number: "4242424242424242", name: "Dup" }];
    const results = await Promise.allSettled(cards.map((card) => attemptSetupByToken(t.prisma, { encKey: ENC_KEY }, { token: s.token, card }, new Date(clock.t))));
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as { status?: number }).status, "losers get a client error, not a server error").toBeLessThan(500);
    const row = await t.prisma.setupSession.findFirstOrThrow({ where: { userId: a.userId } });
    expect(row.status).toBe("completed");
    expect(await t.prisma.paymentMethod.count({ where: { userId: a.userId, customerReference: "cust_setup", deletedAt: null } })).toBe(1);
    expect((await t.sql("select count(*)::int n from events where user_id = $1 and type = 'payment_method.created'", [a.userId])).rows[0].n).toBe(1);
    // A completed session cannot be used again, and cancel does not undo it.
    expect(await code(attemptSetupByToken(t.prisma, { encKey: ENC_KEY }, { token: s.token, card: GOOD2 }, new Date(clock.t)))).not.toBe("ok");
    await call(deps, "POST", `/api/v1/checkout/sessions/${s.id}/cancel`, { auth: a.auth });
    expect((await call(deps, "GET", `/api/v1/checkout/sessions/${s.id}`, { auth: a.auth })).json.status).toBe("completed");
  });

  it("a card refused at setup is never saved; a cancelled or expired setup session cannot save a card", async () => {
    const a = await newAccount(t);
    const s1 = await newSetup(a, "cust_refuse");
    expect(await code(attemptSetupByToken(t.prisma, { encKey: ENC_KEY }, { token: s1.token, card: SETUP_DECLINED }, new Date(clock.t)))).toBe("card_declined");
    expect(await t.prisma.paymentMethod.count({ where: { userId: a.userId } })).toBe(0);
    expect((await call(deps, "GET", `/api/v1/checkout/sessions/${s1.id}`, { auth: a.auth })).json).toMatchObject({ status: "open", failure_code: "card_declined" });
    const s2 = await newSetup(a, "cust_cancel");
    await call(deps, "POST", `/api/v1/checkout/sessions/${s2.id}/cancel`, { auth: a.auth });
    expect(await code(attemptSetupByToken(t.prisma, { encKey: ENC_KEY }, { token: s2.token, card: GOOD }, new Date(clock.t)))).not.toBe("ok");
    const s3 = await newSetup(a, "cust_expire");
    expect(await code(attemptSetupByToken(t.prisma, { encKey: ENC_KEY }, { token: s3.token, card: GOOD }, new Date(clock.t + 3 * 3600_000)))).not.toBe("ok");
    expect(await t.prisma.paymentMethod.count({ where: { userId: a.userId } })).toBe(0);
  });

  it("concurrent set-default calls leave exactly one default per customer", async () => {
    const a = await newAccount(t);
    const ids: string[] = [];
    for (const c of [GOOD, GOOD2, { ...GOOD, number: "6011111111111117" }, { ...GOOD, number: "5078030000000003" }]) ids.push((await addCard(a, "cust_def", c)).json.id);
    const rs = await Promise.all(ids.flatMap((id) => [id, id]).map((id) => call(deps, "POST", `/api/v1/payment-methods/${id}/default`, { auth: a.auth })));
    for (const r of rs) expect([200, 409]).toContain(r.status);
    const rows = await t.prisma.paymentMethod.findMany({ where: { userId: a.userId, customerReference: "cust_def", deletedAt: null } });
    expect(rows.filter((m) => m.isDefault)).toHaveLength(1);
    expect((await call(deps, "GET", "/api/v1/payment-methods/default?customer=cust_def", { auth: a.auth })).status).toBe(200);
  });

  it("concurrent creates of the same card for one customer save it once (duplicate is refused)", async () => {
    const a = await newAccount(t);
    const rs = await Promise.all(Array.from({ length: 6 }, () => addCard(a, "cust_dup")));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of rs) if (r.status !== 201) expect(r.status).toBe(409);
    expect(await t.prisma.paymentMethod.count({ where: { userId: a.userId, customerReference: "cust_dup", deletedAt: null } })).toBe(1);
  });

  it("charges: success, decline, replay with the same key, key reuse with another body, and concurrent identical requests", async () => {
    const a = await newAccount(t);
    const good = (await addCard(a, "cust_ch")).json.id as string;
    const bad = (await addCard(a, "cust_ch", DECLINE)).json.id as string;
    const ok = await charge(a, good, "ch-ok");
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ object: "payment", status: "succeeded", amount: "10.00", currency: "USD", payment_method: good, customer: "cust_ch" });
    const declined = await charge(a, bad, "ch-bad");
    expect(declined.status).toBe(201);
    expect(declined.json).toMatchObject({ status: "failed", failure_code: "card_declined" });
    const replay = await charge(a, good, "ch-ok");
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json.id).toBe(ok.json.id);
    const reuse = await charge(a, good, "ch-ok", { amount: "11.00" });
    expect(reuse.status).toBe(422);
    expect(reuse.json.error.code).toBe("idempotency_key_reused");
    const noKey = await call(deps, "POST", "/api/v1/payments", { auth: a.auth, body: { payment_method: good, amount: "1.00", currency: "USD" } });
    expect(noKey.status).toBe(400);
    const rs = await Promise.all(Array.from({ length: 8 }, () => charge(a, good, "ch-race")));
    const created = new Set(rs.filter((r) => r.status === 201).map((r) => r.json.id));
    expect(created.size).toBe(1);
    for (const r of rs) expect([201, 409]).toContain(r.status);
    expect((await t.sql("select count(*)::int n from transactions where user_id = $1 and payment_method_id is not null", [a.userId])).rows[0].n).toBe(3); // ok, declined, race
  });

  it("a disabled or deleted payment method cannot be charged, and a charge racing a delete leaves consistent state", async () => {
    const a = await newAccount(t);
    const pm = (await addCard(a, "cust_race")).json.id as string;
    const pm2 = (await addCard(a, "cust_race", GOOD2)).json.id as string;
    expect((await call(deps, "POST", `/api/v1/payment-methods/${pm2}/disable`, { auth: a.auth })).status).toBe(200);
    const onDisabled = await charge(a, pm2, "dis-1");
    expect(onDisabled.status).toBeGreaterThanOrEqual(400);
    expect((await t.sql("select count(*)::int n from transactions where user_id = $1", [a.userId])).rows[0].n).toBe(0);
    const [del, ...ch] = await Promise.all([
      call(deps, "DELETE", `/api/v1/payment-methods/${pm}`, { auth: a.auth }),
      ...Array.from({ length: 5 }, (_, i) => charge(a, pm, `race-${i}`)),
    ]);
    expect(del.status).toBe(200);
    for (const r of ch) expect([201, 404, 409, 422]).toContain(r.status);
    // Every succeeded charge was committed before the deletion became visible; afterwards the method is gone for good.
    expect((await charge(a, pm, "after-delete")).status).toBe(404);
    expect(await t.prisma.paymentMethod.count({ where: { userId: a.userId, customerReference: "cust_race", deletedAt: null, status: "active" } })).toBe(0);
  });

  it("a user cannot charge a payment method belonging to a different customer reference when one is stated", async () => {
    const a = await newAccount(t);
    const pm = (await addCard(a, "cust_one")).json.id as string;
    const r = await charge(a, pm, "wrong-cust", { customer: "cust_two" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await t.sql("select count(*)::int n from transactions where user_id = $1", [a.userId])).rows[0].n).toBe(0);
  });
});
