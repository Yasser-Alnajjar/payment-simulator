import { z } from "zod";
import { CUSTOMER_REFERENCE, SCENARIOS, SUPPORTED_CURRENCIES, MoneyError, parseAmount, MAX_PENDING_DELAY_SECONDS, MIN_PENDING_DELAY_SECONDS } from "@sandbox/core";
import { ApiError, invalidRequest } from "./errors";

export const EXPIRES_MIN = 300;
export const EXPIRES_MAX = 86_400;
export const EXPIRES_DEFAULT = 1800;
export const METADATA_MAX_KEYS = 50;
export const METADATA_MAX_BYTES = 4000;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const metadataSchema = z
  .record(z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/, "Metadata keys must be 1-40 characters of A-Z a-z 0-9 _ . -"), z.string().max(500, "Metadata values must be at most 500 characters"))
  .refine((m) => Object.keys(m).length <= METADATA_MAX_KEYS, `At most ${METADATA_MAX_KEYS} metadata keys`)
  .refine((m) => Object.entries(m).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0) <= METADATA_MAX_BYTES, `Metadata must be at most ${METADATA_MAX_BYTES} bytes`);

export const createSessionBody = z.strictObject({
  amount: z.string({ error: "amount must be a decimal string such as \"149.00\"" }),
  currency: z.string(),
  external_reference: z.string().min(1).max(255).refine((v) => !CONTROL.test(v), "No control characters").optional(),
  metadata: metadataSchema.optional(),
  expires_in: z.number().int().min(EXPIRES_MIN).max(EXPIRES_MAX).optional(),
  scenario: z.enum(SCENARIOS).optional(),
  /** Additive. Omit (or "payment") for the original payment checkout; setup sessions use createSetupBody. */
  mode: z.literal("payment").optional(),
  customer: z.string().regex(CUSTOMER_REFERENCE, "customer must be 1-128 characters of A-Z a-z 0-9 _ . : @ -").optional(),
});

export const createSetupBody = z.strictObject({
  mode: z.literal("setup"),
  customer: z.string({ error: "customer is required" }).regex(CUSTOMER_REFERENCE, "customer must be 1-128 characters of A-Z a-z 0-9 _ . : @ -"),
  external_reference: z.string().min(1).max(255).refine((v) => !CONTROL.test(v), "No control characters").optional(),
  metadata: metadataSchema.optional(),
  expires_in: z.number().int().min(EXPIRES_MIN).max(EXPIRES_MAX).optional(),
});

/** Test card details. Validated again by the card domain; messages never echo the submitted values. */
export const cardBody = z.strictObject({
  number: z.string({ error: "card.number is required" }).max(32),
  exp_month: z.number({ error: "card.exp_month must be an integer" }),
  exp_year: z.number({ error: "card.exp_year must be an integer" }),
  cvc: z.string({ error: "card.cvc is required" }).max(8),
  name: z.string().max(120).optional(),
});

export const createMethodBody = z.strictObject({
  customer: z.string({ error: "customer is required" }).regex(CUSTOMER_REFERENCE, "customer must be 1-128 characters of A-Z a-z 0-9 _ . : @ -"),
  card: cardBody,
  set_default: z.boolean().optional(),
});

export const createChargeBody = z.strictObject({
  payment_method: z.string({ error: "payment_method is required" }).max(64),
  amount: z.string({ error: "amount must be a decimal string such as \"149.00\"" }),
  currency: z.string(),
  customer: z.string().regex(CUSTOMER_REFERENCE, "customer must be 1-128 characters of A-Z a-z 0-9 _ . : @ -").optional(),
  external_reference: z.string().min(1).max(255).refine((v) => !CONTROL.test(v), "No control characters").optional(),
  metadata: metadataSchema.optional(),
});

export const methodsQuery = z.strictObject({
  limit: z.string().regex(/^[0-9]{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  starting_after: z.string().max(64).optional(),
  customer: z.string().max(128).optional(),
  status: z.enum(["active", "expired", "disabled"]).optional(),
});
export const defaultMethodQuery = z.strictObject({ customer: z.string({ error: "customer is required" }).max(128) });

const limit = z.string().regex(/^[0-9]{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(100));
const cursor = z.string().max(64);
export const sessionsQuery = z.strictObject({ limit: limit.optional(), starting_after: cursor.optional(), status: z.enum(["open", "completed", "expired", "cancelled"]).optional(), external_reference: z.string().min(1).max(255).optional() });
export const paymentsQuery = z.strictObject({ limit: limit.optional(), starting_after: cursor.optional(), status: z.enum(["pending", "succeeded", "failed", "cancelled"]).optional(), checkout_session_id: cursor.optional(), payment_method: cursor.optional(), customer: z.string().max(128).optional() });
export const eventsQuery = z.strictObject({ limit: limit.optional(), starting_after: cursor.optional(), type: z.string().max(64).optional() });

export const delaySchema = z.number().int().min(MIN_PENDING_DELAY_SECONDS).max(MAX_PENDING_DELAY_SECONDS);

/** Parses with Zod and converts the first issue into the API error envelope (unknown keys get their own code). */
export function parseWith<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issue = r.error.issues[0]!;
  const param = issue.path.length ? issue.path.join(".") : undefined;
  if (issue.code === "unrecognized_keys") throw invalidRequest("unknown_parameter", `Unknown parameter: ${(issue as { keys: string[] }).keys.slice(0, 3).join(", ")}`, (issue as { keys: string[] }).keys[0]);
  throw invalidRequest("invalid_parameter", issue.message, param);
}

export const queryObject = (url: URL): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (!(k in o)) o[k] = v;
  return o;
};

/** Converts a money failure into a validation error pointing at the right parameter. */
export function parseMoney(amount: string, currency: string): bigint {
  if (!SUPPORTED_CURRENCIES.includes(currency)) throw invalidRequest("unsupported_currency", `Unsupported currency. Supported: ${SUPPORTED_CURRENCIES.join(", ")}`, "currency");
  try {
    return parseAmount(amount, currency);
  } catch (e) {
    if (e instanceof MoneyError) throw new ApiError(400, "invalid_request_error", e.code, e.message, "amount");
    throw e;
  }
}
