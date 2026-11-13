import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AppError } from "./errors";

export interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

/** Validates the session with Supabase Auth (getUser, not getSession). */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  const u = data.user;
  if (!u || !u.email) return null;
  return { id: u.id, email: u.email, emailVerified: !!u.email_confirmed_at };
}

/** The returned id is the only source of ownership for dashboard operations; it is never taken from input. */
export async function requireUser(opts: { verified?: boolean } = {}): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AppError("unauthenticated", "Please sign in");
  if (opts.verified && !user.emailVerified) throw new AppError("forbidden", "Verify your email address first");
  return user;
}
