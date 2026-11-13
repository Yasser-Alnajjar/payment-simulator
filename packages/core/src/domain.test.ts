import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_PAYMENT_STATUSES, MoneyError, PAYMENT_STATUSES, SCENARIOS, SESSION_STATUSES, canTransitionPayment, canTransitionSession,
  canonicalJson, currencyExponent, formatAmount, generateCheckoutToken, isTerminalPayment, isTerminalSession, minorToNumber,
  openBound, parseAmount, parsePublicId, planScenario, requestFingerprint, sealBound, toPublicId, verifySecret,
} from "./index";

const code = (f: () => unknown) => { try { f(); return "ok"; } catch (e) { return e instanceof MoneyError ? e.code : "other"; } };

describe("money", () => {
  it("parses decimal strings per currency exponent", () => {
    expect(parseAmount("149.00", "USD")).toBe(14900n);
    expect(parseAmount("149", "USD")).toBe(14900n);
    expect(parseAmount("0.01", "USD")).toBe(1n);
    expect(parseAmount("1000", "JPY")).toBe(1000n);
    expect(parseAmount("1.234", "KWD")).toBe(1234n);
    expect(parseAmount("1.5", "KWD")).toBe(1500n);
    expect(parseAmount("0.1", "USD")).toBe(10n);
  });
  it("never rounds and never uses floats", () => {
    expect(code(() => parseAmount("1.001", "USD"))).toBe("too_many_decimals");
    expect(code(() => parseAmount("1.5", "JPY"))).toBe("too_many_decimals");
    expect(code(() => parseAmount("1.2345", "KWD"))).toBe("too_many_decimals");
  });
  it("rejects malformed input", () => {
    for (const bad of ["", " 1", "1 ", "-1", "+1", "1e3", "0x10", "1,00", ".5", "5.", "01", "NaN", "Infinity", "1.0.0", "１２"]) {
      expect(code(() => parseAmount(bad, "USD")), bad).toBe("invalid_amount_format");
    }
    for (const bad of [10, 1.5, null, undefined, {}, ["1"]]) expect(code(() => parseAmount(bad, "USD"))).toBe("invalid_amount_format");
  });
  it("enforces bounds", () => {
    expect(code(() => parseAmount("0", "USD"))).toBe("amount_too_small");
    expect(code(() => parseAmount("0.00", "USD"))).toBe("amount_too_small");
    expect(parseAmount("10000000000.00", "USD")).toBe(1_000_000_000_000n);
    expect(code(() => parseAmount("10000000000.01", "USD"))).toBe("amount_too_large");
    expect(code(() => parseAmount("99999999999999999", "USD"))).toBe("invalid_amount_format");
  });
  it("only accepts supported currencies, exactly as written", () => {
    expect(code(() => parseAmount("1", "XXX"))).toBe("unsupported_currency");
    expect(code(() => parseAmount("1", "usd"))).toBe("unsupported_currency");
    expect(code(() => parseAmount("1", "__proto__"))).toBe("unsupported_currency");
    expect(code(() => parseAmount("1", "constructor"))).toBe("unsupported_currency");
    expect([currencyExponent("JPY"), currencyExponent("USD"), currencyExponent("KWD")]).toEqual([0, 2, 3]);
  });
  it("round-trips through formatAmount and stays JSON-safe", () => {
    for (const [s, c] of [["149.00", "USD"], ["1000", "JPY"], ["1.234", "KWD"], ["0.05", "EUR"]] as const) expect(formatAmount(parseAmount(s, c), c)).toBe(s);
    expect(minorToNumber(1_000_000_000_000n)).toBe(1_000_000_000_000);
    expect(() => minorToNumber(1_000_000_000_001n)).toThrow();
  });
});

describe("ids", () => {
  const u = "550e8400-e29b-41d4-a716-446655440000";
  it("round-trips and rejects wrong prefixes and shapes", () => {
    expect(parsePublicId("session", toPublicId("session", u))).toBe(u);
    expect(parsePublicId("payment", toPublicId("session", u))).toBeNull();
    for (const bad of [u, "cs_", "cs_x", `cs_${u.toUpperCase()}`, `cs_${u}0`, `cs_${u}/..`, 5, null, "cs_" + "a".repeat(100)]) expect(parsePublicId("session", bad)).toBeNull();
  });
});

describe("state machines", () => {
  it("allows exactly the documented session transitions", () => {
    for (const from of SESSION_STATUSES) for (const to of SESSION_STATUSES) {
      expect(canTransitionSession(from, to), `${from}->${to}`).toBe(from === "open" && to !== "open");
    }
    expect(SESSION_STATUSES.filter(isTerminalSession).sort()).toEqual(["cancelled", "completed", "expired"]);
  });
  it("allows exactly the documented payment transitions; terminal states are immutable", () => {
    for (const from of PAYMENT_STATUSES) for (const to of PAYMENT_STATUSES) {
      expect(canTransitionPayment(from, to), `${from}->${to}`).toBe(from === "pending" && to !== "pending");
    }
    expect(PAYMENT_STATUSES.filter(isTerminalPayment).sort()).toEqual(["cancelled", "failed", "succeeded"]);
    expect([...ACTIVE_PAYMENT_STATUSES]).toEqual(["pending", "succeeded"]);
  });
});

describe("scenarios", () => {
  it("plans every scenario", () => {
    expect(SCENARIOS.length).toBe(7);
    expect(planScenario("success")).toMatchObject({ initial: "succeeded", resolveTo: null });
    expect(planScenario("decline")).toMatchObject({ initial: "failed", failureCode: "declined" });
    expect(planScenario("cancel")).toMatchObject({ initial: "cancelled" });
    expect(planScenario("pending")).toMatchObject({ initial: "pending", resolveTo: null });
    expect(planScenario("timeout")).toMatchObject({ initial: "pending", resolveTo: null });
    expect(planScenario("pending_then_success", 7)).toMatchObject({ initial: "pending", resolveTo: "succeeded", resolveAfterSeconds: 7 });
    expect(planScenario("pending_then_failure")).toMatchObject({ initial: "pending", resolveTo: "failed", resolveAfterSeconds: 5 });
  });
});

describe("canonical json and request fingerprint", () => {
  it("is key-order independent and strict", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
  it("binds method, endpoint, version and body", () => {
    const base = requestFingerprint("POST", "/api/v1/checkout/sessions", "2026-11-01", { a: 1, b: 2 });
    expect(requestFingerprint("post", "/api/v1/checkout/sessions", "2026-11-01", { b: 2, a: 1 })).toBe(base);
    expect(requestFingerprint("POST", "/api/v1/checkout/other", "2026-11-01", { a: 1, b: 2 })).not.toBe(base);
    expect(requestFingerprint("POST", "/api/v1/checkout/sessions", "2027-01-01", { a: 1, b: 2 })).not.toBe(base);
    expect(requestFingerprint("POST", "/api/v1/checkout/sessions", "2026-11-01", { a: 1, b: 3 })).not.toBe(base);
  });
});

describe("purpose-bound encryption and checkout tokens", () => {
  const key = randomBytes(32).toString("base64");
  it("round-trips and rejects another purpose, context, key or tampering", () => {
    const sealed = sealBound("secret-token", key, "idempotency-checkout-token", "u1|k1|s1");
    expect(sealed).not.toContain("secret-token");
    expect(openBound(sealed, key, "idempotency-checkout-token", "u1|k1|s1")).toBe("secret-token");
    expect(() => openBound(sealed, key, "other-purpose", "u1|k1|s1")).toThrow();
    expect(() => openBound(sealed, key, "idempotency-checkout-token", "u1|k2|s1")).toThrow();
    expect(() => openBound(sealed, randomBytes(32).toString("base64"), "idempotency-checkout-token", "u1|k1|s1")).toThrow();
    const parts = sealed.split(".");
    parts[3] = Buffer.from("x" + parts[3]).toString("base64url");
    expect(() => openBound(parts.join("."), key, "idempotency-checkout-token", "u1|k1|s1")).toThrow();
    expect(() => openBound("v1.a.b.c", key, "p", "c")).toThrow();
  });
  it("generates unique tokens with a matching hash", () => {
    const a = generateCheckoutToken(), b = generateCheckoutToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.startsWith("sbx_cs_")).toBe(true);
    expect(verifySecret(a.token, a.tokenHash)).toBe(true);
    expect(a.tokenHash).not.toContain(a.token);
  });
});
