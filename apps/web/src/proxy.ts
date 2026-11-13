import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/register", "/forgot-password", "/reset-password", "/healthz"];
const PUBLIC_PREFIXES = ["/auth/"];

/** Refreshes the Supabase session cookie and does an optimistic redirect. Real authorization happens server-side per request. */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, { ...options, httpOnly: true });
      },
    },
  });
  const { data } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.includes(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));
  if (!data.user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

// /checkout/{token} is public and authorized by its secret token inside the page; it needs no dashboard session either.
// /api/v1 is authenticated by API credentials inside its own handlers. It must never be redirected to /login or read
// dashboard cookies, so the dashboard proxy does not run for it at all.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|api/v1/|checkout/).*)"] };
