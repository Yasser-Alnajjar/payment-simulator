import type { ApiErrorType } from "../api/errors";

/**
 * Every error code the public API can return, with its HTTP status and type. The contract test fails when a code appears in the
 * source but not here, when an operation lists a code that is not here, or when an operation lists a code under the wrong status.
 */
export interface ErrorCodeInfo { status: number; type: ApiErrorType; description: string }

export const ERROR_CODES: Record<string, ErrorCodeInfo> = {
  // 400 invalid_request_error
  invalid_json: { status: 400, type: "invalid_request_error", description: "The body is empty, is not valid JSON or is not a JSON object." },
  invalid_parameter: { status: 400, type: "invalid_request_error", description: "A parameter failed validation. `param` names it and `message` says why." },
  unknown_parameter: { status: 400, type: "invalid_request_error", description: "The request contains a parameter this endpoint does not accept. Unknown parameters are rejected, never ignored." },
  unsupported_currency: { status: 400, type: "invalid_request_error", description: "The currency is not in the supported list." },
  invalid_amount_format: { status: 400, type: "invalid_request_error", description: "`amount` is not a decimal string such as \"149.00\"." },
  too_many_decimals: { status: 400, type: "invalid_request_error", description: "`amount` has more decimal places than the currency allows." },
  amount_too_small: { status: 400, type: "invalid_request_error", description: "`amount` is below the minimum." },
  amount_too_large: { status: 400, type: "invalid_request_error", description: "`amount` is above the maximum." },
  invalid_cursor: { status: 400, type: "invalid_request_error", description: "`starting_after` does not identify an item of this list that you own." },
  invalid_customer: { status: 400, type: "invalid_request_error", description: "`customer` must be 1-128 characters of A-Z a-z 0-9 _ . : @ -." },
  customer_mismatch: { status: 400, type: "invalid_request_error", description: "The payment method does not belong to the `customer` you sent." },
  customer_required: { status: 400, type: "invalid_request_error", description: "A customer is required for this action." },
  scenario_locked: { status: 400, type: "invalid_request_error", description: "The session's outcome was fixed when it was created." },
  scenario_required: { status: 400, type: "invalid_request_error", description: "A scenario must be chosen." },
  scenario_with_card: { status: 400, type: "invalid_request_error", description: "A payment made with a card takes its outcome from the card." },
  idempotency_key_required: { status: 400, type: "invalid_request_error", description: "This endpoint requires an `Idempotency-Key` header." },
  invalid_idempotency_key: { status: 400, type: "invalid_request_error", description: "`Idempotency-Key` must be 1-255 characters of A-Z a-z 0-9 _ . : -." },
  invalid_card_number: { status: 400, type: "invalid_request_error", description: "The card number is not valid." },
  not_a_test_card: { status: 400, type: "invalid_request_error", description: "Only the simulator's published test card numbers are accepted. Never send a real card number." },
  card_expired: { status: 400, type: "invalid_request_error", description: "The card has already expired." },
  invalid_expiry: { status: 400, type: "invalid_request_error", description: "Expiry must be a month 1-12 and a four-digit year no more than 20 years ahead." },
  invalid_cvc: { status: 400, type: "invalid_request_error", description: "The security code has the wrong length for the card brand. It is validated and never stored." },
  invalid_cardholder_name: { status: 400, type: "invalid_request_error", description: "The cardholder name is not valid." },
  invalid_url: { status: 400, type: "invalid_request_error", description: "The webhook URL is malformed or breaks a URL rule (https only, no credentials, no fragment, allowed port, fully qualified host, length)." },
  url_not_allowed: { status: 400, type: "invalid_request_error", description: "The webhook URL points at a host that is not allowed (private, loopback, link-local, reserved or internal names). Protects against server-side request forgery." },
  // 401 authentication_error
  invalid_credentials: { status: 401, type: "authentication_error", description: "Missing, malformed or unknown credentials, or a wrong secret. All look the same on purpose." },
  credential_revoked: { status: 401, type: "authentication_error", description: "The credential was revoked. Create a new one in the dashboard." },
  credential_expired: { status: 401, type: "authentication_error", description: "The credential has passed its expiry date." },
  // 402 card_error
  card_declined: { status: 402, type: "card_error", description: "The test card is configured to decline when saved (`setup_declined` behaviour). Nothing was saved." },
  // 404 invalid_request_error
  resource_not_found: { status: 404, type: "invalid_request_error", description: "No such resource for your account. Resources of other accounts are indistinguishable from missing ones." },
  no_default_payment_method: { status: 404, type: "invalid_request_error", description: "The customer has no default payment method." },
  // 409 conflict_error / idempotency_error
  invalid_state_transition: { status: 409, type: "conflict_error", description: "The resource is in a state that does not allow this action (for example cancelling a completed session). See the state-machine guide." },
  session_expired: { status: 409, type: "conflict_error", description: "The checkout session has expired." },
  session_cancelled: { status: 409, type: "conflict_error", description: "The checkout session was cancelled." },
  session_already_completed: { status: 409, type: "conflict_error", description: "A card was already added with this setup session." },
  session_already_paid: { status: 409, type: "conflict_error", description: "The checkout session is already paid." },
  payment_in_progress: { status: 409, type: "conflict_error", description: "The checkout session already has a pending or successful payment." },
  duplicate_payment_method: { status: 409, type: "conflict_error", description: "This card is already saved for this customer." },
  payment_method_limit_reached: { status: 409, type: "conflict_error", description: "The customer already has the maximum number of saved test cards." },
  payment_method_conflict: { status: 409, type: "conflict_error", description: "The payment method was changed concurrently. Retry." },
  payment_method_disabled: { status: 409, type: "conflict_error", description: "The payment method is disabled." },
  payment_method_expired: { status: 409, type: "conflict_error", description: "The payment method has expired." },
  endpoint_limit_reached: { status: 409, type: "conflict_error", description: "The account already has the maximum number of webhook endpoints." },
  endpoint_disabled: { status: 409, type: "conflict_error", description: "The webhook endpoint is disabled. Enable it first." },
  delivery_cancelled: { status: 409, type: "conflict_error", description: "The delivery was cancelled because its endpoint was deleted." },
  delivery_not_attempted: { status: 409, type: "conflict_error", description: "The delivery has not been attempted yet, so there is nothing to retry." },
  delivery_in_progress: { status: 409, type: "conflict_error", description: "An attempt is in progress. Retry after it finishes." },
  idempotency_key_in_progress: { status: 409, type: "idempotency_error", description: "A request with this `Idempotency-Key` is still being processed. Retry shortly with the same key." },
  // 413 / 415 / 422
  body_too_large: { status: 413, type: "invalid_request_error", description: "The request body exceeds 65536 bytes." },
  unsupported_media_type: { status: 415, type: "invalid_request_error", description: "`Content-Type` must be `application/json`." },
  idempotency_key_reused: { status: 422, type: "idempotency_error", description: "This `Idempotency-Key` was already used with a different request body. Use a new key." },
  // 429 rate_limit_error
  rate_limited: { status: 429, type: "rate_limit_error", description: "More than the per-minute request limit for your account. Honour `Retry-After`." },
  too_many_failed_attempts: { status: 429, type: "rate_limit_error", description: "Too many failed authentication attempts from this address or for this credential id. Honour `Retry-After`." },
  too_many_requests: { status: 429, type: "rate_limit_error", description: "A per-action limit was hit (webhook test sends, manual retries, hosted checkout). Honour `Retry-After`." },
  too_many_payment_attempts: { status: 429, type: "rate_limit_error", description: "The checkout session reached its maximum number of payment attempts." },
  too_many_setup_attempts: { status: 429, type: "rate_limit_error", description: "The setup session reached its maximum number of attempts." },
  // 500
  internal_error: { status: 500, type: "api_error", description: "Unexpected server error. Retrying is safe for idempotent requests; quote `request_id` if it persists." },
};

/** Returned by every operation behind API authentication. */
export const COMMON_ERRORS: Record<number, string[]> = {
  401: ["invalid_credentials", "credential_revoked", "credential_expired"],
  429: ["rate_limited", "too_many_failed_attempts"],
  500: ["internal_error"],
};
