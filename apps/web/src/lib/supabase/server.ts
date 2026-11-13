import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** Server client using the ANON key + the user's session cookie. The service_role key is never used. */
export async function createSupabaseServerClient() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          // No browser-side Supabase client exists, so the session cookie can be HttpOnly (unreadable by page scripts).
          for (const { name, value, options } of list) store.set(name, value, { ...options, httpOnly: true });
        } catch {
          // Called from a Server Component; the proxy refreshes the session instead.
        }
      },
    },
  });
}
