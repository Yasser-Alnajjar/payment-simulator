import { SandboxApiError, SandboxClient, newIdempotencyKey } from "./client";

/**
 * Save a TEST card for a customer and charge it, without a checkout page.   npx tsx examples/typescript/03-saved-card-charge.ts
 * Only the published test numbers are accepted (docs/getting-started.md lists them). Never send a real card number.
 */
const client = new SandboxClient();
const customer = `cust_${Date.now()}`;

const method = await client.request<{ id: string; card: { brand: string; last4: string }; is_default: boolean }>("POST", "/api/v1/payment-methods", {
  idempotencyKey: newIdempotencyKey(),
  body: { customer, card: { number: "4242424242424242", exp_month: 12, exp_year: new Date().getFullYear() + 3, cvc: "123", name: "Ada Lovelace" }, set_default: true },
});
console.log(`Saved ${method.card.brand} ending ${method.card.last4} as ${method.id}`);

try {
  // The Idempotency-Key is REQUIRED here. Reuse it when retrying this exact charge; a new charge needs a new key.
  const payment = await client.request<{ id: string; status: string; failure_code: string | null }>("POST", "/api/v1/payments", {
    idempotencyKey: newIdempotencyKey(),
    body: { payment_method: method.id, amount: "25.00", currency: "USD", external_reference: `invoice-${Date.now()}` },
  });
  // A declined test card is NOT an HTTP error: the call succeeds and the payment has status "failed" and a failure_code.
  console.log(`Payment ${payment.id}: ${payment.status}${payment.failure_code ? ` (${payment.failure_code})` : ""}`);
} catch (e) {
  if (e instanceof SandboxApiError && (e.body.code === "payment_method_disabled" || e.body.code === "payment_method_expired")) console.error("This card cannot be charged:", e.body.code);
  else throw e;
}
