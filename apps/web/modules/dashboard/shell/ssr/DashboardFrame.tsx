import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSessionUser, type SessionUser } from "@/server/session";
import { DashboardShell } from "../csr/DashboardShell";

/** Authenticated page frame. Resolves the user (the only source of ownership) and renders the navigation shell. */
export async function DashboardFrame({ children }: { children: (user: SessionUser) => Promise<ReactNode> | ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return <DashboardShell email={user.email}>{await children(user)}</DashboardShell>;
}
