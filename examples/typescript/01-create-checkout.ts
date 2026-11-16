import { SandboxApiError, SandboxClient, newIdempotencyKey } from "./client";

/** Create a hosted checkout and print where to send the payer.   npx tsx examples/typescript/01-create-checkout.ts */
const client = new SandboxClient();
const orderId = `order-${Date.now()}`;

try {
  const session = await client.request<{ id: string; url: string; status: string; amount: string; currency: string }>("POST", "/api/v1/checkout/sessions", {
    // One key per logical operation: if this call times out and you repeat it, you get the SAME session back instead of a second one.
    idempotencyKey: newIdempotencyKey(),
    body: {
      amount: "149.00", // a decimal string, never a float
      currency: "USD",
      external_reference: orderId, // your own id; shows up in events and lists
      metadata: { plan: "pro" },
      // scenario: "decline", // optional: fix the outcome (success, decline, pending, pending_then_success, pending_then_failure, cancel, timeout)
      // expires_in: 600,     // seconds, 300-86400, default 1800
    },
  });
  console.log(`Created ${session.id} (${session.status}) for ${session.amount} ${session.currency}`);
  console.log(`Open this URL as the payer (it is shown only once): ${session.url}`);
} catch (e) {
  if (e instanceof SandboxApiError) { console.error(`Rejected: ${e.body.code} on ${e.body.param ?? "-"}: ${e.body.message}`); process.exit(1); }
  throw e;
}
