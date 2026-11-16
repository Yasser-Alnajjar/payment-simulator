import { randomUUID } from "node:crypto";

/**
 * A deliberately small client: one `fetch`, Basic auth, the documented error envelope, safe retries. Copy and adapt.
 * Configure with SANDBOX_BASE_URL (default http://localhost:3100), SANDBOX_CLIENT_ID and SANDBOX_CLIENT_SECRET (dashboard > Credentials).
 */
export interface ApiErrorBody { error: { type: string; code: string; message: string; param?: string; request_id: string } }

export class SandboxApiError extends Error {
  constructor(public readonly status: number, public readonly body: ApiErrorBody["error"]) {
    super(`${status} ${body.code}: ${body.message} (request ${body.request_id})`);
  }
}

export interface List<T> { object: "list"; data: T[]; has_more: boolean }

export class SandboxClient {
  constructor(
    private readonly baseUrl = process.env.SANDBOX_BASE_URL ?? "http://localhost:3100",
    private readonly clientId = required("SANDBOX_CLIENT_ID"),
    private readonly clientSecret = required("SANDBOX_CLIENT_SECRET"),
  ) {}

  /**
   * `idempotencyKey`: pass the SAME key when you retry the same create call, and a new key for a new operation. Required by POST /payments.
   * Retries only what is safe to retry: network errors and 429/5xx, and only when the call is a GET or carries an idempotency key.
   */
  async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const safeToRetry = method === "GET" || opts.idempotencyKey !== undefined;

    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
            ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (e) {
        if (!safeToRetry || attempt >= 3) throw e;
        await sleep(500 * attempt);
        continue;
      }
      if (res.ok) return (await res.json()) as T;

      if (safeToRetry && attempt < 3 && (res.status === 429 || res.status >= 500)) {
        await sleep(Math.max(1, Number(res.headers.get("retry-after") ?? attempt)) * 1000);
        continue;
      }
      const parsed = (await res.json().catch(() => null)) as ApiErrorBody | null;
      throw new SandboxApiError(res.status, parsed?.error ?? { type: "api_error", code: "unparseable_error", message: res.statusText, request_id: res.headers.get("request-id") ?? "unknown" });
    }
  }

  /** Walks every page of a list endpoint (newest first), using the last id as the cursor. */
  async *paginate<T extends { id: string }>(path: string, query: Record<string, string | number | undefined> = {}): AsyncGenerator<T> {
    let after: string | undefined;
    for (;;) {
      const page = await this.request<List<T>>("GET", path, { query: { limit: 100, ...query, starting_after: after } });
      yield* page.data;
      if (!page.has_more || page.data.length === 0) return;
      after = page.data[page.data.length - 1]!.id;
    }
  }
}

export const newIdempotencyKey = () => randomUUID();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} (create an API credential in the dashboard)`);
  return v;
}
