import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readJsonBody } from "@/server/api/http";
import { parseBasic } from "@/server/api/auth";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { exchangeCodeForSession: async () => ({ error: null }) } }) }));

/** S6 hardening: no database. Open-redirect guard on the auth callback, the streaming body cap, and Basic parsing limits. */
describe("auth callback redirect", () => {
  it("only follows same-origin relative paths", async () => {
    const { GET } = await import("@/app/auth/callback/route");
    const go = async (next: string) => (await GET(new NextRequest(`https://app.example/auth/callback?code=c&next=${encodeURIComponent(next)}`))).headers.get("location");
    expect(await go("/sessions")).toBe("https://app.example/sessions");
    for (const evil of ["//evil.example", "https://evil.example", "/\\evil.example", "/..%2f@evil", "javascript:alert(1)", "/a?b=https://evil.example", "///evil.example"]) {
      expect(await go(evil), evil).toBe("https://app.example/");
    }
  });
});

describe("request body cap", () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request("https://app.example/x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body, duplex: "half" } as RequestInit);
  it("rejects an oversized streamed body even without Content-Length", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":"' + "x".repeat(70_000) + '"}')); c.close(); } });
    await expect(readJsonBody(post(stream))).rejects.toMatchObject({ status: 413 });
  });
  it("refuses a declared oversized Content-Length up front", async () => {
    await expect(readJsonBody(post("{}", { "content-length": "999999" }))).rejects.toMatchObject({ status: 413 });
  });
  it("rejects wrong media type, arrays and non-JSON", async () => {
    await expect(readJsonBody(post("{}", { "content-type": "text/plain" }))).rejects.toMatchObject({ status: 415 });
    await expect(readJsonBody(post("[]"))).rejects.toMatchObject({ code: "invalid_json" });
    await expect(readJsonBody(post("{"))).rejects.toMatchObject({ code: "invalid_json" });
  });
});

describe("Basic header parsing", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  it("accepts well-formed and rejects oversized or malformed values", () => {
    expect(parseBasic(`Basic ${b64("id:secret")}`)).toEqual({ clientId: "id", secret: "secret" });
    for (const h of [null, "", "Bearer x", `Basic ${b64("nocolon")}`, `Basic ${b64(":s")}`, `Basic ${b64("i:")}`, `Basic ${b64("i".repeat(101) + ":s")}`, `Basic ${b64("i:" + "s".repeat(201))}`, "Basic " + "A".repeat(700)]) {
      expect(parseBasic(h), String(h)).toBeNull();
    }
  });
});
