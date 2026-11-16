import { verifySandboxSignature } from "./verify";

/**
 * Next.js App Router webhook route, e.g. app/api/webhooks/sandbox/route.ts   (copy verify.ts next to it).
 * No next/server import is needed: route handlers receive and return standard Request/Response objects.
 * Set SANDBOX_WEBHOOK_SECRETS to the whsec_... value (comma separated "new,old" while rotating).
 */
export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text(); // NOT req.json(): the signature covers the exact bytes
  const verdict = verifySandboxSignature({
    header: req.headers.get("sandbox-signature"),
    rawBody,
    secrets: (process.env.SANDBOX_WEBHOOK_SECRETS ?? "").split(",").filter(Boolean),
  });
  if (!verdict.ok) return new Response(verdict.reason, { status: 400 });

  const event = JSON.parse(rawBody) as { id: string; type: string; data: Record<string, unknown> };
  switch (event.type) {
    case "payment.succeeded":
      // mark the order paid; make this idempotent (the same event can arrive more than once)
      break;
    case "payment.failed":
      break;
    default:
      break; // acknowledge event types you do not care about, or the delivery will keep retrying
  }
  return new Response("ok", { status: 200 });
}
