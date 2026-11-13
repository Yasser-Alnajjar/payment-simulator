import { randomBytes } from "node:crypto";
import type { ApiDeps } from "@/server/api/deps";
import { DEFAULT_API_CONFIG } from "@/server/api/deps";
import { handlers } from "@/server/api/handlers";
import { createCredential } from "@/server/services/credentials";
import type { Harness } from "./harness";

export const ENC_KEY = randomBytes(32).toString("base64");

export interface Clock { t: number }
export const makeClock = (): Clock => ({ t: Date.now() });

export function makeDeps(t: Harness, clock: Clock, config: Partial<ApiDeps["config"]> = {}): ApiDeps {
  return { db: t.prisma, encKey: ENC_KEY, appUrl: "http://localhost:3100", now: () => new Date(clock.t), config: { ...DEFAULT_API_CONFIG, ...config, authFailureLimits: { ...DEFAULT_API_CONFIG.authFailureLimits, ...(config.authFailureLimits ?? {}) } } };
}

export interface Account { userId: string; clientId: string; clientSecret: string; credentialId: string; auth: string }
export const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

/** The hosted database sits across a network; an occasional stalled statement should not fail a whole suite. Retries only a Prisma transaction timeout (P2028), which rolls the attempt back. */
async function withTimeoutRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "P2028" || i >= attempts) throw e;
    }
  }
}

export async function newAccount(t: Harness): Promise<Account> {
  const u = await t.user();
  const issued = await withTimeoutRetry(() => createCredential(t.prisma, u.id, ENC_KEY));
  return { userId: u.id, clientId: issued.credential.clientId, clientSecret: issued.clientSecret, credentialId: issued.credential.id, auth: basic(issued.credential.clientId, issued.clientSecret) };
}

export interface Reply { status: number; json: any; text: string; headers: Headers } // eslint-disable-line @typescript-eslint/no-explicit-any

interface Opts { auth?: string | null; body?: unknown; rawBody?: string; headers?: Record<string, string>; ip?: string }

/** Minimal in-process router over the real handlers (the route files are three-line wrappers around these). */
export async function call(deps: ApiDeps, method: string, path: string, o: Opts = {}): Promise<Reply> {
  const url = new URL(path, "http://localhost:3100");
  const headers = new Headers(o.headers);
  if (o.auth !== null && o.auth !== undefined) headers.set("authorization", o.auth);
  headers.set("x-forwarded-for", o.ip ?? `198.51.100.${Math.floor(Math.random() * 250) + 1}`);
  let body: string | undefined;
  if (o.rawBody !== undefined) body = o.rawBody;
  else if (o.body !== undefined) body = JSON.stringify(o.body);
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const req = new Request(url, { method, headers, body });
  const p = url.pathname;
  let m: RegExpMatchArray | null;
  let res: Response;
  if (p === "/api/v1/checkout/sessions" && method === "POST") res = await handlers.createSession(req, deps);
  else if (p === "/api/v1/checkout/sessions" && method === "GET") res = await handlers.listSessions(req, deps);
  else if ((m = p.match(/^\/api\/v1\/checkout\/sessions\/([^/]+)\/cancel$/)) && method === "POST") res = await handlers.cancelSession(req, deps, decodeURIComponent(m[1]!));
  else if ((m = p.match(/^\/api\/v1\/checkout\/sessions\/([^/]+)$/)) && method === "GET") res = await handlers.getSession(req, deps, decodeURIComponent(m[1]!));
  else if (p === "/api/v1/payments" && method === "GET") res = await handlers.listPayments(req, deps);
  else if ((m = p.match(/^\/api\/v1\/payments\/([^/]+)$/)) && method === "GET") res = await handlers.getPayment(req, deps, decodeURIComponent(m[1]!));
  else if (p === "/api/v1/events" && method === "GET") res = await handlers.listEvents(req, deps);
  else if ((m = p.match(/^\/api\/v1\/events\/([^/]+)$/)) && method === "GET") res = await handlers.getEvent(req, deps, decodeURIComponent(m[1]!));
  else throw new Error(`no route for ${method} ${p}`);
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

export const createSession = (deps: ApiDeps, a: Account, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  call(deps, "POST", "/api/v1/checkout/sessions", { auth: a.auth, body: { amount: "10.00", currency: "USD", ...body }, headers });

/** Token from the checkout url returned at creation. */
export const tokenOf = (url: string) => url.split("/checkout/")[1]!;
