import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attemptPaymentByToken, DEFAULT_CHECKOUT_LIMITS, resolvePendingPayment, type CheckoutLimits } from "@/server/services/payments";
import { getCheckoutView } from "@/server/services/checkout-public";
import { createTestDb, DB_TESTS_ENABLED, type Harness } from "./harness";
import { createSession, makeDeps, newAccount, tokenOf, type Account, type Clock } from "./api-helpers";

describe.skipIf(!DB_TESTS_ENABLED)("public checkout abuse limits (Hosted Supabase)", () => {
  let t: Harness;
  let a: Account, b: Account;
  let ns: string;
  const clock: Clock = { t: Date.now() };
  const deps = () => makeDeps(t, clock);
  const now = () => new Date(clock.t);
  // Run-scoped counter buckets: tests never read or write the production counters.
  // Each test gets its own namespace: the windows are per minute, so tests must not share counters.
  let n = 0;
  const lim = (o: Partial<CheckoutLimits> = {}): CheckoutLimits => ({ ...DEFAULT_CHECKOUT_LIMITS, namespace: `${ns}-${++n}`, ...o });
  beforeAll(async () => { t = await createTestDb(); ns = `sbx-run-${t.runId}`; a = await newAccount(t); b = await newAccount(t); });
  afterAll(async () => {
    // Only this run's counters (bucket prefix contains the run id).
    if (t) {
      await t.prisma.$executeRaw`DELETE FROM auth_failure_windows WHERE bucket LIKE ${ns + "-%"}`;
      await t.close();
    }
  });

  const open = async (body: Record<string, unknown> = {}, acct = a) => {
    const r = await createSession(deps(), acct, body);
    expect(r.status).toBe(201);
    return { id: r.json.id as string, token: tokenOf(r.json.url) };
  };
  // Windows are fixed per minute on the database clock: do not start a window-sensitive test in the last seconds of a minute.
  const minuteRoom = async () => { const sec = new Date().getSeconds(); if (sec > 40) await new Promise((r) => setTimeout(r, (61 - sec) * 1000)); };
  const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } };
  const attempt = (token: string, scenario: string, l: CheckoutLimits) => attemptPaymentByToken(t.prisma, { token, scenario }, now(), l);
  const count = (sessionUuid: string) => t.prisma.transaction.count({ where: { checkoutSessionId: sessionUuid } });

  it("allows attempts below the limit and rejects the one past it with a controlled 429", async () => {
    const l = lim({ maxAttemptsPerSession: 3 });
    const s = await open();
    for (let i = 0; i < 3; i++) expect(await code(attempt(s.token, "decline", l))).toBe("ok");
    const err = await attempt(s.token, "decline", l).catch((e) => e);
    expect(err).toMatchObject({ status: 429, type: "rate_limit_error", code: "too_many_payment_attempts" });
    expect(err.message).not.toMatch(/sbx|user|bucket|limit_namespace/i);
    expect(await count(s.id.slice(3))).toBe(3);
  });

  it("declined and cancelled attempts remain retryable up to the limit; the limit also stops a success after exhaustion", async () => {
    const l = lim({ maxAttemptsPerSession: 4 });
    const s = await open();
    await attempt(s.token, "decline", l);
    await attempt(s.token, "cancel", l);
    await attempt(s.token, "decline", l);
    expect((await getCheckoutView(t.prisma, s.token, now()))?.canPay).toBe(true);
    expect(await code(attempt(s.token, "success", l))).toBe("ok"); // 4th attempt succeeds
    expect(await code(attempt(s.token, "success", l))).toBe("session_already_paid"); // state errors still take precedence
  });

  it("concurrent attempts at the limit cannot exceed it or create duplicates", async () => {
    const l = lim({ maxAttemptsPerSession: 3 });
    const s = await open();
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => attempt(s.token, "decline", l)));
    const ok = rs.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBeLessThanOrEqual(3);
    expect(await count(s.id.slice(3))).toBe(ok);
    for (const r of rs) if (r.status === "rejected") expect(["too_many_payment_attempts", "payment_in_progress"]).toContain(r.reason.code);
    // and, afterwards, the session really is capped
    while ((await count(s.id.slice(3))) < 3) await attempt(s.token, "decline", l);
    expect(await code(attempt(s.token, "decline", l))).toBe("too_many_payment_attempts");
  });

  it("attempt counts are per session: another session (same or other owner) is unaffected", async () => {
    const l = lim({ maxAttemptsPerSession: 1 });
    const s1 = await open(), s2 = await open(), s3 = await open({}, b);
    await attempt(s1.token, "decline", l);
    expect(await code(attempt(s1.token, "decline", l))).toBe("too_many_payment_attempts");
    expect(await code(attempt(s2.token, "decline", l))).toBe("ok");
    expect(await code(attempt(s3.token, "decline", l))).toBe("ok");
  });

  it("per-owner window caps one merchant's traffic without touching another's or the global budget", async () => {
    await minuteRoom();
    const l = lim({ perOwnerPerMinute: 3, globalPerMinute: 1000 });
    const mine = await Promise.all([open(), open(), open(), open()]);
    const other = await open({}, b);
    for (const s of mine.slice(0, 3)) expect(await code(attempt(s.token, "decline", l))).toBe("ok");
    const err = await attempt(mine[3]!.token, "decline", l).catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: "too_many_requests", headers: { "retry-after": "60" } });
    expect(await code(attempt(other.token, "decline", l))).toBe("ok");
    expect(await count(mine[3]!.id.slice(3))).toBe(0); // rejected: no payment, event or session change (the rate counters are still incremented, by design)
  });

  it("global window caps all public attempts regardless of owner or session", async () => {
    await minuteRoom();
    const l = lim({ globalPerMinute: 2 });
    const s1 = await open(), s2 = await open({}, b), s3 = await open();
    expect(await code(attempt(s1.token, "decline", l))).toBe("ok");
    expect(await code(attempt(s2.token, "decline", l))).toBe("ok");
    expect(await code(attempt(s3.token, "decline", l))).toBe("too_many_requests");
  });

  it("unknown well-formed tokens have their own budget and do not consume the valid-customer budget", async () => {
    await minuteRoom();
    const l = lim({ unknownTokenPerMinute: 2, globalPerMinute: 2 });
    const fake = "sbx_co_" + "Z".repeat(43);
    expect(await code(attempt(fake, "decline", l))).toBe("resource_not_found" );
    expect(await code(attempt(fake, "decline", l))).toBe("resource_not_found");
    expect(await code(attempt(fake, "decline", l))).toBe("too_many_requests");
    const s = await open();
    expect(await code(attempt(s.token, "decline", l))).toBe("ok"); // global bucket untouched by the flood
  });

  it("status polling, cancel and pending resolution are never limited", async () => {
    await minuteRoom();
    const l = lim({ maxAttemptsPerSession: 1, perOwnerPerMinute: 1, globalPerMinute: 1 });
    const s = await open();
    const { payment } = await attempt(s.token, "pending", l);
    for (let i = 0; i < 30; i++) expect((await getCheckoutView(t.prisma, s.token, now()))?.payment?.status).toBe("pending");
    expect(await code(attempt(s.token, "pending", l))).toBe("too_many_requests"); // attempts ARE limited
    await resolvePendingPayment(t.prisma, a.userId, `pay_${payment.id}`, "succeeded", now()); // operator path unaffected
    expect((await getCheckoutView(t.prisma, s.token, now()))?.status).toBe("completed");
  });
});
