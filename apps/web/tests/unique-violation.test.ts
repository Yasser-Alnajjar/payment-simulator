import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "@/server/services/credentials";

describe("isUniqueViolation", () => {
  it("recognises Prisma, pg and adapter shapes (including nested causes)", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation(new Error("x", { cause: { code: "23505" } }))).toBe(true);
    expect(isUniqueViolation({ meta: { driverAdapterError: { cause: { kind: "UniqueConstraintViolation" } } } })).toBe(true);
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint "api_credentials_one_active_per_user"'))).toBe(true);
  });
  it("does not misclassify other errors", () => {
    expect(isUniqueViolation(new Error("connection reset"))).toBe(false);
    expect(isUniqueViolation({ code: "P2025" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
