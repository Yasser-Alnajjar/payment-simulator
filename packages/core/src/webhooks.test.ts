import { describe, expect, it } from "vitest";
import {
  buildSignatureHeader, classifyHttpStatus, classifySendError, computeSignature, generateWebhookSecret, isBlockedAddress, matchesEnabledEvents,
  normalizeEnabledEvents, parseRetryAfter, parsePublicId, parseSignatureHeader, retryDelaySeconds, toPublicId, validateWebhookUrl, verifyWebhookSignature,
} from "./index";

const body = '{"id":"evt_1","type":"payment.succeeded"}';
const now = new Date("2026-11-14T12:00:00Z");
const t = Math.floor(now.getTime() / 1000);

describe("webhook signatures", () => {
  const secret = generateWebhookSecret();
  it("generates whsec_ secrets with 32 random bytes", () => {
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(secret);
  });
  it("signs timestamp.body and verifies", () => {
    const h = buildSignatureHeader([secret], t, body);
    expect(h).toBe(`t=${t},v1=${computeSignature(secret, t, body)}`);
    expect(verifyWebhookSignature({ header: h, rawBody: body, secret, now })).toEqual({ ok: true, timestamp: t });
  });
  it("rejects a tampered body, a wrong secret and a stale or future timestamp", () => {
    const h = buildSignatureHeader([secret], t, body);
    expect(verifyWebhookSignature({ header: h, rawBody: body + " ", secret, now })).toEqual({ ok: false, reason: "no_matching_signature" });
    expect(verifyWebhookSignature({ header: h, rawBody: body, secret: generateWebhookSecret(), now })).toEqual({ ok: false, reason: "no_matching_signature" });
    expect(verifyWebhookSignature({ header: h, rawBody: body, secret, now: new Date(now.getTime() + 301_000) })).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
    expect(verifyWebhookSignature({ header: h, rawBody: body, secret, now: new Date(now.getTime() - 301_000) })).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
    expect(verifyWebhookSignature({ header: h, rawBody: body, secret, now: new Date(now.getTime() + 299_000) }).ok).toBe(true);
  });
  it("signature covers the exact bytes (re-serialized JSON does not verify)", () => {
    const h = buildSignatureHeader([secret], t, body);
    expect(verifyWebhookSignature({ header: h, rawBody: JSON.stringify(JSON.parse(body), null, 1), secret, now }).ok).toBe(false);
  });
  it("dual signatures after rotation: either secret verifies, a third does not", () => {
    const old = generateWebhookSecret();
    const h = buildSignatureHeader([secret, old], t, body);
    expect(h.split(",v1=").length).toBe(3);
    expect(verifyWebhookSignature({ header: h, rawBody: body, secret, now }).ok).toBe(true);
    expect(verifyWebhookSignature({ header: h, rawBody: body, secret: old, now }).ok).toBe(true);
    expect(verifyWebhookSignature({ header: h, rawBody: body, secret: generateWebhookSecret(), now }).ok).toBe(false);
  });
  it("rejects malformed headers", () => {
    for (const h of [null, "", "t=abc,v1=00", `v1=${"a".repeat(64)}`, `t=${t}`, `t=${t},v1=xyz`, `t=${t},t=${t},v1=${"a".repeat(64)}`, "garbage"]) {
      expect(parseSignatureHeader(h)).toBeNull();
      expect(verifyWebhookSignature({ header: h, rawBody: body, secret, now })).toEqual({ ok: false, reason: "malformed_header" });
    }
    expect(parseSignatureHeader(`t=${t},v0=zz,v1=${"a".repeat(64)}`)).toEqual({ timestamp: t, signatures: ["a".repeat(64)] });
  });
});

describe("retry policy", () => {
  it("doubles from 30 s, caps at 1 h, jitter within +/-20 %", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => retryDelaySeconds(n, mid))).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600]);
    expect(retryDelaySeconds(50, mid)).toBe(3600);
    expect(retryDelaySeconds(1, () => 0)).toBe(24);
    expect(retryDelaySeconds(1, () => 0.999999)).toBe(36);
    expect(retryDelaySeconds(12, () => 0.999999)).toBe(3600);
    for (let i = 0; i < 200; i++) {
      const d = retryDelaySeconds(3);
      expect(d).toBeGreaterThanOrEqual(96);
      expect(d).toBeLessThanOrEqual(144);
    }
  });
  it("classifies statuses", () => {
    expect([200, 204, 299].map(classifyHttpStatus)).toEqual(["success", "success", "success"]);
    expect([408, 429, 500, 502, 503, 599].map(classifyHttpStatus)).toEqual(Array(6).fill("retryable"));
    expect([100, 301, 302, 307, 400, 401, 403, 404, 410, 422].map(classifyHttpStatus)).toEqual(Array(10).fill("permanent"));
  });
  it("classifies send errors", () => {
    expect(classifySendError("timeout")).toBe("retryable");
    expect(classifySendError("connect_error")).toBe("retryable");
    expect(classifySendError("dns_error")).toBe("retryable");
    expect(classifySendError("ssrf_blocked")).toBe("permanent");
    expect(classifySendError("redirect_not_followed")).toBe("permanent");
    expect(classifySendError("invalid_url")).toBe("permanent");
  });
  it("parses Retry-After", () => {
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter("999999", now)).toBe(3600);
    expect(parseRetryAfter(new Date(now.getTime() + 90_000).toUTCString(), now)).toBe(90);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe("SSRF address policy", () => {
  const blocked = [
    "0.0.0.0", "0.255.255.255", "10.0.0.0", "10.255.255.255", "100.64.0.0", "100.127.255.255", "127.0.0.1", "127.255.255.255",
    "169.254.0.0", "169.254.169.254", "169.254.255.255", "172.16.0.0", "172.31.255.255", "192.0.0.0", "192.0.0.255", "192.0.2.1",
    "192.88.99.1", "192.168.0.0", "192.168.255.255", "198.18.0.0", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1",
    "239.255.255.255", "240.0.0.1", "255.255.255.255", "192.31.196.1", "192.52.193.1", "192.175.48.1",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::127.0.0.1", "64:ff9b::808:808", "64:ff9b:1::1", "100::1",
    "fc00::1", "fd00:ec2::254", "fdff:ffff::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "2001::1", "2001:0:abcd::1",
    "2001:1ff:ffff::1", "2001:db8::1", "2002:7f00:1::1", "3fff::1", "3fff:fff::1", "fe80::1%eth0", "not-an-ip", "",
  ];
  const allowed = [
    "1.1.1.1", "8.8.8.8", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0",
    "169.253.255.255", "169.255.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "198.17.255.255",
    "198.20.0.0", "223.255.255.255", "2606:4700:4700::1111", "2a00:1450:4001::200e", "2001:200::1", "2001:4860:4860::8888",
    "2003::1", "3ffe::1", "3fff:1000::1",
  ];
  for (const a of blocked) it(`blocks ${a || "(empty)"}`, () => expect(isBlockedAddress(a)).toBe(true));
  for (const a of allowed) it(`allows ${a}`, () => expect(isBlockedAddress(a)).toBe(false));
});

describe("SSRF URL validation", () => {
  const ok = (u: string, o = {}) => { const r = validateWebhookUrl(u, o); if (!r.ok) throw new Error(`${u}: ${r.code}`); return r.target; };
  const code = (u: string, o = {}) => { const r = validateWebhookUrl(u, o); return r.ok ? "ok" : r.code; };

  it("accepts public https URLs and normalizes the host", () => {
    expect(ok("https://example.com/hooks?x=1")).toMatchObject({ host: "example.com", port: 443, ipLiteral: null });
    expect(ok("https://Example.COM.:8443/a")).toMatchObject({ host: "example.com", port: 8443 });
    expect(ok("https://bücher.example/hook").host).toBe("xn--bcher-kva.example");
    expect(ok("https://8.8.8.8/x")).toMatchObject({ ipLiteral: "8.8.8.8" });
    expect(ok("https://[2606:4700:4700::1111]/x").ipLiteral).toBe("2606:4700:4700::1111");
  });
  it("rejects schemes, credentials, fragments, length, control characters", () => {
    expect(code("http://example.com/")).toBe("scheme_not_allowed");
    expect(code("ftp://example.com/")).toBe("scheme_not_allowed");
    expect(code("file:///etc/passwd")).toBe("scheme_not_allowed");
    expect(code("https://user:pw@example.com/")).toBe("credentials_in_url");
    expect(code("https://user@example.com/")).toBe("credentials_in_url");
    expect(code("https://example.com/#x")).toBe("fragment_not_allowed");
    expect(code("https://example.com/#")).toBe("fragment_not_allowed");
    expect(code(`https://example.com/${"a".repeat(2048)}`)).toBe("url_too_long");
    expect(code("https://exa mple.com/")).toBe("invalid_url");
    expect(code("not a url")).toBe("invalid_url");
    expect(code("")).toBe("invalid_url");
  });
  it("rejects disallowed ports", () => {
    for (const p of [22, 25, 135, 445, 1023, 0]) expect(code(`https://example.com:${p}/`)).toBe(p === 0 ? "port_not_allowed" : "port_not_allowed");
    expect(code("https://example.com:80/")).toBe("ok");
    expect(code("https://example.com:1024/")).toBe("ok");
  });
  it("rejects private IP literals including numeric encodings normalized by the URL parser", () => {
    for (const u of [
      "https://127.0.0.1/", "https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/", "https://127.1/", "https://10.1.2.3/",
      "https://169.254.169.254/latest/meta-data", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:7f00:1]/", "https://[fd00::1]/",
      "https://[fe80::1]/", "https://0.0.0.0/", "https://[::]/",
    ]) expect(code(u), u).toBe("private_address");
  });
  it("rejects local and internal host names and single labels", () => {
    for (const u of ["https://localhost/", "https://LOCALHOST./", "https://api.localhost/", "https://printer.local/", "https://db.internal/", "https://metadata.google.internal/", "https://router.home.arpa/", "https://intranet/", "https://box.lan/", "https://x.corp/"]) expect(code(u), u).toBe("host_not_allowed");
  });
  it("development allowance permits http, localhost and private literals but still rejects credentials and fragments", () => {
    const dev = { allowPrivate: true };
    expect(code("http://localhost:4000/hook", dev)).toBe("ok");
    expect(code("http://127.0.0.1:4000/hook", dev)).toBe("ok");
    expect(code("http://u:p@127.0.0.1/", dev)).toBe("credentials_in_url");
    expect(code("ftp://127.0.0.1/", dev)).toBe("scheme_not_allowed");
  });
});

describe("subscriptions and ids", () => {
  it("normalizes enabled events", () => {
    expect(normalizeEnabledEvents(["*"])).toEqual({ ok: true, value: ["*"] });
    expect(normalizeEnabledEvents(["payment.succeeded", "payment.failed", "payment.succeeded"])).toEqual({ ok: true, value: ["payment.failed", "payment.succeeded"] });
    expect(normalizeEnabledEvents([]).ok).toBe(false);
    expect(normalizeEnabledEvents(["*", "payment.failed"]).ok).toBe(false);
    expect(normalizeEnabledEvents(["payment.refunded"]).ok).toBe(false);
  });
  it("matches subscriptions", () => {
    expect(matchesEnabledEvents("payment.failed", ["*"])).toBe(true);
    expect(matchesEnabledEvents("payment.failed", ["payment.failed"])).toBe(true);
    expect(matchesEnabledEvents("payment.succeeded", ["payment.failed"])).toBe(false);
  });
  it("public ids for endpoints and deliveries", () => {
    const u = "0b0e4a52-3a0b-4f6a-9d2e-1f2a3b4c5d6e";
    expect(toPublicId("webhookEndpoint", u)).toBe(`we_${u}`);
    expect(parsePublicId("webhookDelivery", `whd_${u}`)).toBe(u);
    expect(parsePublicId("webhookDelivery", `we_${u}`)).toBeNull();
  });
});
