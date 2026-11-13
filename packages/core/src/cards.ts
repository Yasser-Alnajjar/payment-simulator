import { createHmac, hkdfSync } from "node:crypto";

/**
 * TEST-ONLY card domain. This is a simulator: it accepts exactly the published test numbers in TEST_CARDS and nothing else.
 * A Luhn-valid number that is not in the table is refused (`not_a_test_card`), so a real card number can never be accepted,
 * persisted or echoed. The simulator is not PCI certified and does no real tokenization: the full number and the security
 * code exist only in the memory of the request that carries them, are reduced to safe display fields plus a keyed fingerprint,
 * and are never written to the database, logs, events or responses.
 */
export const CARD_BRANDS = ["visa", "mastercard", "meeza", "amex", "discover"] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

/** What a test card does. Persisted on the payment method (the number itself is discarded). */
export const CARD_BEHAVIORS = ["succeed", "decline", "insufficient_funds", "authentication_required", "processor_error", "setup_declined"] as const;
export type CardBehavior = (typeof CARD_BEHAVIORS)[number];

export interface TestCard { number: string; brand: CardBrand; behavior: CardBehavior; description: string }

export const TEST_CARDS: readonly TestCard[] = Object.freeze([
  { number: "4242424242424242", brand: "visa", behavior: "succeed", description: "Visa: saves and charges successfully" },
  { number: "5555555555554444", brand: "mastercard", behavior: "succeed", description: "Mastercard: saves and charges successfully" },
  { number: "378282246310005", brand: "amex", behavior: "succeed", description: "American Express: saves and charges successfully (4-digit security code)" },
  { number: "6011111111111117", brand: "discover", behavior: "succeed", description: "Discover: saves and charges successfully" },
  { number: "5078030000000003", brand: "meeza", behavior: "succeed", description: "Meeza: saves and charges successfully" },
  { number: "4000000000000002", brand: "visa", behavior: "decline", description: "Visa: saves, every charge is declined (card_declined)" },
  { number: "5105105105105100", brand: "mastercard", behavior: "decline", description: "Mastercard: saves, every charge is declined (card_declined)" },
  { number: "4000000000009995", brand: "visa", behavior: "insufficient_funds", description: "Visa: saves, every charge fails with insufficient_funds" },
  { number: "4000002500003155", brand: "visa", behavior: "authentication_required", description: "Visa: saves, every charge fails with authentication_required (no challenge is simulated)" },
  { number: "4000000000000119", brand: "visa", behavior: "processor_error", description: "Visa: saves, every charge fails with processor_error (simulated network/processor failure)" },
  { number: "4000000000000341", brand: "visa", behavior: "setup_declined", description: "Visa: refused when it is being added (card_declined); never saved" },
]);

const BY_NUMBER: ReadonlyMap<string, TestCard> = new Map(TEST_CARDS.map((c) => [c.number, c]));

export type CardErrorCode =
  | "invalid_card_number" | "not_a_test_card" | "invalid_expiry" | "card_expired" | "invalid_cvc" | "invalid_cardholder_name" | "card_declined";

/** Messages are static: they never include any submitted value. */
export class CardError extends Error {
  constructor(public readonly code: CardErrorCode, message: string, public readonly param?: string) {
    super(message);
  }
}

export function luhnValid(digits: string): boolean {
  if (!/^[0-9]+$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export interface CardInput { number: unknown; exp_month: unknown; exp_year: unknown; cvc: unknown; name?: unknown }

/** The only output of tokenization: safe display fields, the stored behavior, and the digits needed for a keyed fingerprint. */
export interface TestCardToken {
  brand: CardBrand;
  last4: string;
  expMonth: number;
  expYear: number;
  cardholderName: string | null;
  behavior: CardBehavior;
  /** Normalized number, for `cardFingerprint` only. Callers must not store, log or return it. */
  panForFingerprint: string;
}

export const MAX_EXPIRY_YEARS_AHEAD = 20;

/** A card is valid through the end of its expiry month. */
export function isExpired(expMonth: number, expYear: number, now: Date): boolean {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  return expYear < y || (expYear === y && expMonth < m);
}

const NAME = /^[\p{L}][\p{L} .'-]{0,99}$/u;

export function validateCardholderName(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new CardError("invalid_cardholder_name", "Cardholder name must be text", "card.name");
  const t = v.trim().replace(/\s+/g, " ");
  if (t === "") return null;
  if (!NAME.test(t)) throw new CardError("invalid_cardholder_name", "Cardholder name must be 1-100 letters, spaces, dots, apostrophes or hyphens", "card.name");
  return t;
}

/**
 * Validates test-card input and reduces it to a token. Order matters for safety and for deterministic errors:
 * format, Luhn, test-card allowlist, expiry, security code, name. Nothing from the input appears in an error message.
 */
export function tokenizeTestCard(input: CardInput, now: Date): TestCardToken {
  const raw = typeof input.number === "string" ? input.number.replace(/[ -]/g, "") : "";
  if (!/^[0-9]{12,19}$/.test(raw) || !luhnValid(raw)) throw new CardError("invalid_card_number", "The card number is not valid", "card.number");
  const known = BY_NUMBER.get(raw);
  if (!known) throw new CardError("not_a_test_card", "Only the simulator's published test card numbers are accepted. Never enter a real card number.", "card.number");

  const { exp_month: m, exp_year: y } = input;
  if (!Number.isInteger(m) || (m as number) < 1 || (m as number) > 12 || !Number.isInteger(y) || (y as number) < 2000 || (y as number) > now.getUTCFullYear() + MAX_EXPIRY_YEARS_AHEAD) {
    throw new CardError("invalid_expiry", "Expiry must be a month 1-12 and a four-digit year no more than 20 years ahead", "card.exp_month");
  }
  if (isExpired(m as number, y as number, now)) throw new CardError("card_expired", "This card has expired", "card.exp_year");

  const cvcLen = known.brand === "amex" ? 4 : 3;
  if (typeof input.cvc !== "string" || !new RegExp(`^[0-9]{${cvcLen}}$`).test(input.cvc)) {
    throw new CardError("invalid_cvc", `The security code must be ${cvcLen} digits`, "card.cvc");
  }
  const cardholderName = validateCardholderName(input.name);
  return { brand: known.brand, last4: raw.slice(-4), expMonth: m as number, expYear: y as number, cardholderName, behavior: known.behavior, panForFingerprint: raw };
}

/**
 * Duplicate-card identifier: HMAC-SHA256 over the owner and the number, keyed with a key derived (HKDF) from the app secret.
 * Not reversible without the server key and different for every owner. Compared only within one owner and customer.
 */
export function cardFingerprint(pan: string, userId: string, masterKeyB64: string): string {
  const master = Buffer.from(masterKeyB64, "base64");
  if (master.length !== 32) throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  const key = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "sandbox/v1/card-fingerprint", 32));
  return createHmac("sha256", key).update(`${userId}|${pan}`, "utf8").digest("hex");
}

/** Outcome of using a card for a payment. `failure_code` is a stable public code. */
export type ChargeOutcome = { status: "succeeded"; failureCode: null } | { status: "failed"; failureCode: "card_declined" | "insufficient_funds" | "authentication_required" | "processor_error" };

export function chargeOutcome(behavior: CardBehavior): ChargeOutcome {
  switch (behavior) {
    case "succeed": return { status: "succeeded", failureCode: null };
    case "decline": return { status: "failed", failureCode: "card_declined" };
    case "insufficient_funds": return { status: "failed", failureCode: "insufficient_funds" };
    case "authentication_required": return { status: "failed", failureCode: "authentication_required" };
    case "processor_error": return { status: "failed", failureCode: "processor_error" };
    // Such a card is never saved; if a payment is attempted with it directly it is declined.
    case "setup_declined": return { status: "failed", failureCode: "card_declined" };
  }
}

export const CUSTOMER_REFERENCE = /^[A-Za-z0-9_.:@-]{1,128}$/;
export const isCustomerReference = (v: unknown): v is string => typeof v === "string" && CUSTOMER_REFERENCE.test(v);

export const PAYMENT_METHOD_STATUSES = ["active", "expired", "disabled"] as const;
export type PaymentMethodStatus = (typeof PAYMENT_METHOD_STATUSES)[number];

/** Status as seen now: an active card whose expiry month has passed is `expired` (derived; nothing is rewritten on read). */
export function effectiveStatus(stored: string, expMonth: number, expYear: number, now: Date): PaymentMethodStatus {
  if (stored === "disabled") return "disabled";
  if (stored === "expired" || isExpired(expMonth, expYear, now)) return "expired";
  return "active";
}
