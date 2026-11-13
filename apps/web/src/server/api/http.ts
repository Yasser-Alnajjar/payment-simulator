import { randomBytes } from "node:crypto";
import { ApiError, invalidRequest } from "./errors";
import { RawJson } from "./dto";

export const MAX_BODY_BYTES = 64 * 1024;

export const newRequestId = () => `req_${randomBytes(12).toString("base64url")}`;

export interface ApiResult {
  status: number;
  body: unknown | RawJson;
  headers?: Record<string, string>;
}

export function toResponse(r: ApiResult, requestId: string, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "request-id": requestId, ...extra, ...r.headers });
  const text = r.body instanceof RawJson ? r.body.text : JSON.stringify(r.body);
  return new Response(text, { status: r.status, headers });
}

export function errorResponse(e: ApiError, requestId: string, extra: Record<string, string> = {}): Response {
  const body = { error: { type: e.type, code: e.code, message: e.message, ...(e.param ? { param: e.param } : {}), request_id: requestId } };
  return toResponse({ status: e.status, body, headers: e.headers }, requestId, extra);
}

/** Reads a JSON object body with a hard size cap, enforced while streaming (a missing or lying Content-Length does not help). */
export async function readJsonBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(ct)) throw new ApiError(415, "invalid_request_error", "unsupported_media_type", "Content-Type must be application/json");
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) throw new ApiError(413, "invalid_request_error", "body_too_large", `Request body must be at most ${maxBytes} bytes`);
  if (!req.body) throw invalidRequest("invalid_json", "A JSON body is required");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(413, "invalid_request_error", "body_too_large", `Request body must be at most ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  if (total === 0) throw invalidRequest("invalid_json", "A JSON body is required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalidRequest("invalid_json", "Body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalidRequest("invalid_json", "Body must be a JSON object");
  return parsed as Record<string, unknown>;
}
