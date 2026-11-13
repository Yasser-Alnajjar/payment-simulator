/**
 * Client-safe display list of the simulator's TEST cards (the core domain imports node:crypto, so the browser bundle cannot use it).
 * A unit test keeps this list identical to the authoritative table in @sandbox/core. These numbers are published test numbers only.
 */
export const TEST_CARD_OPTIONS = [
  { number: "4242424242424242", label: "Visa: succeeds", cvc: "123" },
  { number: "5555555555554444", label: "Mastercard: succeeds", cvc: "123" },
  { number: "378282246310005", label: "American Express: succeeds", cvc: "1234" },
  { number: "6011111111111117", label: "Discover: succeeds", cvc: "123" },
  { number: "5078030000000003", label: "Meeza: succeeds", cvc: "123" },
  { number: "4000000000000002", label: "Visa: charges are declined", cvc: "123" },
  { number: "5105105105105100", label: "Mastercard: charges are declined", cvc: "123" },
  { number: "4000000000009995", label: "Visa: insufficient funds", cvc: "123" },
  { number: "4000002500003155", label: "Visa: authentication required", cvc: "123" },
  { number: "4000000000000119", label: "Visa: processor failure", cvc: "123" },
  { number: "4000000000000341", label: "Visa: refused when added", cvc: "123" },
] as const;

export const BRAND_LABEL: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", meeza: "Meeza", amex: "American Express", discover: "Discover" };

/** What each stored test behavior does, in words (shown next to saved cards so the expected result is never a surprise). */
export const BEHAVIOR_LABEL: Record<string, string> = {
  succeed: "Charges succeed",
  decline: "Charges are declined",
  insufficient_funds: "Charges fail: insufficient funds",
  authentication_required: "Charges fail: authentication required",
  processor_error: "Charges fail: processor failure",
};
