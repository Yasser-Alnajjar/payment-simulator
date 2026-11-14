/**
 * End-to-end webhook receiver for testing the deployed app. Verifies every request with the reference verifier, deduplicates by event
 * id, and logs one line per request (never the secret). Run on your machine behind an HTTPS tunnel, e.g. `cloudflared tunnel --url
 * http://localhost:4545`, then register https://<tunnel-host>/hook as the endpoint URL.
 *
 *   WEBHOOK_SECRET=whsec_... pnpm --filter @sandbox/db exec tsx ../../apps/web/scripts/e2e-receiver.ts [port] [--fail-first=N] [--status=CODE]
 *
 * During a rotation set WEBHOOK_SECRET_PREVIOUS too. --fail-first=N answers 500 to the first N requests; --status forces a status.
 */
import http from "node:http";
import { verifyWebhookSignature } from "@sandbox/core";

const port = Number(process.argv.find((a) => /^[0-9]+$/.test(a)) ?? 4545);
const failFirst = Number(/--fail-first=(\d+)/.exec(process.argv.join(" "))?.[1] ?? 0);
const forced = Number(/--status=(\d{3})/.exec(process.argv.join(" "))?.[1] ?? 0);
const secrets = [process.env.WEBHOOK_SECRET, process.env.WEBHOOK_SECRET_PREVIOUS].filter((s): s is string => !!s);
if (secrets.length === 0) { console.error("Set WEBHOOK_SECRET to the endpoint's signing secret"); process.exit(1); }

const seen = new Set<string>();
let n = 0;
http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    n++;
    const raw = Buffer.concat(chunks);
    const header = req.headers["sandbox-signature"] as string | undefined;
    const ok = secrets.some((secret) => verifyWebhookSignature({ header, rawBody: raw, secret }).ok);
    let id = "?", type = "?";
    if (ok) { try { const ev = JSON.parse(raw.toString("utf8")); id = ev.id; type = ev.type; } catch { /* not JSON */ } }
    const duplicate = ok && seen.has(id);
    if (ok) seen.add(id);
    const status = !ok ? 400 : forced || (n <= failFirst ? 500 : 200);
    console.log(`${new Date().toISOString()} #${n} ${req.method} ${req.url} delivery=${req.headers["sandbox-delivery-id"]} attempt=${req.headers["sandbox-delivery-attempt"]} ` +
      `signature=${ok ? "valid" : "INVALID"} event=${id} type=${type}${duplicate ? " DUPLICATE(ignored)" : ""} -> ${status}`);
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(ok ? (duplicate ? "duplicate ignored" : "ok") : "invalid signature");
  });
}).listen(port, "127.0.0.1", () => console.log(`receiver listening on http://127.0.0.1:${port} (secrets loaded: ${secrets.length})`));
