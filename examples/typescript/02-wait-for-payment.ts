import { SandboxClient, sleep } from "./client";

/**
 * Polls a checkout session until it leaves `open`, then lists its payments.   npx tsx examples/typescript/02-wait-for-payment.ts cs_...
 * Polling is fine for a demo; in production, confirm payments from webhooks (see examples/webhooks) and use this only as a fallback.
 */
const sessionId = process.argv[2];
if (!sessionId) throw new Error("Usage: 02-wait-for-payment.ts <cs_... session id>");

const client = new SandboxClient();
const deadline = Date.now() + 10 * 60_000;

for (;;) {
  const session = await client.request<{ id: string; status: "open" | "completed" | "expired" | "cancelled" }>("GET", `/api/v1/checkout/sessions/${sessionId}`);
  if (session.status !== "open") {
    console.log(`Session ${session.id} is ${session.status}`);
    const payments = await client.request<{ data: { id: string; status: string; failure_code: string | null }[] }>("GET", "/api/v1/payments", { query: { checkout_session_id: sessionId } });
    for (const p of payments.data) console.log(` payment ${p.id}: ${p.status}${p.failure_code ? ` (${p.failure_code})` : ""}`);
    break;
  }
  if (Date.now() > deadline) throw new Error("Gave up waiting");
  await sleep(2000);
}
