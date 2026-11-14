import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@sandbox/db";
import { allowPrivateTargets, tickSecrets, WebhookConfigError } from "@/server/webhooks/config";
import { handleSchedulerTick, isAuthorizedTick } from "@/server/webhooks/tick-handler";

/** No database: every case here is rejected before the tick touches it (the db stub throws if used). */
const S = "s".repeat(40);
const P = "p".repeat(40);
const noDb = new Proxy({}, { get: () => { throw new Error("database must not be touched"); } }) as unknown as PrismaClient;
const call = (env: Record<string, string | undefined>, auth?: string) =>
  handleSchedulerTick(new Request("https://app.example/api/scheduler/tick", { method: "POST", headers: auth ? { authorization: auth } : {}, body: "{}" }), { db: noDb, encKey: "", env, now: () => new Date() });

describe("scheduler tick authentication", () => {
  it("is closed (404, no body) when the secret is unset or too short", async () => {
    for (const env of [{}, { SCHEDULER_TICK_SECRET: "short" }, { SCHEDULER_TICK_SECRET_PREVIOUS: P }]) {
      const r = await call(env, `Bearer ${P}`);
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("");
    }
  });
  it("rejects missing, malformed and wrong credentials with 404", async () => {
    const env = { SCHEDULER_TICK_SECRET: S };
    for (const a of [undefined, S, `Basic ${S}`, `Bearer ${S}x`, `Bearer  ${S}`, `bearer ${S}`, `Bearer ${"s".repeat(39)}`, `Bearer ${S} extra`]) {
      expect((await call(env, a)).status, String(a)).toBe(404);
    }
  });
  it("accepts the current and (while rotating) the previous secret", () => {
    expect(isAuthorizedTick(`Bearer ${S}`, tickSecrets({ SCHEDULER_TICK_SECRET: S }))).toBe(true);
    expect(isAuthorizedTick(`Bearer ${P}`, tickSecrets({ SCHEDULER_TICK_SECRET: S }))).toBe(false);
    expect(isAuthorizedTick(`Bearer ${P}`, tickSecrets({ SCHEDULER_TICK_SECRET: S, SCHEDULER_TICK_SECRET_PREVIOUS: P }))).toBe(true);
    expect(isAuthorizedTick(null, tickSecrets({ SCHEDULER_TICK_SECRET: S }))).toBe(false);
  });
  it("refuses to run with the private-target allowance outside development (500, nothing touched)", async () => {
    const r = await call({ SCHEDULER_TICK_SECRET: S, APP_ENV: "production", ALLOW_PRIVATE_WEBHOOK_TARGETS: "true" }, `Bearer ${S}`);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "configuration_error" });
  });
});

describe("private-target allowance", () => {
  it("is honoured only in development", () => {
    expect(allowPrivateTargets({})).toBe(false);
    expect(allowPrivateTargets({ ALLOW_PRIVATE_WEBHOOK_TARGETS: "false" })).toBe(false);
    expect(allowPrivateTargets({ APP_ENV: "development", ALLOW_PRIVATE_WEBHOOK_TARGETS: "true" })).toBe(true);
    expect(() => allowPrivateTargets({ APP_ENV: "production", ALLOW_PRIVATE_WEBHOOK_TARGETS: "true" })).toThrow(WebhookConfigError);
    expect(() => allowPrivateTargets({ APP_ENV: "test", ALLOW_PRIVATE_WEBHOOK_TARGETS: "true" })).toThrow(WebhookConfigError);
    expect(() => allowPrivateTargets({ ALLOW_PRIVATE_WEBHOOK_TARGETS: "yes" })).toThrow(WebhookConfigError);
    // APP_ENV unset defaults to development, so hosted markers must still close the allowance.
    expect(() => allowPrivateTargets({ VERCEL: "1", ALLOW_PRIVATE_WEBHOOK_TARGETS: "true" })).toThrow(WebhookConfigError);
    expect(() => allowPrivateTargets({ NODE_ENV: "production", ALLOW_PRIVATE_WEBHOOK_TARGETS: "true" })).toThrow(WebhookConfigError);
  });
});
