import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { buildSignatureHeader, generateWebhookSecret, verifyWebhookSignature } from "@sandbox/core";
import { sendWebhook } from "@/server/webhooks/sender";
import { createReceiver } from "../../../examples/webhooks/node-receiver";
import { POST as nextRoute } from "../../../examples/webhooks/nextjs-route";
import { verifySandboxSignature } from "../../../examples/webhooks/verify";

/**
 * S5: the webhook EXAMPLES are verified against the REAL signer in packages/core (`buildSignatureHeader`, the function the delivery engine
 * calls) and, end to end, against the real HTTP sender. No database is involved. The example verifier is also compared, case by case,
 * with core's reference verifier, so the two can never disagree about a header.
 */
const NOW = new Date("2026-11-16T12:00:00.000Z");
const ts = (offsetSeconds = 0) => Math.floor(NOW.getTime() / 1000) + offsetSeconds;
const BODY = '{"id":"evt_00000000-0000-4000-8000-000000000001","object":"event","type":"payment.succeeded","created":"2026-11-16T12:00:00.000Z","api_version":"2026-11-01","data":{"payment_id":"pay_1","amount":"149.00"}}';
const NEW = generateWebhookSecret();
const OLD = generateWebhookSecret();

const both = (header: string | null, rawBody: string, secrets: string[], now = NOW, tol?: number) => {
  const example = verifySandboxSignature({ header, rawBody, secrets, now, toleranceSeconds: tol });
  const reference = secrets.map((secret) => verifyWebhookSignature({ header, rawBody, secret, now, toleranceSeconds: tol }));
  return { example, reference };
};

describe("webhook example verifier vs the real signer", () => {
  it("accepts a header produced by the real signer", () => {
    const header = buildSignatureHeader([NEW], ts(), BODY);
    const { example, reference } = both(header, BODY, [NEW]);
    expect(example).toEqual({ ok: true, timestamp: ts() });
    expect(reference[0]).toEqual({ ok: true, timestamp: ts() });
  });

  it("signature rotation: the header carries two v1 values (new first); a receiver with either secret, or both, accepts it", () => {
    const header = buildSignatureHeader([NEW, OLD], ts(), BODY);
    expect(header.match(/v1=/g)!.length).toBe(2);
    expect(verifySandboxSignature({ header, rawBody: BODY, secrets: [NEW], now: NOW }).ok).toBe(true); // already switched to the new secret
    expect(verifySandboxSignature({ header, rawBody: BODY, secrets: [OLD], now: NOW }).ok).toBe(true); // not yet switched: still the old secret
    expect(verifySandboxSignature({ header, rawBody: BODY, secrets: [OLD, NEW], now: NOW }).ok).toBe(true); // holding both while rotating
    expect(verifySandboxSignature({ header, rawBody: BODY, secrets: generateWebhookSecret(), now: NOW })).toEqual({ ok: false, reason: "no_matching_signature" });
    // after the 24 h overlap only the new signature is sent: the old secret is rejected, the new one accepted
    const after = buildSignatureHeader([NEW], ts(), BODY);
    expect(verifySandboxSignature({ header: after, rawBody: BODY, secrets: [OLD], now: NOW }).ok).toBe(false);
    expect(verifySandboxSignature({ header: after, rawBody: BODY, secrets: [NEW], now: NOW }).ok).toBe(true);
    // the example agrees with core on every rotation case
    for (const secrets of [[NEW], [OLD]]) expect(verifyWebhookSignature({ header, rawBody: BODY, secret: secrets[0]!, now: NOW }).ok).toBe(true);
  });

  it("tampering: any change to the body bytes is rejected, including harmless-looking re-serialisation", () => {
    const header = buildSignatureHeader([NEW], ts(), BODY);
    const tampered = [
      BODY.replace("149.00", "1.00"), // changed value
      BODY.replace('"amount"', '"amount" '), // added whitespace
      JSON.stringify(JSON.parse(BODY)) + "\n", // re-serialised plus trailing newline
      BODY.slice(0, -1), // truncated
      BODY + " ", // appended
      "", // empty
    ];
    for (const body of tampered) {
      const { example, reference } = both(header, body, [NEW]);
      expect(example, body.slice(0, 40)).toEqual({ ok: false, reason: "no_matching_signature" });
      expect(reference[0]).toEqual(example);
    }
    expect(JSON.stringify(JSON.parse(BODY))).toBe(BODY); // (compact JSON round-trips, so only the cases above are real tampering)
    // a tampered or foreign signature value, and a signature for another timestamp
    const sig = /v1=([0-9a-f]{64})/.exec(header)![1]!;
    const flipped = header.replace(sig, (sig[0] === "0" ? "1" : "0") + sig.slice(1));
    expect(both(flipped, BODY, [NEW]).example).toEqual({ ok: false, reason: "no_matching_signature" });
    expect(both(header.replace(`t=${ts()}`, `t=${ts(1)}`), BODY, [NEW]).example).toEqual({ ok: false, reason: "no_matching_signature" });
  });

  it("stale and future timestamps are rejected at the 5 minute boundary, and agree with core", () => {
    for (const [offset, ok] of [[0, true], [-299, true], [-300, true], [-301, false], [-3600, false], [301, false], [300, true], [86_400, false]] as const) {
      const header = buildSignatureHeader([NEW], ts(offset), BODY); // validly signed, just old (or from the future)
      const { example, reference } = both(header, BODY, [NEW]);
      expect(example.ok, `offset ${offset}`).toBe(ok);
      if (!ok) expect(example).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
      expect(reference[0], `offset ${offset}`).toEqual(example);
    }
    // a replay of an old, validly signed delivery is accepted only if the receiver explicitly widens the window
    const old = buildSignatureHeader([NEW], ts(-3600), BODY);
    expect(verifySandboxSignature({ header: old, rawBody: BODY, secrets: [NEW], now: NOW, toleranceSeconds: 7200 }).ok).toBe(true);
  });

  it("malformed headers are rejected the same way as core rejects them", () => {
    const good = buildSignatureHeader([NEW], ts(), BODY);
    const v1 = /v1=([0-9a-f]{64})/.exec(good)![1]!;
    const cases: (string | null | undefined)[] = [
      null, undefined, "", "garbage", `v1=${v1}`, `t=${ts()}`, `t=abc,v1=${v1}`, `t=${ts()},v1=zz`, `t=${ts()},v1=${v1.slice(0, 62)}`, `t=${ts()},t=${ts()},v1=${v1}`, `t=${ts()};v1=${v1}`,
      `t=-5,v1=${v1}`, `t=${ts()},v1=${v1.toUpperCase()}`, "x".repeat(2000),
    ];
    for (const header of cases) {
      const { example, reference } = both(header ?? null, BODY, [NEW]);
      expect(example.ok, String(header).slice(0, 30)).toBe(false);
      expect(reference[0], String(header).slice(0, 30)).toEqual(example);
    }
    // unknown schemes are ignored (forward compatible), exactly as in core
    const withV2 = `${good},v2=abcdef`;
    expect(both(withV2, BODY, [NEW]).example.ok).toBe(true);
    expect(both(withV2, BODY, [NEW]).reference[0]!.ok).toBe(true);
  });

  it("verifies binary-safe bodies given as bytes or text, with a multibyte payload", () => {
    const body = '{"message":"Zahlung erhalten € ü 💳"}';
    const header = buildSignatureHeader([NEW], ts(), body);
    expect(verifySandboxSignature({ header, rawBody: Buffer.from(body, "utf8"), secrets: [NEW], now: NOW }).ok).toBe(true);
    expect(verifySandboxSignature({ header, rawBody: body, secrets: [NEW], now: NOW }).ok).toBe(true);
  });
});

describe("webhook examples end to end, through the real sender", () => {
  const events: string[] = [];
  const receiver = createReceiver([NEW, OLD], (e) => events.push(e.id));
  let url = "";
  const ready = new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => { url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhooks`; r(); }));
  afterAll(async () => { receiver.closeAllConnections(); await new Promise<void>((r) => receiver.close(() => r())); });

  const deliver = async (headerFor: (body: string) => string, body = BODY) => {
    await ready;
    const r = await sendWebhook({ url, headers: { "content-type": "application/json", "sandbox-signature": headerFor(body), "sandbox-event-id": "evt_x" }, body }, { allowPrivate: true });
    return r.kind === "response" ? r.status : r;
  };

  it("the example Node receiver acknowledges a delivery signed like the engine signs it, and deduplicates retries", async () => {
    const now = () => Math.floor(Date.now() / 1000);
    expect(await deliver((b) => buildSignatureHeader([NEW], now(), b))).toBe(200);
    expect(await deliver((b) => buildSignatureHeader([NEW], now(), b))).toBe(200); // same event again
    expect(events).toEqual(["evt_00000000-0000-4000-8000-000000000001"]);
  });
  it("accepts a rotation-window delivery (both secrets) and a delivery signed with the old secret only", async () => {
    const now = () => Math.floor(Date.now() / 1000);
    expect(await deliver((b) => buildSignatureHeader([NEW, OLD], now(), b))).toBe(200);
    expect(await deliver((b) => buildSignatureHeader([OLD], now(), b))).toBe(200);
  });
  it("answers 400 (a permanent failure for the sender, so it will not retry) to a tampered, stale, unsigned or wrongly signed delivery", async () => {
    const now = () => Math.floor(Date.now() / 1000);
    expect(await deliver((b) => buildSignatureHeader([NEW], now(), b), BODY.replace("149.00", "1.00"))).toBe(200); // control: signed over the body that is actually delivered
    expect(await deliver((b) => buildSignatureHeader([NEW], now(), BODY), BODY.replace("149.00", "1.00"))).toBe(400); // signed over the ORIGINAL body, delivered tampered
    expect(await deliver((b) => buildSignatureHeader([NEW], now() - 3600, b))).toBe(400); // stale
    expect(await deliver((b) => buildSignatureHeader([generateWebhookSecret()], now(), b))).toBe(400); // unknown secret
    expect(await deliver(() => "")).toBe(400); // missing
  });
});

describe("the Next.js example route", () => {
  const post = (header: string | null, body: string) => nextRoute(new Request("http://localhost/api/webhooks/sandbox", { method: "POST", headers: header ? { "sandbox-signature": header } : {}, body }));
  it("returns 200 for a valid signature and 400 otherwise", async () => {
    process.env.SANDBOX_WEBHOOK_SECRETS = `${NEW},${OLD}`;
    const now = Math.floor(Date.now() / 1000);
    expect((await post(buildSignatureHeader([NEW], now, BODY), BODY)).status).toBe(200);
    expect((await post(buildSignatureHeader([OLD], now, BODY), BODY)).status).toBe(200);
    expect((await post(buildSignatureHeader([NEW], now, BODY), BODY + " ")).status).toBe(400);
    expect((await post(buildSignatureHeader([NEW], now - 3600, BODY), BODY)).status).toBe(400);
    expect((await post(null, BODY)).status).toBe(400);
    process.env.SANDBOX_WEBHOOK_SECRETS = "";
    expect((await post(buildSignatureHeader([NEW], now, BODY), BODY)).status).toBe(400); // no secret configured: never accept
  });
});
