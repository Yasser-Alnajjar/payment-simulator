import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signatures.
 *
 *   Sandbox-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]
 *   v1 = hex(HMAC-SHA256(key = the endpoint secret string "whsec_...", message = t + "." + raw body bytes))
 *
 * During the 24 hours after a secret rotation two v1 values are sent (new secret first). A receiver accepts the request when any
 * v1 matches its secret and the timestamp is within the tolerance. Verification must use the raw body bytes, never re-serialized JSON.
 */
export const SIGNATURE_HEADER = "sandbox-signature";
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function computeSignature(secret: string, timestamp: number, rawBody: string | Uint8Array): string {
  const h = createHmac("sha256", secret);
  h.update(`${timestamp}.`, "utf8");
  h.update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody);
  return h.digest("hex");
}

export function buildSignatureHeader(secrets: readonly string[], timestamp: number, rawBody: string | Uint8Array): string {
  if (secrets.length === 0) throw new Error("At least one secret is required");
  return [`t=${timestamp}`, ...secrets.map((s) => `v1=${computeSignature(s, timestamp, rawBody)}`)].join(",");
}

export function parseSignatureHeader(header: string | null | undefined): { timestamp: number; signatures: string[] } | null {
  if (!header || header.length > 1024) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) return null;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") {
      if (!/^[0-9]{1,12}$/.test(v) || timestamp !== null) return null;
      timestamp = Number(v);
    } else if (k === "v1") {
      if (!/^[0-9a-f]{64}$/.test(v)) return null;
      signatures.push(v);
    } // unknown schemes are ignored, so future versions can be added without breaking receivers
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export type VerifyFailure = "malformed_header" | "timestamp_out_of_tolerance" | "no_matching_signature";

/** Reference receiver-side verification (constant-time comparison, timestamp tolerance, any matching v1). */
export function verifyWebhookSignature(opts: {
  header: string | null | undefined;
  rawBody: string | Uint8Array;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}): { ok: true; timestamp: number } | { ok: false; reason: VerifyFailure } {
  const parsed = parseSignatureHeader(opts.header);
  if (!parsed) return { ok: false, reason: "malformed_header" };
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSec - parsed.timestamp) > (opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return { ok: false, reason: "timestamp_out_of_tolerance" };
  const expected = Buffer.from(computeSignature(opts.secret, parsed.timestamp, opts.rawBody), "hex");
  let match = false;
  for (const s of parsed.signatures) {
    const got = Buffer.from(s, "hex");
    if (got.length === expected.length && timingSafeEqual(got, expected)) match = true; // no early exit
  }
  return match ? { ok: true, timestamp: parsed.timestamp } : { ok: false, reason: "no_matching_signature" };
}
