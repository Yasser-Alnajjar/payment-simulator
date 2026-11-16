import { SandboxClient, newIdempotencyKey, sleep } from "./client";

/**
 * Register a webhook endpoint, fire a test event and watch the delivery.
 *   WEBHOOK_URL=https://your-tunnel.example/webhooks npx tsx examples/typescript/05-webhook-endpoint.ts
 * The URL must be public HTTPS (private and localhost addresses are refused). Deliveries are sent by a scheduler once a minute, so allow ~1 minute.
 */
const client = new SandboxClient();
const url = process.env.WEBHOOK_URL;
if (!url) throw new Error("Set WEBHOOK_URL to a public https URL that reaches your receiver");

const endpoint = await client.request<{ id: string; secret: string }>("POST", "/api/v1/webhook-endpoints", {
  idempotencyKey: newIdempotencyKey(), // a retry with the same key returns the same secret
  body: { url, enabled_events: ["payment.succeeded", "payment.failed", "webhook_endpoint.test"], description: "example" },
});
console.log(`Endpoint ${endpoint.id}\nSigning secret (shown ONLY now, store it): ${endpoint.secret}`);

const delivery = await client.request<{ id: string }>("POST", `/api/v1/webhook-endpoints/${endpoint.id}/test`);
console.log(`Queued test delivery ${delivery.id}; waiting for the next scheduler tick...`);

for (let i = 0; i < 40; i++) {
  await sleep(3000);
  const d = await client.request<{ status: string; attempt_count: number; last_status_code: number | null; attempts?: { attempt: number; outcome: string; status_code: number | null; error_code: string | null }[] }>("GET", `/api/v1/webhook-deliveries/${delivery.id}`);
  if (d.status === "succeeded" || d.status === "failed") {
    console.log(`Delivery ${d.status} after ${d.attempt_count} attempt(s)`, d.attempts);
    break;
  }
}
