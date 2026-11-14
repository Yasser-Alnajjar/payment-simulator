/** Webhook retry policy (pure). */
export const WEBHOOK_MAX_ATTEMPTS_DEFAULT = 8;
export const WEBHOOK_MAX_ATTEMPTS_MIN = 1;
export const WEBHOOK_MAX_ATTEMPTS_MAX = 12;
export const RETRY_BASE_SECONDS = 30;
export const RETRY_CAP_SECONDS = 3600;
export const RETRY_JITTER = 0.2;

export type AttemptOutcome = "success" | "retryable" | "permanent" | "abandoned";

/** Network-level failure codes recorded on an attempt. */
export const SEND_ERROR_CODES = [
  "timeout", "connect_error", "tls_error", "dns_error", "ssrf_blocked", "invalid_url", "redirect_not_followed",
  "injected_http_500", "injected_timeout", "lease_lost", "unknown_error",
] as const;
export type SendErrorCode = (typeof SEND_ERROR_CODES)[number];

const RETRYABLE_ERRORS: ReadonlySet<SendErrorCode> = new Set(["timeout", "connect_error", "tls_error", "dns_error", "injected_http_500", "injected_timeout", "lease_lost", "unknown_error"]);

/**
 * Delay before the next attempt, after `attemptsMade` attempts (>= 1): min(30 s * 2^(n-1), 1 h), +/-20 % jitter, never above 1 h.
 * `rand` returns [0, 1) and is injectable for tests.
 */
export function retryDelaySeconds(attemptsMade: number, rand: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attemptsMade));
  const base = Math.min(RETRY_BASE_SECONDS * 2 ** Math.min(n - 1, 20), RETRY_CAP_SECONDS);
  const jittered = base * (1 - RETRY_JITTER + 2 * RETRY_JITTER * rand());
  return Math.max(1, Math.min(RETRY_CAP_SECONDS, Math.round(jittered)));
}

/** 2xx success; 408, 429 and 5xx retryable; everything else (1xx, 3xx, other 4xx) permanent. Redirects are never followed. */
export function classifyHttpStatus(status: number): Exclude<AttemptOutcome, "abandoned"> {
  if (status >= 200 && status < 300) return "success";
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) return "retryable";
  return "permanent";
}

export const classifySendError = (code: SendErrorCode): "retryable" | "permanent" => (RETRYABLE_ERRORS.has(code) ? "retryable" : "permanent");

/** Parses Retry-After (delta seconds or HTTP date). Returns whole seconds capped at 1 h, or null when absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^[0-9]{1,10}$/.test(v)) return Math.min(Number(v), RETRY_CAP_SECONDS);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.min(Math.max(0, Math.ceil((t - now.getTime()) / 1000)), RETRY_CAP_SECONDS);
}
