import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelCheckoutByToken, getCheckoutView } from "@/server/services/checkout-public";
import { getOverview, sessionDetail, sessionsPage, paymentsPage } from "@/server/services/dashboard";
import { attemptPaymentByToken, resolvePendingPayment } from "@/server/services/payments";
import { createTestDb, DB_TESTS_ENABLED, type Harness } from "./harness";
import { createSession, makeDeps, newAccount, tokenOf, type Account, type Clock } from "./api-helpers";

describe.skipIf(!DB_TESTS_ENABLED)("hosted checkout + dashboard services (Hosted Supabase)", () => {
  let t: Harness;
  let a: Account, b: Account;
  const clock: Clock = { t: Date.now() };
  const deps = () => makeDeps(t, clock);
  const now = () => new Date(clock.t);
  beforeAll(async () => { t = await createTestDb(); a = await newAccount(t); b = await newAccount(t); });
  afterAll(async () => { await t?.close(); });

  const open = async (body: Record<string, unknown> = {}, acct = a) => {
    const r = await createSession(deps(), acct, body);
    expect(r.status).toBe(201);
    return { id: r.json.id as string, token: tokenOf(r.json.url) };
  };

  it("view exposes only public fields and reflects the session", async () => {
    const s = await open({ amount: "19.99", currency: "EUR", external_reference: "order-7", metadata: { secret_note: "x" } });
    const v = await getCheckoutView(t.prisma, s.token, now());
    expect(v).toEqual({ status: "open", amount: "19.99", currency: "EUR", reference: "order-7", presetScenario: null, expiresAt: expect.any(String), payment: null, canPay: true, customer: null, cardAllowed: true, savedCards: [] });
    const text = JSON.stringify(v);
    expect(text).not.toContain(a.userId);
    expect(text).not.toContain(s.token);
    expect(text).not.toContain("secret_note");
    expect(text).not.toContain(s.id);
  });

  it("unknown, malformed and wrong-shaped tokens are all null (indistinguishable)", async () => {
    for (const tok of ["", "short", "x".repeat(200), "sbx_co_" + "A".repeat(43), "has spaces in it which is long enough", 42, null, undefined]) {
      expect(await getCheckoutView(t.prisma, tok, now())).toBeNull();
    }
    await expect(cancelCheckoutByToken(t.prisma, "nope", now())).rejects.toMatchObject({ status: 404 });
  });

  it("preset scenario is reported and cannot be overridden through the service", async () => {
    const s = await open({ scenario: "decline" });
    expect((await getCheckoutView(t.prisma, s.token, now()))?.presetScenario).toBe("decline");
    await expect(attemptPaymentByToken(t.prisma, { token: s.token, scenario: "success" }, now())).rejects.toMatchObject({ code: "scenario_locked" });
    await attemptPaymentByToken(t.prisma, { token: s.token }, now());
    const v = await getCheckoutView(t.prisma, s.token, now());
    expect(v).toMatchObject({ status: "open", canPay: true, payment: { status: "failed", failureCode: "declined" } });
  });

  it("success completes; pending blocks a second attempt; paid and cancelled reject", async () => {
    const ok = await open();
    await attemptPaymentByToken(t.prisma, { token: ok.token, scenario: "success" }, now());
    expect(await getCheckoutView(t.prisma, ok.token, now())).toMatchObject({ status: "completed", canPay: false, payment: { status: "succeeded" } });

    const p = await open();
    await attemptPaymentByToken(t.prisma, { token: p.token, scenario: "pending" }, now());
    expect(await getCheckoutView(t.prisma, p.token, now())).toMatchObject({ status: "open", canPay: false, payment: { status: "pending" } });
    await expect(attemptPaymentByToken(t.prisma, { token: p.token, scenario: "success" }, now())).rejects.toMatchObject({ code: "payment_in_progress" });
  });

  it("customer cancel cancels the session and its pending payment; repeat is idempotent; paid session cannot be cancelled", async () => {
    const p = await open();
    await attemptPaymentByToken(t.prisma, { token: p.token, scenario: "pending" }, now());
    await cancelCheckoutByToken(t.prisma, p.token, now());
    await cancelCheckoutByToken(t.prisma, p.token, now());
    expect(await getCheckoutView(t.prisma, p.token, now())).toMatchObject({ status: "cancelled", canPay: false, payment: { status: "cancelled", failureCode: "session_cancelled" } });
    await expect(attemptPaymentByToken(t.prisma, { token: p.token, scenario: "success" }, now())).rejects.toMatchObject({ code: "session_cancelled" });

    const paid = await open();
    await attemptPaymentByToken(t.prisma, { token: paid.token, scenario: "success" }, now());
    await expect(cancelCheckoutByToken(t.prisma, paid.token, now())).rejects.toMatchObject({ code: "invalid_state_transition" });
  });

  it("expiry is applied when the page is read; delayed resolution is applied when due", async () => {
    const e = await open({ expires_in: 300 });
    await attemptPaymentByToken(t.prisma, { token: e.token, scenario: "pending" }, now());
    clock.t += 301_000;
    expect(await getCheckoutView(t.prisma, e.token, now())).toMatchObject({ status: "expired", canPay: false, payment: { status: "cancelled", failureCode: "session_expired" } });
    await expect(attemptPaymentByToken(t.prisma, { token: e.token, scenario: "success" }, now())).rejects.toMatchObject({ code: "session_expired" });

    const d = await open();
    await attemptPaymentByToken(t.prisma, { token: d.token, scenario: "pending_then_success", delaySeconds: 10 }, now());
    expect((await getCheckoutView(t.prisma, d.token, now()))?.payment?.status).toBe("pending");
    clock.t += 11_000;
    expect(await getCheckoutView(t.prisma, d.token, now())).toMatchObject({ status: "completed", payment: { status: "succeeded" } });
  });

  it("concurrent attempts through the page service: exactly one wins", async () => {
    const s = await open();
    const rs = await Promise.allSettled(Array.from({ length: 5 }, () => attemptPaymentByToken(t.prisma, { token: s.token, scenario: "pending" }, now())));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of rs) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "payment_in_progress" });
  });

  it("dashboard services are scoped to the owner", async () => {
    const mine = await open({ amount: "5.00" });
    await attemptPaymentByToken(t.prisma, { token: mine.token, scenario: "pending" }, now());
    const theirs = await open({ amount: "7.00" }, b);
    const o = await getOverview(t.prisma, b.userId, now());
    expect(Object.values(o.sessions).reduce((x, y) => x + y, 0)).toBe(1);
    expect(o.recentSessions.map((s) => s.id)).toEqual([theirs.id]);
    expect((await sessionsPage(t.prisma, b.userId, now(), {})).items.map((s) => s.id)).toEqual([theirs.id]);
    expect((await paymentsPage(t.prisma, b.userId, now(), {})).items).toEqual([]);
    await expect(sessionDetail(t.prisma, b.userId, mine.id, now())).rejects.toMatchObject({ status: 404 });
    const d = await sessionDetail(t.prisma, a.userId, mine.id, now());
    expect(d.payments).toHaveLength(1);
    expect(d.events.map((e) => e.type).sort()).toEqual(["payment.pending"]);
    // operator control goes through the state machine and is owner scoped
    await expect(resolvePendingPayment(t.prisma, b.userId, d.payments[0]!.id, "succeeded", now())).rejects.toMatchObject({ status: 404 });
    await resolvePendingPayment(t.prisma, a.userId, d.payments[0]!.id, "succeeded", now());
    expect((await getCheckoutView(t.prisma, mine.token, now()))?.status).toBe("completed");
  });
});
