export class AppError extends Error {
  constructor(
    public readonly code: "unauthenticated" | "forbidden" | "not_found" | "validation" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

/** Service-layer errors carry client-safe messages; re-exported so dashboard actions can recognise them without importing the API pipeline. */
export { ApiError } from "./api/errors";
