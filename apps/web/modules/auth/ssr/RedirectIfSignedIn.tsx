import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSessionUser } from "@/server/session";

/** SSR layer for public auth pages: signed-in users go to the dashboard. */
export async function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  if (user) redirect("/");
  return <>{children}</>;
}
