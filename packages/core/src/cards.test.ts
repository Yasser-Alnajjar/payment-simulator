import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CardError, TEST_CARDS, cardFingerprint, chargeOutcome, effectiveStatus, isCustomerReference, isExpired, luhnValid, parsePublicId, toPublicId, tokenizeTestCard } from "./index";

const NOW = new Date("2026-11-13T12:00:00Z");
const good = { number: "4242 4242 4242 4242", exp_month: 12, exp_year: 2030, cvc: "123", name: "Ada Lovelace" };
const code = (f: () => unknown) => { try { f(); return "ok"; } catch (e) { return e instanceof CardError ? e.code : "other"; } };

describe("test-card domain (unit; no database)", () => {
  it("every published test number is Luhn-valid and unique", () => {
    for (const c of TEST_CARDS) expect(luhnValid(c.number), c.number).toBe(true);
    expect(new Set(TEST_CARDS.map((c) => c.number)).size).toBe(TEST_CARDS.length);
  });

  it("creates a safe token: last four, brand, expiry, behavior, name; no full number or cvc in the output fields", () => {
    const t = tokenizeTestCard(good, NOW);
    expect(t).toMatchObject({ brand: "visa", last4: "4242", expMonth: 12, expYear: 2030, cardholderName: "Ada Lovelace", behavior: "succeed" });
    const { panForFingerprint, ...safe } = t;
    expect(panForFingerprint).toBe("4242424242424242");
    expect(JSON.stringify(safe)).not.toContain("4242424242424242");
    expect(JSON.stringify(safe)).not.toContain("123");
  });

  it("rejects invalid numbers (format and Luhn) and real-looking numbers that are not published test cards", () => {
    expect(code(() => tokenizeTestCard({ ...good, number: "4242424242424241" }, NOW))).toBe("invalid_card_number");
    expect(code(() => tokenizeTestCard({ ...good, number: "abcd" }, NOW))).toBe("invalid_card_number");
    expect(code(() => tokenizeTestCard({ ...good, number: 4242424242424242 }, NOW))).toBe("invalid_card_number");
    // Luhn-valid but not in the allowlist: could be a real card, so it is refused outright.
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(code(() => tokenizeTestCard({ ...good, number: "4111111111111111" }, NOW))).toBe("not_a_test_card");
  });

  it("error messages never contain submitted values", () => {
    for (const n of ["4111111111111111", "4242424242424241"]) {
      try { tokenizeTestCard({ ...good, number: n, cvc: "987" }, NOW); } catch (e) {
        expect((e as Error).message).not.toContain(n);
        expect((e as Error).message).not.toContain("987");
      }
    }
  });

  it("validates expiry: month, year range, and rejects expired cards (valid through the end of the month)", () => {
    expect(code(() => tokenizeTestCard({ ...good, exp_month: 13 }, NOW))).toBe("invalid_expiry");
    expect(code(() => tokenizeTestCard({ ...good, exp_month: "12" }, NOW))).toBe("invalid_expiry");
    expect(code(() => tokenizeTestCard({ ...good, exp_year: 2060 }, NOW))).toBe("invalid_expiry");
    expect(code(() => tokenizeTestCard({ ...good, exp_month: 10, exp_year: 2026 }, NOW))).toBe("card_expired");
    expect(code(() => tokenizeTestCard({ ...good, exp_month: 11, exp_year: 2026 }, NOW))).toBe("ok");
    expect(isExpired(11, 2026, new Date("2026-12-01T00:00:00Z"))).toBe(true);
  });

  it("validates the security code format (3 digits, 4 for Amex) without returning it", () => {
    expect(code(() => tokenizeTestCard({ ...good, cvc: "12" }, NOW))).toBe("invalid_cvc");
    expect(code(() => tokenizeTestCard({ ...good, cvc: 123 }, NOW))).toBe("invalid_cvc");
    expect(code(() => tokenizeTestCard({ ...good, number: "378282246310005", cvc: "123" }, NOW))).toBe("invalid_cvc");
    expect(code(() => tokenizeTestCard({ ...good, number: "378282246310005", cvc: "1234" }, NOW))).toBe("ok");
    expect(Object.keys(tokenizeTestCard(good, NOW))).not.toContain("cvc");
  });

  it("validates the cardholder name and refuses digits (so a number cannot be smuggled in the name)", () => {
    expect(code(() => tokenizeTestCard({ ...good, name: "4242424242424242" }, NOW))).toBe("invalid_cardholder_name");
    expect(code(() => tokenizeTestCard({ ...good, name: "A".repeat(101) }, NOW))).toBe("invalid_cardholder_name");
    expect(tokenizeTestCard({ ...good, name: undefined }, NOW).cardholderName).toBeNull();
    expect(tokenizeTestCard({ ...good, name: "  Jean-Luc   O'Neil " }, NOW).cardholderName).toBe("Jean-Luc O'Neil");
  });

  it("maps every behavior to one deterministic outcome", () => {
    expect(chargeOutcome("succeed")).toEqual({ status: "succeeded", failureCode: null });
    expect(chargeOutcome("decline").failureCode).toBe("card_declined");
    expect(chargeOutcome("insufficient_funds").failureCode).toBe("insufficient_funds");
    expect(chargeOutcome("authentication_required").failureCode).toBe("authentication_required");
    expect(chargeOutcome("processor_error").failureCode).toBe("processor_error");
    for (const c of TEST_CARDS) expect(chargeOutcome(c.behavior)).toEqual(chargeOutcome(c.behavior));
  });

  it("fingerprints are deterministic, keyed and per owner; they do not contain the number", () => {
    const k = randomBytes(32).toString("base64");
    const a = cardFingerprint("4242424242424242", "user-a", k);
    expect(a).toBe(cardFingerprint("4242424242424242", "user-a", k));
    expect(a).not.toBe(cardFingerprint("4242424242424242", "user-b", k));
    expect(a).not.toBe(cardFingerprint("4242424242424242", "user-a", randomBytes(32).toString("base64")));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("4242");
    expect(() => cardFingerprint("4242424242424242", "u", "short")).toThrow();
  });

  it("derives expired status from the clock; disabled wins", () => {
    expect(effectiveStatus("active", 12, 2030, NOW)).toBe("active");
    expect(effectiveStatus("active", 10, 2026, NOW)).toBe("expired");
    expect(effectiveStatus("disabled", 10, 2026, NOW)).toBe("disabled");
  });

  it("validates customer references and public ids", () => {
    expect(isCustomerReference("cus_123.ab:c@d-e")).toBe(true);
    for (const bad of ["", " a", "a b", "x".repeat(129), "a/b", 5, null]) expect(isCustomerReference(bad)).toBe(false);
    const u = "123e4567-e89b-42d3-a456-426614174000";
    expect(parsePublicId("paymentMethod", toPublicId("paymentMethod", u))).toBe(u);
    expect(parsePublicId("paymentMethod", `cs_${u}`)).toBeNull();
    expect(parsePublicId("session", toPublicId("setupSession", u))).toBeNull();
    expect(parsePublicId("setupSession", toPublicId("setupSession", u))).toBe(u);
  });
});
