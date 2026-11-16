import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Payment Sandbox webhook. Copy this file into your project: it depends only on node:crypto.
 *
 *   Sandbox-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]
 *   v1 = hex( HMAC-SHA256( key = your "whsec_..." secret, message = `${t}.${rawBody}` ) )
 *
 * Rules that matter:
 *  1. Use the RAW request body, exactly as received. Parsing and re-serialising the JSON changes the bytes and breaks the signature.
 *  2. Compare in constant time (done below).
 *  3. Accept the request if ANY v1 matches ANY secret you hold. For 24 hours after a secret rotation we send two v1 values (new secret first),
 *     so during that window you may hold both the new and the old secret.
 *  4. Reject timestamps more than 5 minutes from now (replay protection).
 */
export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: "malformed_header" | "timestamp_out_of_tolerance" | "no_matching_signature" };

export const TOLERANCE_SECONDS = 300;

export function verifySandboxSignature(opts: {
  header: string | null | undefined;
  rawBody: string | Uint8Array;
  /** One secret, or two while you are rotating. */
  secrets: string | readonly string[];
  now?: Date;
  toleranceSeconds?: number;
}): VerifyResult {
  const parsed = parseHeader(opts.header);
  if (!parsed) return { ok: false, reason: "malformed_header" };

  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > (opts.toleranceSeconds ?? TOLERANCE_SECONDS)) return { ok: false, reason: "timestamp_out_of_tolerance" };

  const body = typeof opts.rawBody === "string" ? Buffer.from(opts.rawBody, "utf8") : Buffer.from(opts.rawBody);
  let matched = false;
  for (const secret of typeof opts.secrets === "string" ? [opts.secrets] : opts.secrets) {
    const expected = createHmac("sha256", secret).update(`${parsed.timestamp}.`, "utf8").update(body).digest();
    for (const candidate of parsed.signatures) {
      const got = Buffer.from(candidate, "hex");
      if (got.length === expected.length && timingSafeEqual(got, expected)) matched = true; // keep looping: no early exit
    }
  }
  return matched ? { ok: true, timestamp: parsed.timestamp } : { ok: false, reason: "no_matching_signature" };
}

function parseHeader(header: string | null | undefined): { timestamp: number; signatures: string[] } | null {
  if (!header || header.length > 1024) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) return null;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === "t") {
      if (!/^[0-9]{1,12}$/.test(value) || timestamp !== null) return null;
      timestamp = Number(value);
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/.test(value)) return null;
      signatures.push(value);
    } // other schemes are ignored so that new versions can be added without breaking you
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}
