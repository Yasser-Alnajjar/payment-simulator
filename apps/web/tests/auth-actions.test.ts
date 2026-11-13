import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, redirect, dbFactory } = vi.hoisted(() => ({
  auth: {
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updateUser: vi.fn(),
    signOut: vi.fn(),
    getUser: vi.fn(),
  },
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); }),
  dbFactory: vi.fn(() => { throw new Error("db() must not be reached"); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth }) }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ APP_URL: "http://localhost:3100", SECRETS_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") }) }));
vi.mock("@/server/db", () => ({ db: dbFactory }));

import * as Auth from "@/actions/auth";
import * as Credentials from "@/actions/credentials";

beforeEach(() => { Object.values(auth).forEach((f) => f.mockReset()); redirect.mockClear(); dbFactory.mockClear(); });

describe("signIn", () => {
  it("rejects malformed input before contacting Supabase", async () => {
    const r = await Auth.signIn({ email: "nope", password: "" });
    expect(r.ok).toBe(false);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
  it("returns one generic message for any auth failure (no account enumeration)", async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { message: "Email not confirmed" } });
    const a = await Auth.signIn({ email: "A@Example.com", password: "pw" });
    auth.signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });
    const b = await Auth.signIn({ email: "b@example.com", password: "pw" });
    expect(a).toEqual({ ok: false, error: "Invalid email or password" });
    expect(b).toEqual(a);
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "a@example.com", password: "pw" }); // lower-cased
  });
  it("succeeds on valid credentials", async () => {
    auth.signInWithPassword.mockResolvedValue({ error: null });
    expect(await Auth.signIn({ email: "a@example.com", password: "pw" })).toEqual({ ok: true, data: undefined });
  });
});

describe("signUp", () => {
  it("enforces the password policy before contacting Supabase", async () => {
    const r = await Auth.signUp({ email: "a@example.com", password: "short" });
    expect(r.ok).toBe(false);
    expect(auth.signUp).not.toHaveBeenCalled();
  });
  it("reports needsVerification when no session is returned (email confirmation on)", async () => {
    auth.signUp.mockResolvedValue({ data: { session: null }, error: null });
    expect(await Auth.signUp({ email: "a@example.com", password: "long-enough-pw" })).toEqual({ ok: true, data: { needsVerification: true } });
    expect(auth.signUp.mock.calls[0]![0].options.emailRedirectTo).toBe("http://localhost:3100/auth/callback");
  });
  it("reports signed-in when a session is returned (confirmation off)", async () => {
    auth.signUp.mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });
    expect(await Auth.signUp({ email: "a@example.com", password: "long-enough-pw" })).toEqual({ ok: true, data: { needsVerification: false } });
  });
  it("does not leak provider error details", async () => {
    auth.signUp.mockResolvedValue({ data: {}, error: { message: "User already registered" } });
    const r = await Auth.signUp({ email: "a@example.com", password: "long-enough-pw" });
    expect(r).toEqual({ ok: false, error: "Could not create the account" });
  });
});

describe("password reset", () => {
  it("always reports success for well-formed addresses, even if Supabase errors", async () => {
    auth.resetPasswordForEmail.mockRejectedValue(new Error("boom"));
    expect(await Auth.requestPasswordReset({ email: "x@example.com" })).toEqual({ ok: true, data: undefined });
  });
  it("sends recovery links through the callback with a safe next path", async () => {
    auth.resetPasswordForEmail.mockResolvedValue({});
    await Auth.requestPasswordReset({ email: "x@example.com" });
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("x@example.com", { redirectTo: "http://localhost:3100/auth/callback?next=/reset-password" });
  });
  it("rejects malformed addresses (no email is sent)", async () => {
    expect((await Auth.requestPasswordReset({ email: "bad" })).ok).toBe(false);
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });
  it("updatePassword enforces the policy", async () => {
    expect((await Auth.updatePassword({ password: "short" })).ok).toBe(false);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
});

describe("signOut", () => {
  it("signs out and redirects to /login", async () => {
    auth.signOut.mockResolvedValue({});
    await expect(Auth.signOut()).rejects.toThrow("REDIRECT:/login");
    expect(auth.signOut).toHaveBeenCalled();
  });
});

describe("credential actions require a verified session and never reach the DB otherwise", () => {
  it("missing session -> unauthenticated, no DB access", async () => {
    auth.getUser.mockResolvedValue({ data: { user: null } });
    expect(await Credentials.createCredentialAction()).toEqual({ ok: false, error: "Please sign in" });
    expect(await Credentials.getCredentials()).toEqual({ ok: false, error: "Please sign in" });
    const id = "6f1f3a52-1c3b-4a9e-8f6e-1b2c3d4e5f60";
    expect((await Credentials.rotateCredentialAction({ credentialId: id })).ok).toBe(false);
    expect((await Credentials.revokeCredentialAction({ credentialId: id })).ok).toBe(false);
    expect(dbFactory).not.toHaveBeenCalled();
  });
  it("expired/invalid session (Supabase returns an error) behaves like a missing session", async () => {
    auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: "JWT expired" } });
    expect(await Credentials.createCredentialAction()).toEqual({ ok: false, error: "Please sign in" });
    expect(dbFactory).not.toHaveBeenCalled();
  });
  it("unverified email cannot create, rotate or revoke credentials, and the DB is never reached", async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: "u1", email: "a@b.c", email_confirmed_at: null } } });
    const id = "6f1f3a52-1c3b-4a9e-8f6e-1b2c3d4e5f60";
    const msg = { ok: false, error: "Verify your email address first" };
    expect(await Credentials.createCredentialAction()).toEqual(msg);
    expect(await Credentials.rotateCredentialAction({ credentialId: id })).toEqual(msg);
    expect(await Credentials.revokeCredentialAction({ credentialId: id })).toEqual(msg);
    expect(dbFactory).not.toHaveBeenCalled();
  });
});
