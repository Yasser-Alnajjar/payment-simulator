import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "@sandbox/core";
import { attemptPaymentByToken } from "@/server/services/payments";
import { createTestDb, DB_TESTS_ENABLED, type Harness } from "./harness";
import { newAccount, tokenOf, type Account } from "./api-helpers";

/**
 * End-to-end test of the DEPLOYED app (S4): real Supabase Cron -> pg_net -> Vercel tick -> HTTPS delivery to a receiver on this machine
 * behind a Cloudflare quick tunnel (third-party relay; only sandbox test payloads pass through it). Runs only when E2E_BASE_URL is set
 * and the hosted target is declared. Test accounts are tagged test users created and removed by the harness. The only step done
 * locally is the payment attempt itself (the hosted checkout page has no public API); it writes events and delivery rows exactly as
 * the deployed code does, and the deployed scheduler sends them.
 */
const BASE = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const enabled = DB_TESTS_ENABLED && !!BASE;

type Hit = { at: number; headers: http.IncomingHttpHeaders; body: string; type: string; eventId: string; status: number };
const hits: Hit[] = [];
let failedOnce = new Set<string>();
const receiver = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    let type = "?", eventId = "?";
    try { const ev = JSON.parse(body); type = ev.type; eventId = ev.id; } catch { /* ignore */ }
    // payment.succeeded fails once (500) to exercise the retry schedule; everything else is accepted.
    const status = type === "payment.succeeded" && !failedOnce.has(eventId) ? (failedOnce.add(eventId), 500) : 200;
    hits.push({ at: Date.now(), headers: req.headers, body, type, eventId, status });
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(status === 200 ? "ok" : "retry me");
  });
});

let tunnel: ChildProcess | undefined;
async function startTunnel(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => reject(new Error("tunnel did not start in 45 s")), 45_000);
    let buf = "";
    tunnel.stderr!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    tunnel.on("exit", (c) => reject(new Error(`cloudflared exited early (${c})`)));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(auth: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

describe.skipIf(!enabled)("deployed end-to-end: Cron -> Vercel tick -> HTTPS delivery -> retry (Hosted Supabase)", () => {
  let t: Harness, a: Account, b: Account;
  let hook = "";

  beforeAll(async () => {
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    const tunnelUrl = await startTunnel((receiver.address() as AddressInfo).port);
    hook = `${tunnelUrl}/hook`;
    await sleep(8_000); // let the new tunnel host name propagate to resolvers
    t = await createTestDb({ allowActiveScheduler: true });
    a = await newAccount(t);
    b = await newAccount(t);
  }, 120_000);
  afterAll(async () => {
    tunnel?.kill();
    receiver.closeAllConnections();
    await new Promise<void>((r) => receiver.close(() => r()));
    await t?.close();
  }, 60_000);

  it("delivers a test event and a real payment event through the deployed scheduler, retries a 500, and isolates tenants", async () => {
    const created = await api(a.auth, "POST", "/api/v1/webhook-endpoints", { url: hook, enabled_events: ["payment.succeeded", "checkout.session.completed"] });
    expect(created.status).toBe(201);
    const ep = created.json as { id: string; secret: string };
    const secret = ep.secret;
    expect(secret).toMatch(/^whsec_/);

    // 1. Test event (deployed API -> pending delivery -> next scheduler tick).
    const test = await api(a.auth, "POST", `/api/v1/webhook-endpoints/${ep.id}/test`);
    expect(test.status).toBe(202);

    // 2. A real payment: checkout session through the deployed API, payment attempt locally; fan-out runs in that transaction.
    const sess = await api(a.auth, "POST", "/api/v1/checkout/sessions", { amount: "12.00", currency: "USD" });
    expect(sess.status).toBe(201);
    await attemptPaymentByToken(t.prisma, { token: tokenOf(sess.json.url), scenario: "success" as never }, new Date());

    const eid = ep.id.slice(3);
    const deliveries = await t.prisma.webhookDelivery.findMany({ where: { userId: a.userId, endpointId: eid } });
    const events = await t.prisma.event.findMany({ where: { id: { in: deliveries.map((d) => d.eventId) } }, select: { id: true, type: true } });
    // Fan-out created the two payment deliveries in the payment transaction; the deployed API created the test-event delivery.
    expect(events.map((e) => e.type).sort()).toEqual(["checkout.session.completed", "payment.succeeded", "webhook_endpoint.test"]);

    // 3. Wait for the deployed scheduler (Cron every minute) to deliver everything, including the retry after the 500.
    const deadline = Date.now() + 300_000;
    let all: Awaited<ReturnType<typeof t.prisma.webhookDelivery.findMany>> = [];
    while (Date.now() < deadline) {
      all = await t.prisma.webhookDelivery.findMany({ where: { userId: a.userId, endpointId: eid } });
      if (all.length === 3 && all.every((d) => d.status === "succeeded")) break;
      await sleep(5_000);
    }
    expect(all.length).toBe(3);
    expect(all.map((d) => d.status)).toEqual(["succeeded", "succeeded", "succeeded"]);

    const attempts = await t.prisma.webhookDeliveryAttempt.findMany({ where: { userId: a.userId }, orderBy: [{ deliveryId: "asc" }, { attemptNo: "asc" }] });
    const byDelivery = new Map<string, typeof attempts>();
    for (const x of attempts) byDelivery.set(x.deliveryId, [...(byDelivery.get(x.deliveryId) ?? []), x]);
    const typeOf = new Map<string, string>();
    for (const d of all) typeOf.set(d.id, d.eventId);
    let retried = 0;
    for (const d of all) {
      const xs = byDelivery.get(d.id)!;
      expect(xs.every((x) => !x.stale && !x.injected && x.signatureKind === "valid" && x.trigger === "scheduled")).toBe(true);
      expect(xs.map((x) => x.attemptNo)).toEqual(xs.map((_, i) => i + 1)); // contiguous numbering, no gaps
      if (xs.length === 2) {
        retried++;
        expect(xs[0]).toMatchObject({ outcome: "retryable", statusCode: 500 });
        expect(xs[1]).toMatchObject({ outcome: "success", statusCode: 200 });
        const delay = (xs[0]!.nextRetryAt!.getTime() - xs[0]!.createdAt.getTime()) / 1000;
        expect(delay).toBeGreaterThanOrEqual(23);
        expect(delay).toBeLessThanOrEqual(37); // 30 s +/- 20 % jitter
        expect(d.attemptCount).toBe(2);
      } else {
        expect(xs.length).toBe(1);
        expect(xs[0]).toMatchObject({ outcome: "success", statusCode: 200 });
        expect(d.attemptCount).toBe(1);
      }
    }
    expect(retried).toBe(1); // exactly the payment.succeeded delivery

    // 4. What the receiver saw: signed, identical bytes across the retry, correct delivery headers.
    const types = hits.map((h) => h.type).sort();
    expect(types).toEqual(["checkout.session.completed", "payment.succeeded", "payment.succeeded", "webhook_endpoint.test"]);
    for (const h of hits) {
      expect(verifyWebhookSignature({ header: h.headers["sandbox-signature"] as string, rawBody: h.body, secret }).ok).toBe(true);
      expect(h.headers["user-agent"]).toMatch(/^SandboxPayments-Webhooks\//);
      expect(h.headers["sandbox-delivery-id"]).toMatch(/^whd_/);
    }
    const pay = hits.filter((h) => h.type === "payment.succeeded");
    expect(pay[0]!.body).toBe(pay[1]!.body);
    expect(pay.map((h) => h.headers["sandbox-delivery-attempt"])).toEqual(["1", "2"]);
    expect(pay.map((h) => h.status)).toEqual([500, 200]);
    expect((pay[1]!.at - pay[0]!.at) / 1000).toBeGreaterThanOrEqual(20); // retry honours the backoff

    // 5. Tenant isolation through the deployed API.
    const anyDelivery = `whd_${all[0]!.id}`;
    expect((await api(a.auth, "GET", `/api/v1/webhook-deliveries/${anyDelivery}`)).status).toBe(200);
    expect((await api(b.auth, "GET", `/api/v1/webhook-deliveries/${anyDelivery}`)).status).toBe(404);
    expect((await api(b.auth, "GET", "/api/v1/webhook-deliveries")).json.data).toEqual([]);
    expect((await api(b.auth, "GET", `/api/v1/webhook-endpoints/${ep.id}`)).status).toBe(404);
    expect((await api(b.auth, "POST", `/api/v1/webhook-endpoints/${ep.id}/test`)).status).toBe(404);

    // 6. Scheduler health from the database's own records (Cron job, pg_net responses, lease row).
    const lease = (await t.sql("select last_finished_at, last_summary, lease_token is null as free from scheduler_leases where name = 'tick'")).rows[0];
    expect(Date.now() - new Date(lease.last_finished_at).getTime()).toBeLessThan(150_000);
    expect(lease.last_summary.errors).toBe(0);
    const runs = (await t.sql("select status from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'sandbox-scheduler-tick') and start_time > now() - interval '10 minutes'")).rows;
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs.every((r) => r.status === "succeeded")).toBe(true);
    const resp = (await t.sql("select status_code, timed_out from net._http_response where created > now() - interval '10 minutes'")).rows;
    expect(resp.length).toBeGreaterThanOrEqual(3);
    expect(resp.every((r) => r.status_code === 200 && r.timed_out === false)).toBe(true);

    // 7. Clean up the endpoint through the deployed API (soft delete); the harness removes the test users and every owned row.
    expect((await api(a.auth, "DELETE", `/api/v1/webhook-endpoints/${ep.id}`)).status).toBe(200);
  }, 420_000);
});
