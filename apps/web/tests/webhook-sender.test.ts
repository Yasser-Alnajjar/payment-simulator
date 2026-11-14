import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertNoEnvProxy, ProxyConfigError, sendWebhook, type Resolver } from "@/server/webhooks/sender";

/** Local receiver on 127.0.0.1 (no database). The private-target allowance is injected per call, never read from the environment. */
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
let handler: Handler = (_q, s) => { s.writeHead(200); s.end("ok"); };
const seen: { headers: http.IncomingHttpHeaders; body: string; remote: string | undefined }[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({ headers: req.headers, body, remote: req.socket.remoteAddress });
    handler(req, res, body);
  });
});
let port = 0;
beforeAll(async () => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); port = (server.address() as AddressInfo).port; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
afterEach(() => { seen.length = 0; handler = (_q, s) => { s.writeHead(200); s.end("ok"); }; });

const dev = { allowPrivate: true };
const send = (url: string, opts: Parameters<typeof sendWebhook>[1] = dev, body = '{"id":"evt_1"}') =>
  sendWebhook({ url, headers: { "content-type": "application/json", "sandbox-event-id": "evt_1" }, body }, opts);

describe("webhook sender (local receiver)", () => {
  it("delivers the exact body and headers, returns status and excerpt", async () => {
    handler = (_q, s) => { s.writeHead(201, { "content-type": "text/plain", "retry-after": "5", "x-secret": "nope" }); s.end("accepted\u0000\u0007!"); };
    const r = await send(`http://127.0.0.1:${port}/hook?a=1`);
    expect(r).toMatchObject({ kind: "response", status: 201, excerpt: "accepted!", truncated: false });
    if (r.kind === "response") expect(r.headers).toEqual({ "content-type": "text/plain", "retry-after": "5" });
    expect(seen[0]!.body).toBe('{"id":"evt_1"}');
    expect(seen[0]!.headers["sandbox-event-id"]).toBe("evt_1");
    expect(seen[0]!.headers.host).toBe(`127.0.0.1:${port}`);
  });
  it("reports 500 as a response (classification happens in the engine)", async () => {
    handler = (_q, s) => { s.writeHead(500); s.end("boom"); };
    expect(await send(`http://127.0.0.1:${port}/`)).toMatchObject({ kind: "response", status: 500 });
  });
  it("never follows redirects", async () => {
    handler = (_q, s) => { s.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }); s.end(); };
    const r = await send(`http://127.0.0.1:${port}/`);
    expect(r).toMatchObject({ kind: "response", status: 302 });
    expect(seen.length).toBe(1);
  });
  it("times out a slow receiver", async () => {
    handler = (_q, s) => { setTimeout(() => { s.writeHead(200); s.end(); }, 1500); };
    const r = await send(`http://127.0.0.1:${port}/`, { ...dev, limits: { totalMs: 300 } });
    expect(r).toMatchObject({ kind: "error", code: "timeout" });
  });
  it("stops reading an oversized response", async () => {
    handler = (_q, s) => { s.writeHead(200); s.end("x".repeat(600 * 1024)); };
    const r = await send(`http://127.0.0.1:${port}/`);
    expect(r).toMatchObject({ kind: "response", status: 200, truncated: true });
    if (r.kind === "response") expect(r.excerpt.length).toBe(1024);
  });
  it("reports a refused connection", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const p = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await send(`http://127.0.0.1:${p}/`)).toMatchObject({ kind: "error", code: "connect_error" });
  });
});

describe("webhook sender SSRF enforcement", () => {
  it("refuses private targets without the development allowance, before any connection", async () => {
    for (const u of [`https://127.0.0.1:${port}/`, "https://localhost/", "https://[::1]/", "https://169.254.169.254/", "https://10.0.0.1/"]) {
      expect(await send(u, { allowPrivate: false }), u).toMatchObject({ kind: "error", code: "ssrf_blocked" });
    }
    expect(await send(`http://example.com/`, { allowPrivate: false })).toMatchObject({ kind: "error", code: "invalid_url" });
    expect(seen.length).toBe(0);
  });
  it("refuses a host whose DNS answer contains any private address (mixed answers)", async () => {
    let calls = 0;
    const resolve: Resolver = async () => { calls++; return [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]; };
    expect(await send("https://hooks.example.com/x", { allowPrivate: false, resolve })).toMatchObject({ kind: "error", code: "ssrf_blocked" });
    expect(calls).toBe(1);
  });
  it("refuses a host that resolves to a private address", async () => {
    const resolve: Resolver = async () => [{ address: "::ffff:127.0.0.1", family: 6 }];
    expect(await send("https://hooks.example.com/x", { allowPrivate: false, resolve })).toMatchObject({ kind: "error", code: "ssrf_blocked" });
  });
  it("DNS rebinding: resolves once and connects to exactly the validated address", async () => {
    // A resolver that would answer differently on a second lookup. The sender must never ask twice and must connect to answer #1.
    let calls = 0;
    const resolve: Resolver = async () => (++calls === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "203.0.113.66", family: 4 }]);
    const r = await send(`http://rebind.sandbox-test.example:${port}/x`, { allowPrivate: true, resolve });
    expect(r).toMatchObject({ kind: "response", status: 200, address: "127.0.0.1" });
    expect(calls).toBe(1);
    expect(seen[0]!.headers.host).toBe(`rebind.sandbox-test.example:${port}`); // Host header keeps the original name
  });
  it("reports DNS failures", async () => {
    const resolve: Resolver = async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); };
    expect(await send("https://nope.example.com/", { allowPrivate: false, resolve })).toMatchObject({ kind: "error", code: "dns_error" });
    expect(await send("https://nope.example.com/", { allowPrivate: false, resolve: async () => [] })).toMatchObject({ kind: "error", code: "dns_error" });
  });
  it("bounds a hanging DNS lookup", async () => {
    const resolve: Resolver = () => new Promise(() => undefined);
    const t = Date.now();
    expect(await send("https://slow-dns.example.com/", { allowPrivate: false, resolve, limits: { dnsMs: 150 } })).toMatchObject({ kind: "error", code: "dns_error" });
    expect(Date.now() - t).toBeLessThan(2000);
  });
  it("refuses to run when NODE_USE_ENV_PROXY is set", async () => {
    expect(() => assertNoEnvProxy({ NODE_USE_ENV_PROXY: "1" })).toThrow(ProxyConfigError);
    expect(() => assertNoEnvProxy({})).not.toThrow();
    const prev = process.env.NODE_USE_ENV_PROXY;
    process.env.NODE_USE_ENV_PROXY = "1";
    try { await expect(send(`http://127.0.0.1:${port}/`)).rejects.toThrow(ProxyConfigError); } finally {
      if (prev === undefined) delete process.env.NODE_USE_ENV_PROXY; else process.env.NODE_USE_ENV_PROXY = prev;
    }
  });
});
