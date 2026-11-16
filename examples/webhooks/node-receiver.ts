import { createServer } from "node:http";
import { verifySandboxSignature } from "./verify";

/**
 * A complete webhook receiver with no framework.   Run:  WEBHOOK_SECRET=whsec_... npx tsx examples/webhooks/node-receiver.ts
 * Then register a public HTTPS URL that forwards to http://localhost:4000/webhooks (a tunnel such as cloudflared or ngrok) as a webhook endpoint.
 * `createReceiver(secrets)` is exported so it can be tested; the file only starts a server when run directly.
 */
export function createReceiver(secrets: readonly string[], onEvent: (event: { id: string; type: string; data: unknown }) => void = (e) => console.log("event", e.id, e.type)) {
  /** Delivery is at least once: remember processed event ids. Use your database or Redis in real code. */
  const processed = new Set<string>();

  return createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/webhooks") { res.writeHead(404).end(); return; }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks); // 1. keep the raw bytes
      const verdict = verifySandboxSignature({ header: req.headers["sandbox-signature"] as string | undefined, rawBody, secrets }); // 2. verify BEFORE parsing
      if (!verdict.ok) {
        console.warn("rejected webhook:", verdict.reason);
        res.writeHead(400, { "content-type": "text/plain" }).end(verdict.reason); // a 4xx other than 408/429 is a permanent failure: we will not retry it
        return;
      }

      const event = JSON.parse(rawBody.toString("utf8")) as { id: string; type: string; data: unknown };
      if (!processed.has(event.id)) { // 3. deduplicate on the event id (also sent in the Sandbox-Event-Id header)
        processed.add(event.id);
        onEvent(event); // 4. do your work here; keep it fast, or queue it and answer right away
      }
      res.writeHead(200).end("ok"); // 5. any 2xx within 10 seconds acknowledges. Anything else is retried.
    });
  });
}

if (process.argv[1]?.endsWith("node-receiver.ts")) {
  const secrets = (process.env.WEBHOOK_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean); // "new,old" while rotating
  if (secrets.length === 0) throw new Error("Set WEBHOOK_SECRET to the whsec_... value returned when you created the endpoint");
  createReceiver(secrets).listen(Number(process.env.PORT ?? 4000), () => console.log(`listening on :${process.env.PORT ?? 4000}/webhooks`));
}
