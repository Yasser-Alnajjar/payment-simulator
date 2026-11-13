import { describe, expect, it } from "vitest";
import { parseBasic, clientIp } from "@/server/api/auth";
import { ApiError } from "@/server/api/errors";
import { errorResponse, MAX_BODY_BYTES, newRequestId, readJsonBody, toResponse } from "@/server/api/http";
import { RawJson, rawList } from "@/server/api/dto";
import { createSessionBody, parseMoney, parseWith, queryObject } from "@/server/api/validation";
import { isUniqueViolation } from "@/server/db-errors";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const jsonReq = (body: BodyInit | null, headers: Record<string, string> = { "content-type": "application/json" }) => new Request("http://x/y", { method: "POST", headers, body });
const err = async (p: Promise<unknown> | (() => unknown)) => { try { await (typeof p === "function" ? p() : p); return null; } catch (e) { return e as ApiError; } };

describe("API building blocks (unit)", () => {
  it("parses Basic credentials strictly", () => {
    expect(parseBasic(`Basic ${b64("id:secret")}`)).toEqual({ clientId: "id", secret: "secret" });
    expect(parseBasic(`basic ${b64("id:se:cret")}`)).toEqual({ clientId: "id", secret: "se:cret" });
    for (const bad of [null, "", "Basic", "Basic ", "Bearer x", `Basic ${b64("nocolon")}`, `Basic ${b64(":secret")}`, `Basic ${b64("id:")}`, `Basic ${"A".repeat(700)}`, `Basic ${b64("x".repeat(101) + ":s")}`]) {
      expect(parseBasic(bad), String(bad)).toBeNull();
    }
  });
  it("takes the client address from the first forwarded hop only", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }))).toBe("1.2.3.4");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
  it("request ids are unique and prefixed", () => {
    expect(newRequestId()).toMatch(/^req_[A-Za-z0-9_-]{16}$/);
    expect(newRequestId()).not.toBe(newRequestId());
  });
  it("renders the documented error envelope with request id, WWW-Authenticate and no CORS", async () => {
    const e = new ApiError(401, "authentication_error", "invalid_credentials", "Invalid API credentials", undefined, { "www-authenticate": 'Basic realm="x"' });
    const r = errorResponse(e, "req_1");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe('Basic realm="x"');
    expect(r.headers.get("request-id")).toBe("req_1");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect([...r.headers.keys()].some((k) => k.startsWith("access-control"))).toBe(false);
    expect(await r.json()).toEqual({ error: { type: "authentication_error", code: "invalid_credentials", message: "Invalid API credentials", request_id: "req_1" } });
    const p = errorResponse(new ApiError(400, "invalid_request_error", "invalid_parameter", "bad", "amount"), "req_2");
    expect((await p.json()).error.param).toBe("amount");
  });
  it("serves pre-serialized event bytes verbatim", async () => {
    const raw = '{"b":1,  "a":2}';
    expect(await toResponse({ status: 200, body: new RawJson(raw) }, "r").text()).toBe(raw);
    expect(rawList(["{}", "[]"], true).text).toBe('{"object":"list","data":[{},[]],"has_more":true}');
  });
  it("reads JSON bodies with a hard cap enforced while streaming", async () => {
    expect(await readJsonBody(jsonReq('{"a":1}'))).toEqual({ a: 1 });
    expect((await err(readJsonBody(jsonReq("x".repeat(MAX_BODY_BYTES + 1)))))?.status).toBe(413);
    const noLength = new Request("http://x/y", { method: "POST", headers: { "content-type": "application/json" }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{\"k\":\"")); c.enqueue(new Uint8Array(MAX_BODY_BYTES)); c.close(); } }), duplex: "half" } as RequestInit);
    expect((await err(readJsonBody(noLength)))?.status).toBe(413);
    expect((await err(readJsonBody(jsonReq("{}", { "content-type": "text/plain" }))))?.status).toBe(415);
    expect((await err(readJsonBody(jsonReq("{}", { "content-type": "application/jsonx" }))))?.status).toBe(415);
    expect((await err(readJsonBody(jsonReq("[]"))))?.code).toBe("invalid_json");
    expect((await err(readJsonBody(jsonReq("null"))))?.code).toBe("invalid_json");
    expect((await err(readJsonBody(jsonReq("{"))))?.code).toBe("invalid_json");
    expect(await readJsonBody(jsonReq("{}", { "content-type": "application/json; charset=utf-8" }))).toEqual({});
  });
  it("validates create-session bodies strictly and maps money errors to parameters", () => {
    expect(parseWith(createSessionBody, { amount: "1.00", currency: "USD" })).toEqual({ amount: "1.00", currency: "USD" });
    expect((() => { try { parseWith(createSessionBody, { amount: "1", currency: "USD", extra: 1 }); } catch (e) { return e as ApiError; } })()?.code).toBe("unknown_parameter");
    expect(() => parseMoney("1.001", "USD")).toThrowError(/decimal places/);
    expect((() => { try { parseMoney("1", "ZZZ"); } catch (e) { return e as ApiError; } })()?.param).toBe("currency");
    expect(parseMoney("12.5", "KWD")).toBe(12500n);
  });
  it("query objects keep the first value of repeated keys", () => {
    expect(queryObject(new URL("http://x/?a=1&a=2&b=3"))).toEqual({ a: "1", b: "3" });
  });
  it("recognizes unique violations in every driver shape, optionally by constraint", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation(new Error("x", { cause: { code: "23505" } }))).toBe(true);
    expect(isUniqueViolation(new Error('violates unique constraint "transactions_one_active_per_session"'), "transactions_one_active_per_session")).toBe(true);
    expect(isUniqueViolation(new Error("connection reset"))).toBe(false);
  });
});
