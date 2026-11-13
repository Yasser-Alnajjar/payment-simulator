import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));

import { credentialIdInput } from "@/actions/schemas";
import { AppError } from "@/server/errors";
import { requireUser } from "@/server/session";

describe("action inputs never carry ownership", () => {
  it("strips a spoofed userId and rejects non-uuid ids", () => {
    const id = "6f1f3a52-1c3b-4a9e-8f6e-1b2c3d4e5f60";
    const parsed = credentialIdInput.parse({ credentialId: id, userId: "attacker", user_id: "attacker" });
    expect(parsed).toEqual({ credentialId: id });
    expect(credentialIdInput.safeParse({ credentialId: "1; drop table" }).success).toBe(false);
    expect(credentialIdInput.safeParse({}).success).toBe(false);
  });
});

describe("requireUser (auth boundary)", () => {
  beforeEach(() => getUser.mockReset());
  const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof AppError ? e.code : "other"; } };

  it("rejects when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect(await code(requireUser())).toBe("unauthenticated");
  });
  it("requires a verified email when asked", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1", email: "a@b.c", email_confirmed_at: null } } });
    expect(await code(requireUser({ verified: true }))).toBe("forbidden");
    expect(await code(requireUser())).toBe("ok");
  });
  it("returns the session's id, the only source of ownership", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1", email: "a@b.c", email_confirmed_at: "2026-01-01" } } });
    expect((await requireUser({ verified: true })).id).toBe("u1");
  });
});
