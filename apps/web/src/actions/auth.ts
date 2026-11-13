"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { serverEnv } from "@/lib/env";
import type { ActionResult } from "@/lib/types/common";
import { fail, invalid } from "./utils";

const email = z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email"));
const password = z.string().min(10, "At least 10 characters").max(128);

export async function signIn(input: unknown): Promise<ActionResult> {
  const p = z.object({ email, password: z.string().min(1).max(128) }).safeParse(input);
  if (!p.success) return invalid(p.error);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(p.data);
  if (error) return { ok: false, error: "Invalid email or password" }; // no account enumeration
  return { ok: true, data: undefined };
}

export async function signUp(input: unknown): Promise<ActionResult<{ needsVerification: boolean }>> {
  const p = z.object({ email, password }).safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({
      ...p.data,
      options: { emailRedirectTo: `${serverEnv().APP_URL}/auth/callback` },
    });
    if (error) return { ok: false, error: "Could not create the account" };
    return { ok: true, data: { needsVerification: !data.session } };
  } catch (e) {
    return fail(e);
  }
}

export async function requestPasswordReset(input: unknown): Promise<ActionResult> {
  const p = z.object({ email }).safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.resetPasswordForEmail(p.data.email, { redirectTo: `${serverEnv().APP_URL}/auth/callback?next=/reset-password` });
  } catch (e) {
    console.error("password reset failed", e instanceof Error ? e.name : "unknown");
  }
  return { ok: true, data: undefined }; // always succeed: no account enumeration
}

export async function updatePassword(input: unknown): Promise<ActionResult> {
  const p = z.object({ password }).safeParse(input);
  if (!p.success) return invalid(p.error);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ password: p.data.password });
  if (error) return { ok: false, error: "Could not update the password" };
  return { ok: true, data: undefined };
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
