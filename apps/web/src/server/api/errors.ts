export type ApiErrorType = "authentication_error" | "invalid_request_error" | "conflict_error" | "rate_limit_error" | "idempotency_error" | "api_error";

/** Public API error. `message` is always safe to show to the client; never put secrets or internal detail in it. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: ApiErrorType,
    public readonly code: string,
    message: string,
    public readonly param?: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new ApiError(404, "invalid_request_error", "resource_not_found", `${what} not found`);
export const invalidRequest = (code: string, message: string, param?: string) => new ApiError(400, "invalid_request_error", code, message, param);
export const conflict = (code: string, message: string) => new ApiError(409, "conflict_error", code, message);
