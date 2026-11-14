import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { isBlockedAddress, validateWebhookUrl, type SendErrorCode } from "@sandbox/core";

/**
 * SSRF-safe webhook HTTP client (Node runtime; runs inside the Vercel function that serves the scheduler tick).
 *
 *  1. The URL is re-validated on every attempt (scheme, credentials, fragment, port, host names, IP literals).
 *  2. DNS is resolved once here; if ANY returned address is private/reserved the request is refused (no mixed answers).
 *  3. The socket connects to the validated address through a custom `lookup` that can only return that address, so a second
 *     resolution (DNS rebinding) is impossible. TLS still verifies the certificate against the original host name (SNI).
 *  4. Redirects are never followed (Node's http client does not follow them; a 3xx is reported to the caller as is).
 *  5. Hard limits: DNS 5 s, connect 5 s, whole exchange 10 s after DNS (worst case ~15 s per send), response headers 16 KB, body read at most 256 KB, 1 KB kept.
 *  6. A fresh agent without keep-alive per request; refuses to run when NODE_USE_ENV_PROXY would route requests through a proxy.
 */
export const SEND_LIMITS = { dnsMs: 5_000, connectMs: 5_000, totalMs: 10_000, maxHeaderBytes: 16 * 1024, maxBodyReadBytes: 256 * 1024, excerptChars: 1024, maxRequestBytes: 256 * 1024 } as const;
const KEPT_HEADERS = ["content-type", "content-length", "retry-after"] as const;

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export const systemResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

export interface SenderOptions {
  /** Development/test only: permit http, localhost and private addresses. */
  allowPrivate: boolean;
  resolve?: Resolver;
  limits?: Partial<Record<keyof typeof SEND_LIMITS, number>>;
  /** Test only: extra TLS trust (e.g. a self-signed test certificate). */
  ca?: string | Buffer;
}

export type SendResult =
  | { kind: "response"; status: number; durationMs: number; excerpt: string; headers: Record<string, string>; truncated: boolean; address: string }
  | { kind: "error"; code: SendErrorCode; durationMs: number };

export class ProxyConfigError extends Error {}

export function assertNoEnvProxy(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_USE_ENV_PROXY && env.NODE_USE_ENV_PROXY !== "0") throw new ProxyConfigError("NODE_USE_ENV_PROXY is set: webhook requests could be routed through a proxy, refusing to send");
}

const TLS_CODES = /^(CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|HOSTNAME_MISMATCH)/;
const CONNECT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ECONNABORTED", "EADDRNOTAVAIL", "HPE_HEADER_OVERFLOW", "HPE_INVALID_CONSTANT", "HPE_INVALID_STATUS"]);

function mapError(e: unknown): SendErrorCode {
  const code = (e as { code?: string })?.code ?? "";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
  if (TLS_CODES.test(code)) return "tls_error";
  if (CONNECT_CODES.has(code)) return "connect_error";
  return "unknown_error";
}

/** Keeps printable text only, so a receiver cannot inject control characters into the dashboard or logs. */
function sanitizeExcerpt(s: string, max: number): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
}

export async function sendWebhook(req: { url: string; headers: Record<string, string>; body: string }, opts: SenderOptions): Promise<SendResult> {
  assertNoEnvProxy();
  const limits = { ...SEND_LIMITS, ...opts.limits };
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  const v = validateWebhookUrl(req.url, { allowPrivate: opts.allowPrivate });
  if (!v.ok) return { kind: "error", code: v.code === "private_address" || v.code === "host_not_allowed" ? "ssrf_blocked" : "invalid_url", durationMs: elapsed() };
  if (Buffer.byteLength(req.body) > limits.maxRequestBytes) return { kind: "error", code: "invalid_url", durationMs: elapsed() };
  const target = v.target;

  let addresses: { address: string; family: number }[];
  if (target.ipLiteral) addresses = [{ address: target.ipLiteral, family: target.ipLiteral.includes(":") ? 6 : 4 }];
  else {
    try {
      // getaddrinfo has no timeout of its own and runs before the request timers start, so bound it explicitly.
      let dnsTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new Error("dns timeout")), limits.dnsMs); });
      try { addresses = await Promise.race([(opts.resolve ?? systemResolver)(target.host), timeout]); } finally { clearTimeout(dnsTimer); }
    } catch {
      return { kind: "error", code: "dns_error", durationMs: elapsed() };
    }
  }
  if (addresses.length === 0) return { kind: "error", code: "dns_error", durationMs: elapsed() };
  if (!opts.allowPrivate && addresses.some((a) => isBlockedAddress(a.address))) return { kind: "error", code: "ssrf_blocked", durationMs: elapsed() };
  const pinned = addresses[0]!;
  const family = pinned.family === 6 ? 6 : 4;

  // The ONLY address the socket may use. Handles both the single-result and the `all: true` forms Node may request.
  const pinnedLookup = ((_host: string, options: { all?: boolean } | number | undefined, cb: (...args: unknown[]) => void) => {
    const callback = typeof options === "function" ? (options as unknown as typeof cb) : cb;
    const wantsAll = typeof options === "object" && options !== null && options.all === true;
    if (wantsAll) callback(null, [{ address: pinned.address, family }]);
    else callback(null, pinned.address, family);
  }) as unknown as LookupFunction;

  const isHttps = target.url.protocol === "https:";
  const lib = isHttps ? https : http;
  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const finish = (r: SendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      resolve(r);
    };
    const request = lib.request(
      {
        protocol: target.url.protocol,
        hostname: target.ipLiteral ?? target.host,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        method: "POST",
        headers: { ...req.headers, host: target.url.host, "content-length": String(Buffer.byteLength(req.body)) },
        lookup: pinnedLookup,
        family,
        agent: false,
        maxHeaderSize: limits.maxHeaderBytes,
        ...(isHttps ? { servername: target.ipLiteral ? undefined : target.host, rejectUnauthorized: true, ...(opts.ca ? { ca: opts.ca } : {}) } : {}),
      },
      (res) => {
        clearTimeout(connectTimer);
        const status = res.statusCode ?? 0;
        const headers: Record<string, string> = {};
        for (const h of KEPT_HEADERS) {
          const val = res.headers[h];
          if (typeof val === "string") headers[h] = val.slice(0, 200);
        }
        const chunks: Buffer[] = [];
        let kept = 0;
        let read = 0;
        let truncated = false;
        const done = () => finish({ kind: "response", status, durationMs: elapsed(), excerpt: sanitizeExcerpt(Buffer.concat(chunks).toString("utf8"), limits.excerptChars), headers, truncated, address: pinned.address });
        res.on("data", (c: Buffer) => {
          read += c.length;
          if (kept < limits.excerptChars * 4) { chunks.push(c.subarray(0, limits.excerptChars * 4 - kept)); kept += Math.min(c.length, limits.excerptChars * 4 - kept); }
          if (read > limits.maxBodyReadBytes) {
            truncated = true;
            done();
            res.destroy();
          }
        });
        res.on("end", done);
        res.on("error", () => done()); // status already known; a broken body does not change the outcome
        res.on("aborted", () => done());
      },
    );
    const connectTimer = setTimeout(() => { request.destroy(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })); }, limits.connectMs);
    const totalTimer = setTimeout(() => { request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })); }, limits.totalMs);
    request.on("socket", (s) => {
      s.once(isHttps ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
    });
    request.on("error", (e) => finish({ kind: "error", code: mapError(e), durationMs: elapsed() }));
    request.end(req.body);
  });
}
