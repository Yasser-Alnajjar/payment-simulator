import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "@sandbox/core";
import { emitEvent, TX_OPTIONS } from "@/server/lifecycle";
import { attemptPaymentByToken } from "@/server/services/payments";
import { createSetupSession, sweepSetupAll } from "@/server/services/setup-sessions";
import { claimDeliveries, processDelivery, type EngineDeps } from "@/server/webhooks/engine";
import { acquireSchedulerLease, releaseSchedulerLease, runSchedulerTick } from "@/server/webhooks/scheduler";
import { sendWebhook } from "@/server/webhooks/sender";
import { createTestDb, DB_TESTS_ENABLED, type Harness } from "./harness";
import { call, createSession, ENC_KEY, makeClock, makeDeps, newAccount, tokenOf, type Account } from "./api-helpers";

/**
 * S4 webhooks against the Hosted database (rule R-DB-1; skipped unless the hosted target is declared).
 * Every delivery is driven explicitly by id (`onlyIds`) so the run can never claim another account's deliveries; the global sweeps are
 * never called; the scheduler lease tests use their own 'test-<runId>' row. Receivers listen on 127.0.0.1 only. The harness refuses
 * to run while the production Supabase Cron tick is active.
 */
type Got = { headers: http.IncomingHttpHeaders; body: string };
let plan: (n: number) => { status: number; delayMs?: number } = () => ({ status: 200 });
const got: Got[] = [];
const receiver = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    got.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    const p = plan(got.length);
    setTimeout(() => { res.writeHead(p.status, { "content-type": "text/plain" }); res.end(`r${got.length}`); }, p.delayMs ?? 0);
  });
});
let url = "";

describe.skipIf(!DB_TESTS_ENABLED)("webhooks: endpoints, fan-out, delivery engine, scheduler (Hosted Supabase)", () => {
  let t: Harness;
  let a: Account, b: Account;
  const clock = makeClock();
  const deps = () => ({ ...makeDeps(t, clock), allowPrivateWebhookTargets: true });
  const engine = (over: Partial<EngineDeps> = {}): EngineDeps => ({ encKey: ENC_KEY, allowPrivate: true, now: () => new Date(clock.t), rand: () => 0.5, ...over });
  const deliveriesOf = (userId: string) => t.prisma.webhookDelivery.findMany({ where: { userId }, orderBy: { seq: "asc" } });
  /** Claims and processes exactly these deliveries once. */
  const drive = async (ids: string[], over: Partial<EngineDeps> = {}) => {
    const claimed = await claimDeliveries(t.prisma, { limit: 10, now: new Date(clock.t), onlyIds: ids });
    return Promise.all(claimed.map((c) => processDelivery(t.prisma, c, engine(over))));
  };
  const newEndpoint = async (acc: Account, body: Record<string, unknown> = {}) => {
    const r = await call(deps(), "POST", "/api/v1/webhook-endpoints", { auth: acc.auth, body: { url, enabled_events: ["*"], ...body } });
    expect(r.status).toBe(201);
    return r.json as { id: string; secret: string };
  };
  const pay = async (acc: Account, scenario = "success") => {
    const s = await createSession(deps(), acc, { amount: "12.00", currency: "USD" });
    await attemptPaymentByToken(t.prisma, { token: tokenOf(s.json.url), scenario: scenario as never }, new Date(clock.t));
    return s.json.id as string;
  };

  beforeAll(async () => {
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    t = await createTestDb();
    const s4 = (await t.sql("select to_regclass('public.webhook_deliveries') is not null as ok")).rows[0].ok;
    if (!s4) throw new Error("S4 migration is not applied on the hosted database");
    a = await newAccount(t);
    b = await newAccount(t);
  });
  afterAll(async () => { receiver.closeAllConnections(); await new Promise<void>((r) => receiver.close(() => r())); await t?.close(); });
  beforeEach(() => { got.length = 0; plan = () => ({ status: 200 }); clock.t = Date.now(); });

  it("creates an endpoint, returns the secret once, never again; rejects private URLs without the development allowance", async () => {
    const e = await newEndpoint(a, { description: "main" });
    expect(e.secret).toMatch(/^whsec_/);
    const get = await call(deps(), "GET", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
    expect(get.json.secret).toBeUndefined();
    expect(get.text).not.toContain(e.secret);
    const row = await t.prisma.webhookEndpoint.findFirst({ where: { userId: a.userId } });
    expect(row!.secretSealed).not.toContain(e.secret);
    const strict = { ...makeDeps(t, clock), allowPrivateWebhookTargets: false };
    for (const u of [url, "https://localhost/x", "https://169.254.169.254/", "https://[::1]/", "https://10.0.0.1/"]) {
      const r = await call(strict, "POST", "/api/v1/webhook-endpoints", { auth: a.auth, body: { url: u, enabled_events: ["*"] } });
      expect(r.status, u).toBe(400);
    }
    await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
  });

  it("idempotent create replays the same endpoint and secret", async () => {
    const h = { "idempotency-key": `we-${t.runId}` };
    const r1 = await call(deps(), "POST", "/api/v1/webhook-endpoints", { auth: a.auth, body: { url, enabled_events: ["payment.failed"] }, headers: h });
    const r2 = await call(deps(), "POST", "/api/v1/webhook-endpoints", { auth: a.auth, body: { url, enabled_events: ["payment.failed"] }, headers: h });
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect(r2.json.id).toBe(r1.json.id);
    expect(r2.json.secret).toBe(r1.json.secret);
    await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${r1.json.id}`, { auth: a.auth });
  });

  it("fan-out: one delivery per subscribed, enabled endpoint, in the event's transaction; rollback leaves nothing", async () => {
    const all = await newEndpoint(a);
    const onlyFailed = await newEndpoint(a, { enabled_events: ["payment.failed"] });
    const off = await newEndpoint(a);
    await call(deps(), "PATCH", `/api/v1/webhook-endpoints/${off.id}`, { auth: a.auth, body: { status: "disabled" } });
    const before = (await deliveriesOf(a.userId)).length;
    await pay(a, "success"); // payment.succeeded + checkout.session.completed
    const after = await deliveriesOf(a.userId);
    const fresh = after.slice(before);
    expect(fresh.length).toBe(2);
    expect(new Set(fresh.map((d) => `we_${d.endpointId}`))).toEqual(new Set([all.id]));
    const s = await createSession(deps(), a, { amount: "1.00", currency: "USD" });
    await expect(t.prisma.$transaction(async (tx) => {
      await emitEvent(tx, { userId: a.userId, type: "payment.failed", subjectId: s.json.id.slice(3), data: {}, now: new Date(clock.t), occurrence: 7 });
      throw new Error("rollback");
    }, TX_OPTIONS)).rejects.toThrow("rollback");
    expect((await deliveriesOf(a.userId)).length).toBe(after.length);
    for (const e of [all, onlyFailed, off]) await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
  });

  it("delivers exact payload bytes with a valid signature and stable ids", async () => {
    const e = await newEndpoint(a, { enabled_events: ["payment.succeeded"] });
    await pay(a);
    const d = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3) } }))[0]!;
    const [r] = await drive([d.id]);
    expect(r).toMatchObject({ outcome: "success", status: "succeeded", attemptNo: 1 });
    const ev = await t.prisma.event.findFirst({ where: { id: d.eventId } });
    expect(got[0]!.body).toBe(ev!.payload);
    expect(verifyWebhookSignature({ header: got[0]!.headers["sandbox-signature"] as string, rawBody: got[0]!.body, secret: e.secret }).ok).toBe(true);
    expect(got[0]!.headers["sandbox-event-id"]).toBe(`evt_${d.eventId}`);
    expect(got[0]!.headers["sandbox-delivery-id"]).toBe(`whd_${d.id}`);
    expect(got[0]!.headers["sandbox-delivery-attempt"]).toBe("1");
    const api = await call(deps(), "GET", `/api/v1/webhook-deliveries/whd_${d.id}`, { auth: a.auth });
    expect(api.json).toMatchObject({ status: "succeeded", attempt_count: 1, attempts: [{ attempt: 1, outcome: "success", status_code: 200, signature: "valid" }] });
    await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
  });

  it("retries 5xx with backoff, then succeeds; 4xx is permanent; exhaustion fails", async () => {
    const e = await newEndpoint(a, { enabled_events: ["payment.succeeded"], max_attempts: 3 });
    await pay(a);
    const d = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3) } }))[0]!;
    plan = (n) => ({ status: n <= 2 ? 503 : 200 });
    expect((await drive([d.id]))[0]).toMatchObject({ outcome: "retryable", status: "retrying" });
    const r1 = await t.prisma.webhookDelivery.findUnique({ where: { id: d.id } });
    expect(r1!.nextAttemptAt!.getTime() - clock.t).toBe(30_000);
    expect(await drive([d.id])).toEqual([]); // not due yet
    clock.t += 31_000;
    expect((await drive([d.id]))[0]).toMatchObject({ outcome: "retryable", attemptNo: 2 });
    clock.t += 61_000;
    expect((await drive([d.id]))[0]).toMatchObject({ outcome: "success", attemptNo: 3, status: "succeeded" });
    // permanent
    await pay(a);
    const d2 = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3), status: "pending" } }))[0]!;
    plan = () => ({ status: 410 });
    expect((await drive([d2.id]))[0]).toMatchObject({ outcome: "permanent", status: "failed" });
    // exhaustion
    await pay(a);
    const d3 = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3), status: "pending" } }))[0]!;
    plan = () => ({ status: 500 });
    for (let i = 0; i < 3; i++) { await drive([d3.id]); clock.t += 3_600_000; }
    expect(await t.prisma.webhookDelivery.findUnique({ where: { id: d3.id } })).toMatchObject({ status: "failed", attemptCount: 3 });
    await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
  });

  it("receiver timeout is a retryable `timeout` attempt", async () => {
    const e = await newEndpoint(a, { enabled_events: ["payment.succeeded"] });
    await pay(a);
    const d = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3) } }))[0]!;
    plan = () => ({ status: 200, delayMs: 1500 });
    const send: typeof sendWebhook = (req, o) => sendWebhook(req, { ...o, limits: { totalMs: 300 } });
    expect((await drive([d.id], { send }))[0]).toMatchObject({ outcome: "retryable", status: "retrying" });
    expect(await t.prisma.webhookDeliveryAttempt.findFirst({ where: { deliveryId: d.id } })).toMatchObject({ errorCode: "timeout" });
    await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
  });

  it("concurrent claimers never share a delivery", async () => {
    const eps = await Promise.all([1, 2, 3, 4, 5, 6].map(() => newEndpoint(a, { enabled_events: ["payment.succeeded"] })));
    await pay(a);
    const ids = (await t.prisma.webhookDelivery.findMany({ where: { userId: a.userId, status: "pending", endpointId: { in: eps.map((e) => e.id.slice(3)) } } })).map((d) => d.id);
    expect(ids.length).toBe(6);
    const claims = await Promise.all([1, 2, 3, 4].map(() => claimDeliveries(t.prisma, { limit: 10, now: new Date(clock.t), onlyIds: ids })));
    const all = claims.flat().map((c) => c.id);
    expect(all.length).toBe(6);
    expect(new Set(all).size).toBe(6);
    expect(new Set(claims.flat().map((c) => c.lease_token)).size).toBe(6);
    for (const e of eps) await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
  });

  it("crash recovery: an expired lease is re-claimed, the lost attempt is recorded `abandoned`, the late result is `stale`", async () => {
    const e = await newEndpoint(a, { enabled_events: ["payment.succeeded"] });
    await pay(a);
    const d = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3) } }))[0]!;
    const [first] = await claimDeliveries(t.prisma, { limit: 1, now: new Date(clock.t), leaseSeconds: 1, onlyIds: [d.id] });
    expect(first!.attempt_count).toBe(1);
    expect(await claimDeliveries(t.prisma, { limit: 1, now: new Date(clock.t), onlyIds: [d.id] })).toEqual([]); // live lease is never stolen
    await new Promise((r) => setTimeout(r, 1500)); // "crash": the first holder never records; its lease expires
    const [second] = await claimDeliveries(t.prisma, { limit: 1, now: new Date(clock.t), onlyIds: [d.id] });
    expect(second!.attempt_count).toBe(2);
    expect(await processDelivery(t.prisma, second!, engine())).toMatchObject({ attemptNo: 2, status: "succeeded", stale: false });
    const late = await processDelivery(t.prisma, first!, engine()); // the old holder wakes up
    expect(late.stale).toBe(true);
    const attempts = await t.prisma.webhookDeliveryAttempt.findMany({ where: { deliveryId: d.id }, orderBy: { attemptNo: "asc" } });
    expect(attempts.map((x) => [x.attemptNo, x.outcome])).toEqual([[1, "abandoned"], [2, "success"]]); // the late #1 lost the race to the abandoned record
    expect(await t.prisma.webhookDelivery.findUnique({ where: { id: d.id } })).toMatchObject({ status: "succeeded", leaseToken: null });
    await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
  });

  it("failure simulation: http_500 x2 then recovery, invalid_signature, duplicate, delay", async () => {
    const e = await newEndpoint(a, { enabled_events: ["payment.succeeded"] });
    await call(deps(), "PATCH", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth, body: { failure_mode: "http_500", failure_mode_remaining: 2 } });
    await pay(a);
    const d = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3) } }))[0]!;
    await drive([d.id]); clock.t += 3_600_000; await drive([d.id]); clock.t += 3_600_000;
    expect(got.length).toBe(0); // simulated: receiver never contacted
    expect((await drive([d.id]))[0]).toMatchObject({ outcome: "success", attemptNo: 3 });
    expect(got.length).toBe(1);
    expect((await call(deps(), "GET", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth })).json.failure_simulation).toEqual({ mode: "none", remaining: null, delay_seconds: null });
    const att = await t.prisma.webhookDeliveryAttempt.findMany({ where: { deliveryId: d.id }, orderBy: { attemptNo: "asc" } });
    expect(att.map((x) => x.injected)).toEqual([true, true, false]);

    await call(deps(), "PATCH", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth, body: { failure_mode: "invalid_signature" } });
    got.length = 0;
    await pay(a);
    const d2 = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3), status: "pending" } }))[0]!;
    await drive([d2.id]);
    expect(verifyWebhookSignature({ header: got[0]!.headers["sandbox-signature"] as string, rawBody: got[0]!.body, secret: e.secret }).ok).toBe(false);

    await call(deps(), "PATCH", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth, body: { failure_mode: "duplicate" } });
    got.length = 0;
    await pay(a);
    const d3 = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3), status: "pending" } }))[0]!;
    await drive([d3.id]);
    expect(got.length).toBe(2);
    expect(got[0]!.body).toBe(got[1]!.body);
    expect(got[0]!.headers["sandbox-signature"]).toBe(got[1]!.headers["sandbox-signature"]);
    expect(new Set(got.map((g) => JSON.parse(g.body).id)).size).toBe(1); // a dedupe-by-event-id receiver processes it once

    await call(deps(), "PATCH", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth, body: { failure_mode: "delay", failure_delay_seconds: 120 } });
    await pay(a);
    const d4 = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3), status: "pending" } }))[0]!;
    expect(d4.nextAttemptAt!.getTime() - d4.createdAt.getTime()).toBe(120_000);
    await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
  });

  it("out_of_order spreads first attempts; secret rotation signs with both secrets", async () => {
    const e = await newEndpoint(a, { enabled_events: ["payment.succeeded", "checkout.session.completed"] });
    await call(deps(), "PATCH", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth, body: { failure_mode: "out_of_order", failure_delay_seconds: 300 } });
    for (let i = 0; i < 3; i++) await pay(a);
    const ds = await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3) } });
    for (const d of ds) expect(d.nextAttemptAt!.getTime() - d.createdAt.getTime()).toBeLessThanOrEqual(300_000);
    expect(new Set(ds.map((d) => d.nextAttemptAt!.getTime())).size).toBeGreaterThan(1);

    await call(deps(), "PATCH", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth, body: { failure_mode: "none" } });
    const rot = await call(deps(), "POST", `/api/v1/webhook-endpoints/${e.id}/rotate-secret`, { auth: a.auth });
    expect(rot.json.secret).toMatch(/^whsec_/);
    clock.t += 400_000;
    got.length = 0;
    await drive([ds[0]!.id]);
    const h = got[0]!.headers["sandbox-signature"] as string;
    expect(h.split(",v1=").length).toBe(3);
    for (const s of [e.secret, rot.json.secret]) expect(verifyWebhookSignature({ header: h, rawBody: got[0]!.body, secret: s, now: new Date(clock.t) }).ok).toBe(true); // the engine signs with the test clock
    await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
  });

  it("manual retry: re-arms finished deliveries, idempotent while queued, refused while in flight", async () => {
    const e = await newEndpoint(a, { enabled_events: ["payment.succeeded"], max_attempts: 1 });
    await pay(a);
    const d = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3) } }))[0]!;
    plan = () => ({ status: 500 });
    await drive([d.id]);
    expect(await t.prisma.webhookDelivery.findUnique({ where: { id: d.id } })).toMatchObject({ status: "failed" });
    const r1 = await call(deps(), "POST", `/api/v1/webhook-deliveries/whd_${d.id}/retry`, { auth: a.auth });
    expect(r1.status).toBe(202);
    expect(r1.json).toMatchObject({ status: "retrying", manual_retry_pending: true });
    const r2 = await call(deps(), "POST", `/api/v1/webhook-deliveries/whd_${d.id}/retry`, { auth: a.auth });
    expect(r2.status).toBe(202); // idempotent: still one queued retry
    const [c] = await claimDeliveries(t.prisma, { limit: 1, now: new Date(clock.t), onlyIds: [d.id] });
    expect((await call(deps(), "POST", `/api/v1/webhook-deliveries/whd_${d.id}/retry`, { auth: a.auth })).status).toBe(202); // still pending manual
    plan = () => ({ status: 200 });
    expect(await processDelivery(t.prisma, c!, engine())).toMatchObject({ status: "succeeded", attemptNo: 2 });
    const att = await t.prisma.webhookDeliveryAttempt.findMany({ where: { deliveryId: d.id }, orderBy: { attemptNo: "asc" } });
    expect(att.map((x) => x.trigger)).toEqual(["scheduled", "manual"]);
    // in flight
    await call(deps(), "POST", `/api/v1/webhook-deliveries/whd_${d.id}/retry`, { auth: a.auth });
    await claimDeliveries(t.prisma, { limit: 1, now: new Date(clock.t), onlyIds: [d.id] });
    await t.prisma.webhookDelivery.update({ where: { id: d.id }, data: { manualPending: false } }); // simulate a re-request while leased
    const busy = await call(deps(), "POST", `/api/v1/webhook-deliveries/whd_${d.id}/retry`, { auth: a.auth });
    expect(busy.status).toBe(409);
    expect(busy.json.error.code).toBe("delivery_in_progress");
    await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
  });

  it("deleting an endpoint cancels pending deliveries and keeps history; cancelled cannot be retried", async () => {
    const e = await newEndpoint(a, { enabled_events: ["payment.succeeded"] });
    await pay(a);
    const d = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3) } }))[0]!;
    const del = await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
    expect(del.json).toMatchObject({ deleted: true, cancelled_deliveries: 1 });
    expect(await t.prisma.webhookDelivery.findUnique({ where: { id: d.id } })).toMatchObject({ status: "cancelled" });
    expect((await call(deps(), "GET", `/api/v1/webhook-deliveries/whd_${d.id}`, { auth: a.auth })).status).toBe(200);
    expect((await call(deps(), "POST", `/api/v1/webhook-deliveries/whd_${d.id}/retry`, { auth: a.auth })).status).toBe(409);
    expect((await call(deps(), "GET", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth })).status).toBe(404);
  });

  it("test events go only to the chosen endpoint", async () => {
    const e1 = await newEndpoint(a);
    const e2 = await newEndpoint(a);
    const r = await call(deps(), "POST", `/api/v1/webhook-endpoints/${e1.id}/test`, { auth: a.auth });
    expect(r.status).toBe(202);
    const ev = await t.prisma.event.findFirst({ where: { userId: a.userId, type: "webhook_endpoint.test" }, orderBy: { seq: "desc" } });
    const ds = await t.prisma.webhookDelivery.findMany({ where: { eventId: ev!.id } });
    expect(ds.map((d) => `we_${d.endpointId}`)).toEqual([e1.id]);
    await call(deps(), "POST", `/api/v1/webhook-endpoints/${e1.id}/test`, { auth: a.auth }); // second test event: new occurrence
    for (const e of [e1, e2]) await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
  });

  it("tenant isolation on every webhook route", async () => {
    const e = await newEndpoint(a, { enabled_events: ["payment.succeeded"] });
    await pay(a);
    const d = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3) } }))[0]!;
    const w = `whd_${d.id}`;
    for (const [m, p, body] of [
      ["GET", `/api/v1/webhook-endpoints/${e.id}`], ["PATCH", `/api/v1/webhook-endpoints/${e.id}`, { status: "disabled" }], ["DELETE", `/api/v1/webhook-endpoints/${e.id}`],
      ["POST", `/api/v1/webhook-endpoints/${e.id}/test`], ["POST", `/api/v1/webhook-endpoints/${e.id}/rotate-secret`], ["GET", `/api/v1/webhook-deliveries/${w}`], ["POST", `/api/v1/webhook-deliveries/${w}/retry`],
    ] as [string, string, unknown?][]) expect((await call(deps(), m, p, { auth: b.auth, body })).status, `${m} ${p}`).toBe(404);
    expect((await call(deps(), "GET", "/api/v1/webhook-endpoints", { auth: b.auth })).json.data).toEqual([]);
    expect((await call(deps(), "GET", `/api/v1/webhook-deliveries?endpoint_id=${e.id}`, { auth: b.auth })).json.data).toEqual([]);
    expect((await call(deps(), "GET", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth })).json.status).toBe("enabled");
    await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
  });

  it("scheduler lease: overlapping ticks skip; a tick delivers only its own (test) deliveries", async () => {
    const name = `test-${t.runId}`;
    await t.sql("INSERT INTO public.scheduler_leases (name) VALUES ($1)", [name]);
    try {
      const tok = await acquireSchedulerLease(t.prisma, 90, name);
      expect(tok).not.toBeNull();
      expect(await acquireSchedulerLease(t.prisma, 90, name)).toBeNull();
      const e = await newEndpoint(a, { enabled_events: ["payment.succeeded"] });
      await pay(a);
      const d = (await t.prisma.webhookDelivery.findMany({ where: { endpointId: e.id.slice(3) } }))[0]!;
      const busy = await runSchedulerTick(t.prisma, { ...engine(), leaseName: name, skipSweeps: true, onlyDeliveryIds: [d.id] });
      expect(busy.skipped).toBe("busy");
      await releaseSchedulerLease(t.prisma, tok!, busy, name);
      const [x, y] = await Promise.all([1, 2].map(() => runSchedulerTick(t.prisma, { ...engine(), leaseName: name, skipSweeps: true, onlyDeliveryIds: [d.id] })));
      expect([x!.skipped, y!.skipped].filter((s) => s === "busy").length).toBe(1);
      expect(x!.succeeded + y!.succeeded).toBe(1);
      expect(got.length).toBe(1);
      await call(deps(), "DELETE", `/api/v1/webhook-endpoints/${e.id}`, { auth: a.auth });
    } finally {
      await t.sql("DELETE FROM public.scheduler_leases WHERE name = $1", [name]);
    }
  });

  it("sweepSetupAll expires a due setup session exactly once under concurrent sweeps", async () => {
    const r = await createSetupSession(t.prisma, { encKey: ENC_KEY, appUrl: "http://localhost:3100", now: new Date(clock.t) }, a.userId, { customer: "cus_sweep", externalReference: null, metadata: {}, expiresInSeconds: 300, rawBody: {} }, null);
    const later = new Date(clock.t + 301_000);
    await Promise.all([1, 2, 3].map(() => sweepSetupAll(t.prisma, later, 10, [a.userId])));
    const id = r.body.id.slice(5);
    expect(await t.prisma.setupSession.findUnique({ where: { id } })).toMatchObject({ status: "expired" });
    expect(await t.prisma.event.count({ where: { subjectId: id, type: "checkout.session.expired" } })).toBe(1);
  });
});
