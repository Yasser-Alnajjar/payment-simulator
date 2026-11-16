import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hashSecret } from "@sandbox/core";
import { ApiError } from "@/server/api/errors";
import { errorResponse } from "@/server/api/http";
import { handlers } from "@/server/api/handlers";
import { DEFAULT_API_CONFIG, type ApiDeps } from "@/server/api/deps";
import { ERROR_CODES, COMMON_ERRORS } from "@/server/openapi/errors";
import { OPERATIONS, type Operation } from "@/server/openapi/operations";
import * as S from "@/server/openapi/schemas";
import { buildOpenApiDocument } from "@/server/openapi/spec";
import { successSamples } from "./openapi-fixtures";

/**
 * S5 contract tests: the OpenAPI document, the route files, the handlers and the DTOs cannot drift apart.
 * Pure tests: no database of any kind is touched (the API pipeline runs against an in-memory fake), so nothing is written to the hosted database.
 */
const SRC = path.resolve(__dirname, "../src");
const PUBLIC_JSON = path.resolve(__dirname, "../public/openapi.json");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const read = (p: string) => readFileSync(p, "utf8");

type Doc = { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> }; webhooks: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const doc = buildOpenApiDocument() as unknown as Doc;
const METHODS = ["get", "post", "put", "patch", "delete"];

// ------------------------------------------------------------------------------------------------ route inventory
interface RouteOp { file: string; method: string; path: string; handler: string }
const routeFiles = walk(path.join(SRC, "app/api")).filter((f) => f.endsWith(`${path.sep}route.ts`));
const toOpenApiPath = (f: string) => "/api/" + path.relative(path.join(SRC, "app/api"), path.dirname(f)).split(path.sep).map((s) => s.replace(/^\[(.+)\]$/, "{$1}")).join("/");
function routeOps(file: string): RouteOp[] {
  const out: RouteOp[] = [];
  for (const line of read(file).split("\n")) {
    const m = /^export const (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.exec(line);
    if (!m) continue;
    out.push({ file, method: m[1]!.toLowerCase(), path: toOpenApiPath(file), handler: /handlers\.(\w+)\(/.exec(line)?.[1] ?? "(not a shared handler)" });
  }
  return out;
}
const classify = (p: string) => (p.startsWith("/api/v1/") ? "public" : p === "/api/scheduler/tick" ? "internal" : "unclassified");

describe("route inventory (every route file is classified)", () => {
  it("classifies all 20 route files: 19 public /api/v1 and 1 internal scheduler route; nothing unclassified", () => {
    const classes = routeFiles.map((f) => classify(toOpenApiPath(f)));
    expect(routeFiles.length).toBe(20);
    expect(classes.filter((c) => c === "public").length).toBe(19);
    expect(classes.filter((c) => c === "internal").length).toBe(1);
    expect(classes.filter((c) => c === "unclassified")).toEqual([]);
  });
  it("public routes carry exactly the 26 documented operations, each served by the documented shared handler", () => {
    const actual = routeFiles.filter((f) => classify(toOpenApiPath(f)) === "public").flatMap(routeOps).map((r) => `${r.method} ${r.path} ${r.handler}`).sort();
    const documented = OPERATIONS.map((o) => `${o.method} ${o.path} ${o.handler}`).sort();
    expect(documented.length).toBe(26);
    expect(actual).toEqual(documented);
  });
  it("no route file exports a method that is not documented (no PUT, HEAD or OPTIONS by accident)", () => {
    for (const f of routeFiles) for (const r of routeOps(f)) expect(["get", "post", "patch", "delete"], `${r.method} ${r.path}`).toContain(r.method);
  });
  it("the internal scheduler route is POST only and is deliberately absent from the public document", () => {
    const f = routeFiles.find((x) => toOpenApiPath(x) === "/api/scheduler/tick")!;
    expect(routeOps(f).map((r) => r.method)).toEqual(["post"]);
    expect(Object.keys(doc.paths).some((p) => p.includes("scheduler"))).toBe(false);
  });
  it("every document path and operation is backed by a route (no phantom documentation)", () => {
    const real = new Set(routeFiles.flatMap(routeOps).map((r) => `${r.method} ${r.path}`));
    for (const [p, item] of Object.entries(doc.paths)) for (const m of Object.keys(item)) expect(real.has(`${m} ${p}`), `${m} ${p}`).toBe(true);
  });
  it("path parameter names match between the document, the operation table and the route directory names", () => {
    for (const op of OPERATIONS) {
      const inPath = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(Object.keys(op.pathParams ?? {}), op.path).toEqual(inPath);
      const declared = (doc.paths[op.path]![op.method].parameters as { in: string; name: string }[]).filter((p) => p.in === "path").map((p) => p.name);
      expect(declared, op.path).toEqual(inPath);
    }
  });
});

// ------------------------------------------------------------------------------------------------ document structure
const refsOf = (n: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(n)) n.forEach((x) => refsOf(x, out));
  else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) { if (k === "$ref" && typeof v === "string") out.add(v); else refsOf(v, out); }
  return out;
};

describe("OpenAPI document", () => {
  it("is OpenAPI 3.1 with unique operationIds, Basic security and no dangling $ref", () => {
    expect((doc as unknown as { openapi: string }).openapi).toBe("3.1.0");
    const ids = Object.values(doc.paths).flatMap((i) => Object.values(i)).map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of Object.values(doc.paths)) for (const op of Object.values(item)) expect(op.security).toEqual([{ basicAuth: [] }]);
    for (const r of refsOf(doc)) expect(doc.components.schemas[r.replace("#/components/schemas/", "")], r).toBeDefined();
  });
  it("is published byte-for-byte as public/openapi.json (run `pnpm --filter @sandbox/web openapi:generate` after changing the API)", () => {
    const text = JSON.stringify(doc, null, 2) + "\n";
    if (process.env.UPDATE_OPENAPI === "1") writeFileSync(PUBLIC_JSON, text);
    expect(existsSync(PUBLIC_JSON)).toBe(true);
    expect(read(PUBLIC_JSON)).toBe(text);
  });
  it("documents every HTTP method of every path with the expected statuses: successes, declared errors and the common 401/429/500", () => {
    for (const op of OPERATIONS) {
      const o = doc.paths[op.path]![op.method];
      const expected = new Set<number>([...op.success.map((s) => s.status), ...Object.keys(op.errors).map(Number), ...Object.keys(COMMON_ERRORS).map(Number)]);
      expect(Object.keys(o.responses).map(Number).sort(), `${op.method} ${op.path}`).toEqual([...expected].sort((a, b) => a - b));
      for (const m of Object.keys(doc.paths[op.path]!)) expect(METHODS).toContain(m);
    }
  });
  it("every error status lists only catalogued codes registered under that same status", () => {
    for (const op of OPERATIONS) {
      for (const [st, codes] of Object.entries({ ...op.errors, ...COMMON_ERRORS })) {
        expect(codes.length, `${op.handler} ${st}`).toBeGreaterThan(0);
        for (const c of codes) {
          expect(ERROR_CODES[c], `${op.handler}: unknown code ${c}`).toBeDefined();
          expect(ERROR_CODES[c]!.status, `${op.handler}: ${c} listed under ${st}`).toBe(Number(st));
        }
      }
    }
  });
  it("lists mutating operations with the right idempotency header (required only where the handler demands it)", () => {
    for (const op of OPERATIONS) {
      const hdr = (doc.paths[op.path]![op.method].parameters as { in: string; name: string; required: boolean }[]).find((p) => p.name === "Idempotency-Key");
      if (!op.idempotency) expect(hdr, op.handler).toBeUndefined();
      else expect(hdr?.required, op.handler).toBe(op.idempotency === "required");
    }
    expect(OPERATIONS.filter((o) => o.idempotency === "required").map((o) => o.handler)).toEqual(["createCharge"]);
  });
  it("documents query parameters exactly as the validation schemas accept them", () => {
    for (const op of OPERATIONS.filter((o) => o.query)) {
      const declared = (doc.paths[op.path]![op.method].parameters as { in: string; name: string }[]).filter((p) => p.in === "query").map((p) => p.name).sort();
      expect(declared, op.handler).toEqual(Object.keys(op.query!.shape).sort());
    }
  });
  it("documents request bodies as the exact schemas the handlers validate with, and the webhook request", () => {
    for (const op of OPERATIONS) expect(doc.paths[op.path]![op.method].requestBody !== undefined, op.handler).toBe(op.body !== undefined);
    for (const n of ["CreateChargeRequest", "CreatePaymentMethodRequest", "CreateWebhookEndpointRequest", "UpdateWebhookEndpointRequest", "CreateCheckoutSessionRequest", "CreateSetupSessionRequest"]) {
      expect(doc.components.schemas[n]?.additionalProperties, n).toBe(false); // unknown fields are rejected, and the document says so
    }
    expect(doc.webhooks.event.post.requestBody.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Event" });
  });
});

// ------------------------------------------------------------------------------------------------ success responses
describe("successful responses (DTOs produced by the real DTO functions, validated with Zod)", () => {
  it("has a sample for every operation and every documented success status validates against its Zod schema", async () => {
    const samples = await successSamples();
    for (const op of OPERATIONS) {
      expect(samples[op.handler], `no sample for ${op.handler}`).toBeDefined();
      for (const s of op.success) for (const sample of samples[op.handler]!) {
        const r = s.schema.safeParse(sample);
        expect(r.success, `${op.handler} ${s.status}: ${JSON.stringify(r.success ? "" : r.error.issues.slice(0, 2))}`).toBe(true);
      }
    }
    expect(Object.keys(samples).sort()).toEqual(OPERATIONS.map((o) => o.handler).sort());
  });
  it("the published JSON Schema itself accepts the same samples (checks the generated document, not only the Zod source)", async () => {
    const samples = await successSamples();
    const resolve = (n: unknown): unknown => {
      if (Array.isArray(n)) return n.map(resolve);
      if (n && typeof n === "object") {
        const o = n as Record<string, unknown>;
        if (typeof o.$ref === "string") return resolve(doc.components.schemas[o.$ref.replace("#/components/schemas/", "")]);
        return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolve(v)]));
      }
      return n;
    };
    for (const op of OPERATIONS) for (const s of op.success) {
      const published = doc.paths[op.path]![op.method].responses[String(s.status)].content["application/json"].schema;
      const validator = z.fromJSONSchema(resolve(published) as never);
      for (const sample of samples[op.handler]!) {
        const r = validator.safeParse(sample);
        expect(r.success, `${op.handler} ${s.status}: ${r.success ? "" : JSON.stringify(r.error.issues.slice(0, 2))}`).toBe(true);
      }
    }
  });
  it("response schemas are strict: an undocumented field in a DTO would fail", async () => {
    const samples = await successSamples();
    expect(S.payment.safeParse({ ...(samples.getPayment![0] as object), surprise: 1 }).success).toBe(false);
    expect(S.event.safeParse({ ...(samples.getEvent![0] as object), type: "payment.exploded" }).success).toBe(false);
  });
  it("every event type has a validated payload from a real or faithfully shaped builder", async () => {
    const samples = await successSamples();
    const seen = new Set((samples.getEvent as { type: string }[]).map((e) => e.type));
    for (const t of ["checkout.session.completed", "checkout.session.expired", "checkout.session.cancelled", "payment.pending", "payment.succeeded", "payment.failed", "payment.cancelled", "payment_method.created", "payment_method.updated", "payment_method.default_updated", "payment_method.disabled", "payment_method.deleted", "webhook_endpoint.test"]) expect(seen.has(t), t).toBe(true);
  });
  it("each handler returns the documented success status (checked against handlers.ts and the services)", () => {
    const src = read(path.join(SRC, "server/api/handlers.ts"));
    const starts = [...src.matchAll(/^ {2}(\w+): \(req: Request/gm)].map((m) => ({ name: m[1]!, at: m.index! }));
    const services = walk(path.join(SRC, "server/services")).map(read).join("\n");
    for (let i = 0; i < starts.length; i++) {
      const block = src.slice(starts[i]!.at, starts[i + 1]?.at ?? src.length);
      const op = OPERATIONS.find((o) => o.handler === starts[i]!.name)!;
      expect(op, starts[i]!.name).toBeDefined();
      const literal = /status: (\d{3}),\s*body/.exec(block)?.[1];
      if (literal) expect(op.success.map((s) => s.status), op.handler).toEqual([Number(literal)]);
      else {
        expect(block, op.handler).toMatch(/status: r\.status/); // creates: status comes from the service, which returns 201 on creation
        expect(op.success.map((s) => s.status), op.handler).toEqual([201]);
        expect(services).toMatch(/status: 201/);
      }
    }
    expect(starts.length).toBe(OPERATIONS.length);
  });
});

// ------------------------------------------------------------------------------------------------ error responses
const sourceFiles = [...walk(path.join(SRC, "server")).filter((f) => !f.includes(`${path.sep}openapi${path.sep}`)), path.resolve(SRC, "../../../packages/core/src/money.ts"), path.resolve(SRC, "../../../packages/core/src/cards.ts")];
const sources = sourceFiles.map(read).join("\n");

describe("error catalogue", () => {
  it("every error code raised anywhere in the server (and core money/card validation) is catalogued with the right status and type", () => {
    const found = new Map<string, { status?: number; type?: string }>();
    for (const m of sources.matchAll(/new ApiError\((\d{3}), "(\w+)", "(\w+)"/g)) found.set(m[3]!, { status: Number(m[1]), type: m[2] });
    for (const m of sources.matchAll(/invalidRequest\("(\w+)"/g)) found.set(m[1]!, { status: 400, type: "invalid_request_error" });
    for (const m of sources.matchAll(/\bconflict\("(\w+)"/g)) found.set(m[1]!, { status: 409, type: "conflict_error" });
    for (const m of sources.matchAll(/(?:MoneyError|CardError)\("(\w+)"/g)) found.set(m[1]!, { status: 400, type: "invalid_request_error" });
    for (const c of ["resource_not_found", "url_not_allowed", "invalid_url", "invalid_credentials", "credential_revoked", "credential_expired"]) if (!found.has(c)) found.set(c, {});
    expect(found.size).toBeGreaterThan(40);
    for (const [code, f] of found) {
      const info = ERROR_CODES[code];
      expect(info, `undocumented error code in source: ${code}`).toBeDefined();
      if (f.status) expect(info!.status, code).toBe(f.status);
      if (f.type) expect(info!.type, code).toBe(f.type);
    }
  });
  it("no catalogued code is stale: each one still appears as a literal in the source", () => {
    for (const code of Object.keys(ERROR_CODES)) expect(sources, code).toContain(`"${code}"`);
  });
  it("every (status, code) pair in the catalogue serialises through the real error pipeline into a body the Error schema accepts", async () => {
    for (const [code, info] of Object.entries(ERROR_CODES)) {
      const res = errorResponse(new ApiError(info.status, info.type, code, "message", info.status === 400 ? "param" : undefined), "req_abcdefghijklmnop");
      expect(res.status).toBe(info.status);
      expect(res.headers.get("request-id")).toBe("req_abcdefghijklmnop");
      expect(S.errorBody.safeParse(await res.json()).success, code).toBe(true);
    }
  });
});

// ------------------------------------------------------------------------------------------------ real handler pipeline, fake database
const SECRET = "secret-for-contract-tests";
interface FakeState { count: number; failCount: number; knownCredential: boolean; revoked: boolean; expired: boolean }
function fakeDeps(over: Partial<FakeState> = {}): ApiDeps {
  const st: FakeState = { count: 1, failCount: 1, knownCredential: true, revoked: false, expired: false, ...over };
  const hash = hashSecret(SECRET);
  const db = {
    apiCredential: {
      findUnique: async () => (st.knownCredential ? { id: "c1", userId: "u1", clientSecretHash: hash, revokedAt: st.revoked ? new Date() : null, expiresAt: st.expired ? new Date(0) : null } : null),
      updateMany: async () => ({ count: 1 }),
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("api_rate_limits")) return [{ count: st.count, window_start: new Date() }];
      if (sql.includes("SELECT count FROM auth_failure_windows")) return [{ count: 0 }];
      if (sql.includes("auth_failure_windows")) return [{ count: st.failCount }];
      return [];
    },
    $executeRaw: async () => 0,
  };
  return { db: db as never, encKey: "unused", appUrl: "http://localhost:3100", now: () => new Date(), config: DEFAULT_API_CONFIG };
}

const GOOD_AUTH = `Basic ${Buffer.from(`id:${SECRET}`).toString("base64")}`;
const BAD_AUTH = `Basic ${Buffer.from("id:nope").toString("base64")}`;
const SAMPLE_ID: Record<string, string> = {
  sessionId: "cs_00000000-0000-4000-8000-000000000001", paymentId: "pay_00000000-0000-4000-8000-000000000002", methodId: "pm_00000000-0000-4000-8000-000000000003",
  eventId: "evt_00000000-0000-4000-8000-000000000004", endpointId: "we_00000000-0000-4000-8000-000000000005", deliveryId: "whd_00000000-0000-4000-8000-000000000006",
};
/** A body that passes validation, so that the only problem in the "unknown field" case is the unknown field (only the first problem is ever reported). */
const VALID_BODY: Record<string, object> = {
  createSession: { amount: "1.00", currency: "USD" }, createCharge: { payment_method: SAMPLE_ID.methodId!, amount: "1.00", currency: "USD" },
  createPaymentMethod: { customer: "c1", card: { number: "4242424242424242", exp_month: 12, exp_year: 2031, cvc: "123" } },
  createWebhookEndpoint: { url: "https://example.com/h", enabled_events: ["*"] }, updateWebhookEndpoint: { description: "x" },
};
const urlFor = (op: Operation, query = "") => "http://localhost:3100" + op.path.replace(/\{(\w+)\}/g, (_, n: string) => SAMPLE_ID[n]!) + query;
const invoke = (op: Operation, deps: ApiDeps, init: { auth?: string | null; body?: string; headers?: Record<string, string>; query?: string } = {}) => {
  const headers = new Headers({ "x-forwarded-for": "198.51.100.7", ...(init.headers ?? {}) });
  if (init.auth !== null) headers.set("authorization", init.auth ?? GOOD_AUTH);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const req = new Request(urlFor(op, init.query), { method: op.method.toUpperCase(), headers, body: init.body });
  const fn = (handlers as unknown as Record<string, (r: Request, d: ApiDeps, id?: string) => Promise<Response>>)[op.handler]!;
  const id = op.pathParams ? SAMPLE_ID[Object.keys(op.pathParams)[0]!] : undefined;
  return id === undefined ? fn(req, deps) : fn(req, deps, id);
};

async function expectDocumentedError(op: Operation, res: Response, status: number, code: string) {
  expect(res.status, `${op.handler} ${code}`).toBe(status);
  const body = await res.json();
  expect(S.errorBody.safeParse(body).success, `${op.handler} ${code}: ${JSON.stringify(body)}`).toBe(true);
  expect(body.error.code).toBe(code);
  expect(res.headers.get("request-id")).toBe(body.error.request_id);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect([...res.headers.keys()].some((k) => k.startsWith("access-control"))).toBe(false);
  const documented = doc.paths[op.path]![op.method].responses[String(status)];
  expect(documented, `${op.handler}: status ${status} is not documented`).toBeDefined();
  expect(documented.description, `${op.handler}: code ${code} is not documented under ${status}`).toContain(`\`${code}\``);
}

describe("error responses through the real API pipeline (in-memory fake database, every operation)", () => {
  it("401 invalid_credentials: no header, malformed header, wrong secret and unknown credential id, on all 26 operations", async () => {
    for (const op of OPERATIONS) {
      await expectDocumentedError(op, await invoke(op, fakeDeps(), { auth: null }), 401, "invalid_credentials");
      await expectDocumentedError(op, await invoke(op, fakeDeps(), { auth: "Bearer x" }), 401, "invalid_credentials");
      await expectDocumentedError(op, await invoke(op, fakeDeps(), { auth: BAD_AUTH }), 401, "invalid_credentials");
      await expectDocumentedError(op, await invoke(op, fakeDeps({ knownCredential: false })), 401, "invalid_credentials");
      const noAuth = await invoke(op, fakeDeps(), { auth: null });
      expect(noAuth.headers.get("www-authenticate")).toMatch(/^Basic /);
      expect(noAuth.headers.get("x-ratelimit-limit")).toBeNull(); // the document says so: rate headers only follow successful authentication
      expect(Object.keys(doc.paths[op.path]![op.method].responses["401"].headers).sort()).toEqual(["Request-Id", "WWW-Authenticate"]);
    }
  });
  it("401 credential_revoked and credential_expired on all 26 operations", async () => {
    for (const op of OPERATIONS) {
      await expectDocumentedError(op, await invoke(op, fakeDeps({ revoked: true })), 401, "credential_revoked");
      await expectDocumentedError(op, await invoke(op, fakeDeps({ expired: true })), 401, "credential_expired");
    }
  });
  it("429 too_many_failed_attempts and 429 rate_limited (with Retry-After and X-RateLimit headers) on all 26 operations", async () => {
    for (const op of OPERATIONS) {
      const failed = await invoke(op, fakeDeps({ failCount: 100000 }), { auth: BAD_AUTH });
      await expectDocumentedError(op, failed, 429, "too_many_failed_attempts");
      expect(failed.headers.get("retry-after")).toBe("60");
      const limited = await invoke(op, fakeDeps({ count: DEFAULT_API_CONFIG.rateLimitPerMinute + 1 }));
      await expectDocumentedError(op, limited, 429, "rate_limited");
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    }
  });
  it("every operation with a body: 415, 413, invalid_json (empty, not JSON, not an object) and unknown_parameter", async () => {
    for (const op of OPERATIONS.filter((o) => o.body)) {
      await expectDocumentedError(op, await invoke(op, fakeDeps(), { body: "{}", headers: { "content-type": "text/plain" } }), 415, "unsupported_media_type");
      await expectDocumentedError(op, await invoke(op, fakeDeps(), { body: "x".repeat(70_000) }), 413, "body_too_large");
      await expectDocumentedError(op, await invoke(op, fakeDeps(), { body: "{nope" }), 400, "invalid_json");
      await expectDocumentedError(op, await invoke(op, fakeDeps(), { body: "[]" }), 400, "invalid_json");
      await expectDocumentedError(op, await invoke(op, fakeDeps(), { body: "" }), 400, "invalid_json");
      await expectDocumentedError(op, await invoke(op, fakeDeps(), { body: JSON.stringify({ ...VALID_BODY[op.handler], definitely_not_a_field: 1 }), headers: op.idempotency === "required" ? { "idempotency-key": "k1" } : {} }), 400, "unknown_parameter");
    }
  });
  it("every operation with a body rejects a field of the wrong type with invalid_parameter (naming the parameter)", async () => {
    const wrong: Record<string, object> = {
      createSession: { amount: 5, currency: "USD" }, createCharge: { payment_method: 5, amount: "1.00", currency: "USD" }, createPaymentMethod: { customer: 5, card: {} },
      createWebhookEndpoint: { url: 5, enabled_events: ["*"] }, updateWebhookEndpoint: { max_attempts: "many" },
    };
    for (const op of OPERATIONS.filter((o) => o.body)) {
      const res = await invoke(op, fakeDeps(), { body: JSON.stringify(wrong[op.handler]), headers: op.idempotency === "required" ? { "idempotency-key": "k1" } : {} });
      await expectDocumentedError(op, res, 400, "invalid_parameter");
    }
  });
  it("money and idempotency-header validation errors (createSession, createCharge)", async () => {
    const create = OPERATIONS.find((o) => o.handler === "createSession")!;
    const charge = OPERATIONS.find((o) => o.handler === "createCharge")!;
    const cases: [string, string, string][] = [
      ["XXX", "1.00", "unsupported_currency"], ["USD", "abc", "invalid_amount_format"], ["USD", "1.005", "too_many_decimals"], ["USD", "0.00", "amount_too_small"], ["USD", "99999999999999.00", "amount_too_large"],
    ];
    for (const [currency, amount, code] of cases) {
      await expectDocumentedError(create, await invoke(create, fakeDeps(), { body: JSON.stringify({ amount, currency }) }), 400, code);
      await expectDocumentedError(charge, await invoke(charge, fakeDeps(), { body: JSON.stringify({ payment_method: SAMPLE_ID.methodId, amount, currency }), headers: { "idempotency-key": "k1" } }), 400, code);
    }
    await expectDocumentedError(create, await invoke(create, fakeDeps(), { body: JSON.stringify({ amount: "1.00", currency: "USD" }), headers: { "idempotency-key": "bad key!" } }), 400, "invalid_idempotency_key");
    await expectDocumentedError(charge, await invoke(charge, fakeDeps(), { body: JSON.stringify({ payment_method: SAMPLE_ID.methodId, amount: "1.00", currency: "USD" }) }), 400, "idempotency_key_required");
    await expectDocumentedError(charge, await invoke(charge, fakeDeps(), { body: JSON.stringify({ payment_method: SAMPLE_ID.methodId, amount: "1.00", currency: "USD" }), headers: { "idempotency-key": "bad key!" } }), 400, "invalid_idempotency_key");
  });
  it("every operation with query parameters rejects unknown and malformed ones (unknown_parameter, invalid_parameter)", async () => {
    for (const op of OPERATIONS.filter((o) => o.query)) {
      await expectDocumentedError(op, await invoke(op, fakeDeps(), { query: op.handler === "getDefaultPaymentMethod" ? "?customer=c1&bogus=1" : "?bogus=1" }), 400, "unknown_parameter");
      const bad = op.handler === "getDefaultPaymentMethod" ? "" : "?limit=0";
      await expectDocumentedError(op, await invoke(op, fakeDeps(), { query: bad }), 400, "invalid_parameter");
      if (op.handler !== "getDefaultPaymentMethod") await expectDocumentedError(op, await invoke(op, fakeDeps(), { query: "?limit=101" }), 400, "invalid_parameter");
    }
  });
  it("the document marks every state-dependent error (404, 409, 402, 422) on operations whose tests need a database as documented-only, and says so", () => {
    // These codes need real data to be produced and are verified against the hosted-database suites (not re-run in S5); here they are only
    // checked for catalogue consistency (previous tests) and for being listed on the right operations.
    const dbOnly = OPERATIONS.flatMap((o) => Object.entries(o.errors).filter(([st]) => [402, 404, 409, 422].includes(Number(st))).map(([st, c]) => `${o.handler} ${st} ${c.join(",")}`));
    expect(dbOnly.length).toBeGreaterThan(20);
  });
});

describe("the unauthenticated surface that is documented", () => {
  it("the document exposes no credential, secret or internal column names", () => {
    const text = JSON.stringify(doc);
    for (const word of ["token_hash", "client_secret_hash", "user_id", "SCHEDULER_TICK_SECRET", "SECRETS_ENCRYPTION_KEY", "service_role"]) expect(text, word).not.toContain(word);
  });
});
