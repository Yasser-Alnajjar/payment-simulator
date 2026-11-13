import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted recursively, no whitespace. Only JSON-compatible values are accepted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new TypeError(`unsupported value type: ${typeof value}`);
}

/** Idempotency fingerprint over method, endpoint, API version and the canonical body. */
export function requestFingerprint(method: string, endpoint: string, apiVersion: string, body: unknown): string {
  return createHash("sha256").update([method.toUpperCase(), endpoint, apiVersion, canonicalJson(body ?? null)].join("\n"), "utf8").digest("hex");
}
