import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attemptPaymentByToken, resolvePendingPayment } from "@/server/services/payments";
import { createTestDb, DB_TESTS_ENABLED, type Harness } from "./harness";
import { call, createSession, makeDeps, newAccount, tokenOf, type Account, type Clock } from "./api-helpers";

describe.skipIf(!DB_TESTS_ENABLED)("concurrency (Hosted Supabase)", () => {
  let t: Harness;
  let a: Account;
  const clock: Clock = { t: Date.now() };
  const deps = () => makeDeps(t, clock);
  const now = () => new Date(clock.t);
  beforeAll(async () => { t = await createTestDb(); a = await newAccount(t); });
  afterAll(async () => { await t?.close(); });
  const settled = (ps: Promise<unknown>[]) => Promise.allSettled(ps);
  const ok = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r) => r.status === "fulfilled").length;
  const events = async (subject: string) => (await t.prisma.event.findMany({ where: { subjectId: subject }, orderBy: { seq: "asc" } })).map((e) => e.type);

  it("parallel payment attempts on one session: exactly one wins; one active payment; one event", async () => {
    const s = await createSession(deps(), a);
    const token = tokenOf(s.json.url);
    const rs = await settled(Array.from({ length: 8 }, () => attemptPaymentByToken(t.prisma, { token, scenario: "success" }, now())));
    expect(ok(rs)).toBe(1);
    for (const r of rs) if (r.status === "rejected") expect(["session_already_paid", "payment_in_progress"]).toContain((r.reason as { code: string }).code);
    const sid = s.json.id.slice(3);
    const payments = await t.prisma.transaction.findMany({ where: { checkoutSessionId: sid } });
    expect(payments.length).toBe(1);
    expect(await events(payments[0]!.id)).toEqual(["payment.succeeded"]);
    expect(await events(sid)).toEqual(["checkout.session.completed"]);
  });

  it("parallel mixed outcomes (pending/decline/cancel/success): at most one pending-or-succeeded payment ever exists", async () => {
    const s = await createSession(deps(), a);
    const token = tokenOf(s.json.url);
    const scenarios = ["pending", "success", "decline", "cancel", "pending", "success"] as const;
    await settled(scenarios.map((scenario) => attemptPaymentByToken(t.prisma, { token, scenario }, now())));
    const rows = await t.prisma.transaction.findMany({ where: { checkoutSessionId: s.json.id.slice(3) } });
    expect(rows.filter((r) => r.status === "pending" || r.status === "succeeded").length).toBeLessThanOrEqual(1);
    for (const r of rows) expect(await events(r.id)).toEqual([`payment.${r.status}`]); // exactly one event per payment, matching its state
    const sess = await t.prisma.checkoutSession.findUniqueOrThrow({ where: { id: s.json.id.slice(3) } });
    expect(sess.status === "completed").toBe(rows.some((r) => r.status === "succeeded"));
  });

  it("cancel racing a payment attempt ends consistent (never a succeeded payment on a cancelled session)", async () => {
    for (let i = 0; i < 4; i++) {
      const s = await createSession(deps(), a);
      const token = tokenOf(s.json.url);
      await settled([
        attemptPaymentByToken(t.prisma, { token, scenario: "success" }, now()),
        call(deps(), "POST", `/api/v1/checkout/sessions/${s.json.id}/cancel`, { auth: a.auth }),
      ]);
      const sid = s.json.id.slice(3);
      const sess = await t.prisma.checkoutSession.findUniqueOrThrow({ where: { id: sid } });
      const pays = await t.prisma.transaction.findMany({ where: { checkoutSessionId: sid } });
      expect(["completed", "cancelled"]).toContain(sess.status);
      if (sess.status === "cancelled") expect(pays.every((p) => p.status !== "succeeded")).toBe(true);
      else expect(pays.map((p) => p.status)).toEqual(["succeeded"]);
      const sessEvents = await events(sid);
      expect(sessEvents.length).toBe(1);
    }
  });

  it("parallel resolutions of one pending payment: exactly one transition, one event", async () => {
    const s = await createSession(deps(), a);
    const p = (await attemptPaymentByToken(t.prisma, { token: tokenOf(s.json.url), scenario: "pending" }, now())).payment;
    const rs = await settled([
      resolvePendingPayment(t.prisma, a.userId, `pay_${p.id}`, "succeeded", now()),
      resolvePendingPayment(t.prisma, a.userId, `pay_${p.id}`, "failed", now()),
      resolvePendingPayment(t.prisma, a.userId, `pay_${p.id}`, "cancelled", now()),
      resolvePendingPayment(t.prisma, a.userId, `pay_${p.id}`, "succeeded", now()),
    ]);
    expect(ok(rs)).toBe(1);
    const final = await t.prisma.transaction.findUniqueOrThrow({ where: { id: p.id } });
    expect(final.version).toBe(2);
    expect((await events(p.id)).length).toBe(2);
  });

  it("parallel reads after a due resolution emit each event exactly once", async () => {
    const local: Clock = { t: Date.now() };
    const d = makeDeps(t, local);
    const s = await createSession(d, a);
    const p = (await attemptPaymentByToken(t.prisma, { token: tokenOf(s.json.url), scenario: "pending_then_success", delaySeconds: 5 }, new Date(local.t))).payment;
    local.t += 6_000;
    const rs = await Promise.all(Array.from({ length: 6 }, () => call(d, "GET", `/api/v1/payments/pay_${p.id}`, { auth: a.auth })));
    expect(rs.every((r) => r.status === 200 && r.json.status === "succeeded")).toBe(true);
    expect(await events(p.id)).toEqual(["payment.pending", "payment.succeeded"]);
    expect(await events(s.json.id.slice(3))).toEqual(["checkout.session.completed"]);
  });

  it("parallel reads/cancels after expiry: one expiry event", async () => {
    const local: Clock = { t: Date.now() };
    const d = makeDeps(t, local);
    const s = await createSession(d, a, { expires_in: 300 });
    local.t += 301_000;
    const rs = await Promise.all([
      ...Array.from({ length: 4 }, () => call(d, "GET", `/api/v1/checkout/sessions/${s.json.id}`, { auth: a.auth })),
      call(d, "POST", `/api/v1/checkout/sessions/${s.json.id}/cancel`, { auth: a.auth }),
    ]);
    expect(rs.slice(0, 4).every((r) => r.json.status === "expired")).toBe(true);
    expect(rs[4]!.status).toBe(409);
    expect(await events(s.json.id.slice(3))).toEqual(["checkout.session.expired"]);
  });
});
