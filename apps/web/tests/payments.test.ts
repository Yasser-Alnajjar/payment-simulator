import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attemptPaymentByToken, resolvePendingPayment } from "@/server/services/payments";
import { sweepAll } from "@/server/lifecycle";
import { createTestDb, DB_TESTS_ENABLED, type Harness } from "./harness";
import { call, createSession, makeDeps, newAccount, tokenOf, type Account, type Clock } from "./api-helpers";

describe.skipIf(!DB_TESTS_ENABLED)("payments, scenarios and state machines (Hosted Supabase)", () => {
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
    return { id: r.json.id as string, uuid: (r.json.id as string).slice(3), token: tokenOf(r.json.url) };
  };
  const events = async (subject: string) => (await t.prisma.event.findMany({ where: { subjectId: subject }, orderBy: { seq: "asc" } })).map((e) => e.type);
  const session = (userId: string, id: string) => t.prisma.checkoutSession.findFirstOrThrow({ where: { userId, id } });
  const payments = (sid: string) => t.prisma.transaction.findMany({ where: { checkoutSessionId: sid }, orderBy: { seq: "asc" } });
  const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } };

  it("success: payment succeeds, session completes, exactly one event each, amount copied from the session", async () => {
    const s = await open({ amount: "42.50", currency: "EUR" });
    const { payment } = await attemptPaymentByToken(t.prisma, { token: s.token, scenario: "success" }, now());
    expect(payment).toMatchObject({ status: "succeeded", amountMinor: 4250n, currency: "EUR", version: 1 });
    expect((await session(a.userId, s.uuid)).status).toBe("completed");
    expect(await events(payment.id)).toEqual(["payment.succeeded"]);
    expect(await events(s.uuid)).toEqual(["checkout.session.completed"]);
    const api = await call(deps(), "GET", `/api/v1/payments/pay_${payment.id}`, { auth: a.auth });
    expect(api.json).toMatchObject({ object: "payment", status: "succeeded", amount: "42.50", amount_minor: 4250, currency: "EUR", checkout_session_id: s.id, scenario: "success", failure_code: null });
    expect(Object.keys(api.json)).not.toEqual(expect.arrayContaining(["user_id", "version", "seq"]));
  });

  it("decline leaves the session open; a later success completes it; only one pending/succeeded payment ever", async () => {
    const s = await open();
    const d = await attemptPaymentByToken(t.prisma, { token: s.token, scenario: "decline" }, now());
    expect(d.payment).toMatchObject({ status: "failed", failureCode: "declined" });
    expect((await session(a.userId, s.uuid)).status).toBe("open");
    const again = await attemptPaymentByToken(t.prisma, { token: s.token, scenario: "success" }, now());
    expect(again.payment.status).toBe("succeeded");
    expect((await session(a.userId, s.uuid)).status).toBe("completed");
    expect((await payments(s.uuid)).map((p) => p.status)).toEqual(["failed", "succeeded"]);
    await expect(attemptPaymentByToken(t.prisma, { token: s.token, scenario: "success" }, now())).rejects.toMatchObject({ code: "session_already_paid" });
  });

  it("a paid session rejects further attempts with 409 session_already_paid", async () => {
    const s = await open();
    await attemptPaymentByToken(t.prisma, { token: s.token, scenario: "success" }, now());
    await expect(attemptPaymentByToken(t.prisma, { token: s.token, scenario: "success" }, now())).rejects.toMatchObject({ status: 409, code: "session_already_paid" });
  });

  it("cancel scenario: payment cancelled, session stays open and can be retried", async () => {
    const s = await open();
    const c = await attemptPaymentByToken(t.prisma, { token: s.token, scenario: "cancel" }, now());
    expect(c.payment).toMatchObject({ status: "cancelled", failureCode: "payment_cancelled" });
    expect((await session(a.userId, s.uuid)).status).toBe("open");
    expect(await events(c.payment.id)).toEqual(["payment.cancelled"]);
  });

  it("pending blocks a second attempt (409); resolving it succeeds and completes the session, one event per transition", async () => {
    const s = await open();
    const p = await attemptPaymentByToken(t.prisma, { token: s.token, scenario: "pending" }, now());
    expect(p.payment.status).toBe("pending");
    await expect(attemptPaymentByToken(t.prisma, { token: s.token, scenario: "success" }, now())).rejects.toMatchObject({ status: 409, code: "payment_in_progress" });
    const done = await resolvePendingPayment(t.prisma, a.userId, `pay_${p.payment.id}`, "succeeded", now());
    expect(done).toMatchObject({ status: "succeeded", version: 2 });
    expect((await session(a.userId, s.uuid)).status).toBe("completed");
    expect(await events(p.payment.id)).toEqual(["payment.pending", "payment.succeeded"]);
    await expect(resolvePendingPayment(t.prisma, a.userId, `pay_${p.payment.id}`, "failed", now())).rejects.toMatchObject({ status: 409, code: "invalid_state_transition" });
    await expect(resolvePendingPayment(t.prisma, b.userId, `pay_${p.payment.id}`, "failed", now())).rejects.toMatchObject({ status: 404 });
  });

  it("pending_then_success resolves lazily after its delay (on read), pending_then_failure leaves the session open", async () => {
    const local: Clock = { t: Date.now() };
    const d = makeDeps(t, local);
    const s1 = await createSession(d, a), s2 = await createSession(d, a);
    const p1 = await attemptPaymentByToken(t.prisma, { token: tokenOf(s1.json.url), scenario: "pending_then_success", delaySeconds: 10 }, new Date(local.t));
    const p2 = await attemptPaymentByToken(t.prisma, { token: tokenOf(s2.json.url), scenario: "pending_then_failure", delaySeconds: 10 }, new Date(local.t));
    expect(p1.payment.resolveAt!.getTime() - local.t).toBe(10_000);
    expect((await call(d, "GET", `/api/v1/payments/pay_${p1.payment.id}`, { auth: a.auth })).json.status).toBe("pending");
    local.t += 11_000;
    const r1 = await call(d, "GET", `/api/v1/payments/pay_${p1.payment.id}`, { auth: a.auth });
    expect(r1.json.status).toBe("succeeded");
    expect((await call(d, "GET", `/api/v1/checkout/sessions/${s1.json.id}`, { auth: a.auth })).json.status).toBe("completed");
    const listed = await call(d, "GET", "/api/v1/payments?status=failed", { auth: a.auth }); // list sweeps due resolutions
    expect(listed.json.data.map((x: { id: string }) => x.id)).toContain(`pay_${p2.payment.id}`);
    expect((await call(d, "GET", `/api/v1/checkout/sessions/${s2.json.id}`, { auth: a.auth })).json.status).toBe("open");
    expect(await events(p1.payment.id)).toEqual(["payment.pending", "payment.succeeded"]);
    expect(await events(p2.payment.id)).toEqual(["payment.pending", "payment.failed"]);
    // repeated reads do not emit anything more
    await call(d, "GET", `/api/v1/payments/pay_${p1.payment.id}`, { auth: a.auth });
    expect(await events(p1.payment.id)).toEqual(["payment.pending", "payment.succeeded"]);
  });

  it("timeout: stays pending, and session expiry cancels the payment in the same transaction (events: payment.cancelled then session.expired)", async () => {
    const local: Clock = { t: Date.now() };
    const d = makeDeps(t, local);
    const s = await createSession(d, a, { expires_in: 300 });
    const p = await attemptPaymentByToken(t.prisma, { token: tokenOf(s.json.url), scenario: "timeout" }, new Date(local.t));
    local.t += 200_000;
    expect((await call(d, "GET", `/api/v1/payments/pay_${p.payment.id}`, { auth: a.auth })).json.status).toBe("pending");
    local.t += 200_000;
    const after = await call(d, "GET", `/api/v1/payments/pay_${p.payment.id}`, { auth: a.auth });
    expect(after.json).toMatchObject({ status: "cancelled", failure_code: "timeout" });
    expect((await call(d, "GET", `/api/v1/checkout/sessions/${s.json.id}`, { auth: a.auth })).json.status).toBe("expired");
    expect(await events(p.payment.id)).toEqual(["payment.pending", "payment.cancelled"]);
    expect(await events(s.json.id.slice(3))).toEqual(["checkout.session.expired"]);
    await expect(attemptPaymentByToken(t.prisma, { token: tokenOf(s.json.url), scenario: "success" }, new Date(local.t))).rejects.toMatchObject({ status: 409, code: "session_expired" });
  });

  it("expiry takes precedence over a resolution scheduled after the session expires", async () => {
    const local: Clock = { t: Date.now() };
    const d = makeDeps(t, local);
    const s = await createSession(d, a, { expires_in: 300 });
    local.t += 295_000;
    const p = await attemptPaymentByToken(t.prisma, { token: tokenOf(s.json.url), scenario: "pending_then_success", delaySeconds: 60 }, new Date(local.t));
    local.t += 400_000;
    expect((await call(d, "GET", `/api/v1/payments/pay_${p.payment.id}`, { auth: a.auth })).json).toMatchObject({ status: "cancelled", failure_code: "session_expired" });
    expect((await call(d, "GET", `/api/v1/checkout/sessions/${s.json.id}`, { auth: a.auth })).json.status).toBe("expired");
  });

  it("cancelling a session cancels its pending payment atomically (2 events + 1 session event)", async () => {
    const s = await open();
    const p = await attemptPaymentByToken(t.prisma, { token: s.token, scenario: "pending" }, now());
    const c = await call(deps(), "POST", `/api/v1/checkout/sessions/${s.id}/cancel`, { auth: a.auth });
    expect(c.json.status).toBe("cancelled");
    expect((await t.prisma.transaction.findUniqueOrThrow({ where: { id: p.payment.id } })).status).toBe("cancelled");
    expect(await events(p.payment.id)).toEqual(["payment.pending", "payment.cancelled"]);
    expect(await events(s.uuid)).toEqual(["checkout.session.cancelled"]);
    await expect(attemptPaymentByToken(t.prisma, { token: s.token, scenario: "success" }, now())).rejects.toMatchObject({ code: "session_cancelled" });
  });

  it("completed sessions cannot be cancelled (409) and keep their state", async () => {
    const s = await open();
    await attemptPaymentByToken(t.prisma, { token: s.token, scenario: "success" }, now());
    const c = await call(deps(), "POST", `/api/v1/checkout/sessions/${s.id}/cancel`, { auth: a.auth });
    expect(c.status).toBe(409);
    expect(c.json.error).toMatchObject({ type: "conflict_error", code: "invalid_state_transition" });
    expect((await session(a.userId, s.uuid)).status).toBe("completed");
  });

  it("a preset scenario is locked; without one the caller must choose; invalid input is rejected", async () => {
    const preset = await open({ scenario: "decline" });
    await expect(attemptPaymentByToken(t.prisma, { token: preset.token, scenario: "success" }, now())).rejects.toMatchObject({ code: "scenario_locked" });
    expect((await attemptPaymentByToken(t.prisma, { token: preset.token }, now())).payment.status).toBe("failed");
    const free = await open();
    await expect(attemptPaymentByToken(t.prisma, { token: free.token }, now())).rejects.toMatchObject({ code: "scenario_required" });
    await expect(attemptPaymentByToken(t.prisma, { token: free.token, scenario: "nope" }, now())).rejects.toMatchObject({ status: 400 });
    await expect(attemptPaymentByToken(t.prisma, { token: free.token, scenario: "pending_then_success", delaySeconds: 0 }, now())).rejects.toMatchObject({ status: 400 });
    await expect(attemptPaymentByToken(t.prisma, { token: "sbx_cs_" + "x".repeat(43) , scenario: "success" }, now())).rejects.toMatchObject({ status: 404 });
    await expect(attemptPaymentByToken(t.prisma, { token: "", scenario: "success" }, now())).rejects.toMatchObject({ status: 404 });
  });

  it("payments API: filters, pagination, isolation, same-id-as-missing", async () => {
    const c = await newAccount(t);
    const mk = async (scenario: string) => { const s = await open({}, c); return (await attemptPaymentByToken(t.prisma, { token: s.token, scenario }, now())).payment; };
    const [p1, p2, p3] = [await mk("success"), await mk("decline"), await mk("pending")];
    const all = await call(deps(), "GET", "/api/v1/payments", { auth: c.auth });
    expect(all.json.data.map((x: { id: string }) => x.id)).toEqual([`pay_${p3.id}`, `pay_${p2.id}`, `pay_${p1.id}`]);
    const page = await call(deps(), "GET", `/api/v1/payments?limit=1&starting_after=pay_${p3.id}`, { auth: c.auth });
    expect(page.json).toMatchObject({ has_more: true });
    expect(page.json.data[0].id).toBe(`pay_${p2.id}`);
    expect((await call(deps(), "GET", "/api/v1/payments?status=succeeded", { auth: c.auth })).json.data.length).toBe(1);
    expect((await call(deps(), "GET", `/api/v1/payments?checkout_session_id=cs_${p1.checkoutSessionId}`, { auth: c.auth })).json.data.length).toBe(1);
    expect((await call(deps(), "GET", `/api/v1/payments/pay_${p1.id}`, { auth: b.auth })).status).toBe(404);
    expect((await call(deps(), "GET", "/api/v1/payments", { auth: b.auth })).json.data.some((x: { id: string }) => x.id === `pay_${p1.id}`)).toBe(false);
  });

  it("database rules: terminal payments are immutable, one active payment per session, no duplicate events", async () => {
    const s = await open({ amount: "7.00", currency: "USD" });
    const p = (await attemptPaymentByToken(t.prisma, { token: s.token, scenario: "success" }, now())).payment;
    await expect(t.sql("UPDATE transactions SET status = 'failed', version = 2 WHERE id = $1", [p.id])).rejects.toThrow(/terminal/);
    await expect(t.sql("UPDATE transactions SET amount_minor = 1 WHERE id = $1", [p.id])).rejects.toThrow(/immutable/);
    await expect(t.sql("UPDATE transactions SET checkout_session_id = $2 WHERE id = $1", [p.id, s.uuid])).rejects.toThrow();
    const pend = await open({ amount: "7.00", currency: "USD" });
    const q = (await attemptPaymentByToken(t.prisma, { token: pend.token, scenario: "pending" }, now())).payment;
    await expect(t.sql("UPDATE transactions SET status = 'pending', version = 2 WHERE id = $1", [q.id])).rejects.toThrow();
    await expect(t.sql("UPDATE transactions SET status = 'succeeded', version = 5, resolved_at = now() WHERE id = $1", [q.id])).rejects.toThrow(/version/);
    // the index, not the application, blocks a second pending/succeeded payment
    await expect(t.sql("INSERT INTO transactions (id, user_id, checkout_session_id, amount_minor, currency, status, scenario) VALUES (gen_random_uuid(), $1, $2, 700, 'USD', 'pending', 'pending')", [a.userId, pend.uuid]))
      .rejects.toThrow(/transactions_one_active_per_session/);
    await expect(t.sql("INSERT INTO events (id, user_id, type, subject_id, payload) VALUES (gen_random_uuid(), $1, 'payment.pending', $2, '{}')", [a.userId, q.id])).rejects.toThrow(/events_user_subject_type_occurrence_key/);
    expect(await code(t.sql("UPDATE transactions SET status = 'cancelled', version = 2, resolved_at = now() WHERE id = $1", [q.id]))).toBe("ok");
  });

  it("the global sweep settles due work for every user in bounded batches", async () => {
    const local: Clock = { t: Date.now() };
    const d = makeDeps(t, local);
    const s = await createSession(d, b, { expires_in: 300 });
    local.t += 301_000;
    const swept = await sweepAll(t.prisma, new Date(local.t), 500);
    expect(swept.settled).toBeGreaterThanOrEqual(1);
    expect(swept.failed).toBe(0);
    expect((await session(b.userId, s.json.id.slice(3))).status).toBe("expired");
  });
});
