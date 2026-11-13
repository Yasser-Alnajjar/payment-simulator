/**
 * Money: decimal strings in, integer minor units (bigint) inside, no floating point anywhere.
 * The currency list is a curated allowlist of ISO 4217 codes with their minor-unit exponents.
 */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  // 0 decimals
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0,
  // 2 decimals
  USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, NZD: 2, CHF: 2, CNY: 2, HKD: 2, SGD: 2, INR: 2, BRL: 2, MXN: 2,
  SEK: 2, NOK: 2, DKK: 2, PLN: 2, CZK: 2, HUF: 2, TRY: 2, ZAR: 2, AED: 2, SAR: 2, ILS: 2, THB: 2, MYR: 2, PHP: 2, IDR: 2, EGP: 2,
  // 3 decimals
  KWD: 3, BHD: 3, OMR: 3, JOD: 3, TND: 3,
});

export const SUPPORTED_CURRENCIES = Object.freeze(Object.keys(CURRENCY_EXPONENTS));

/** Inclusive bounds in minor units. 10^12 keeps every amount exactly representable as a JS number. */
export const MIN_AMOUNT_MINOR = 1n;
export const MAX_AMOUNT_MINOR = 1_000_000_000_000n;

export type MoneyErrorCode = "unsupported_currency" | "invalid_amount_format" | "too_many_decimals" | "amount_too_small" | "amount_too_large";

export class MoneyError extends Error {
  constructor(public readonly code: MoneyErrorCode, message: string) {
    super(message);
  }
}

export function currencyExponent(currency: string): number {
  const e = Object.hasOwn(CURRENCY_EXPONENTS, currency) ? CURRENCY_EXPONENTS[currency] : undefined;
  if (e === undefined) throw new MoneyError("unsupported_currency", `Unsupported currency: ${currency.slice(0, 8)}`);
  return e;
}

const DECIMAL = /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,15})?$/;

/** "149.00" + "USD" -> 14900n. Rejects signs, exponents, whitespace, excess precision (never rounds) and out-of-range amounts. */
export function parseAmount(input: unknown, currency: string): bigint {
  const exp = currencyExponent(currency);
  if (typeof input !== "string" || !DECIMAL.test(input)) {
    throw new MoneyError("invalid_amount_format", "Amount must be a non-negative decimal string such as \"149.00\"");
  }
  const [whole, frac = ""] = input.split(".");
  if (frac.length > exp) {
    throw new MoneyError("too_many_decimals", exp === 0 ? `${currency} does not allow decimals` : `${currency} allows at most ${exp} decimal places`);
  }
  const minor = BigInt(whole + frac.padEnd(exp, "0"));
  if (minor < MIN_AMOUNT_MINOR) throw new MoneyError("amount_too_small", "Amount must be greater than zero");
  if (minor > MAX_AMOUNT_MINOR) throw new MoneyError("amount_too_large", "Amount exceeds the maximum supported value");
  return minor;
}

/** 14900n + "USD" -> "149.00". */
export function formatAmount(minor: bigint, currency: string): string {
  const exp = currencyExponent(currency);
  const s = (minor < 0n ? -minor : minor).toString().padStart(exp + 1, "0");
  const body = exp === 0 ? s : `${s.slice(0, -exp)}.${s.slice(-exp)}`;
  return minor < 0n ? `-${body}` : body;
}

/** Safe for JSON: bounds guarantee the value is below Number.MAX_SAFE_INTEGER. */
export function minorToNumber(minor: bigint): number {
  if (minor > MAX_AMOUNT_MINOR || minor < 0n) throw new RangeError("amount out of range");
  return Number(minor);
}
