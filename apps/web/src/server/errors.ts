export class AppError extends Error {
  constructor(
    public readonly code: "unauthenticated" | "forbidden" | "not_found" | "validation" | "conflict",
    message: string,
  ) {
    super(message);
  }
}
