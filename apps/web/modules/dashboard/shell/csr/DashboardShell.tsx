"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Actions } from "@/actions/client";
import { Button, SandboxBanner } from "@components/ui/form";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/sessions", label: "Checkout sessions" },
  { href: "/payments", label: "Payments" },
  { href: "/credentials", label: "Credentials" },
] as const;

export function DashboardShell({ email, children }: { email: string; children: ReactNode }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <>
      <SandboxBanner />
      <header className="border-b border-neutral-200 bg-white px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span className="font-semibold">Payment Sandbox</span>
            <nav aria-label="Main" className="flex flex-wrap gap-4 text-sm">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined} className={active(n.href) ? "font-medium text-neutral-900" : "text-neutral-500 hover:text-neutral-900"}>
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
          <form action={Actions.Auth.signOut} className="flex items-center gap-3 text-sm">
            <span className="max-w-[16rem] truncate text-neutral-500">{email}</span>
            <Button variant="ghost" type="submit">Sign out</Button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">{children}</main>
    </>
  );
}
