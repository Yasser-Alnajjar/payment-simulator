"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Actions } from "@/actions/client";
import { Brand, FOCUS, SandboxPill } from "@components/ui/form";
import { Icon, type IconName } from "@components/ui/icons";

interface NavItem { href: string; label: string; icon: IconName }
const NAV: { label?: string; items: NavItem[] }[] = [
  { items: [{ href: "/", label: "Overview", icon: "overview" }] },
  { label: "Payments", items: [
    { href: "/sessions", label: "Checkout sessions", icon: "sessions" },
    { href: "/payments", label: "Payments", icon: "payments" },
    { href: "/payment-methods", label: "Payment methods", icon: "methods" },
  ] },
  { label: "Developers", items: [
    { href: "/webhooks", label: "Webhooks", icon: "webhooks" },
    { href: "/credentials", label: "Credentials", icon: "credentials" },
  ] },
];
const SECTION_LABEL: Record<string, string> = { sessions: "Checkout sessions", payments: "Payments", "payment-methods": "Payment methods", webhooks: "Webhooks", credentials: "Credentials" };

/** Breadcrumbs come from the route alone: a section link, then a generic label for a detail page. */
function crumbs(path: string): { label: string; href?: string }[] {
  const [section, second, third] = path.split("/").filter(Boolean);
  if (!section) return [{ label: "Overview" }];
  const root = { label: SECTION_LABEL[section] ?? section, href: `/${section}` };
  if (!second) return [{ label: root.label }];
  if (section === "webhooks" && second === "deliveries") return [root, { label: third ? "Delivery" : "Deliveries" }];
  return [root, { label: section === "sessions" ? "Session" : section === "payment-methods" ? "Card" : section === "webhooks" ? "Endpoint" : "Details" }];
}

function SidebarBody({ email, path, onNavigate }: { email: string; path: string; onNavigate?: () => void }) {
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center px-4"><Link href="/" onClick={onNavigate} className={`rounded-md ${FOCUS}`}><Brand className="text-sm" /></Link></div>
      <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto px-2.5 py-3">
        {NAV.map((g, i) => (
          <div key={i}>
            {g.label && <p className="mb-1 px-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">{g.label}</p>}
            <ul className="space-y-0.5">
              {g.items.map((n) => (
                <li key={n.href}>
                  <Link href={n.href} onClick={onNavigate} aria-current={active(n.href) ? "page" : undefined}
                    className={`group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${FOCUS} ${active(n.href) ? "bg-subtle font-medium text-neutral-900" : "text-neutral-600 hover:bg-subtle/70 hover:text-neutral-900"}`}>
                    <Icon name={n.icon} className={active(n.href) ? "text-accent" : "text-neutral-400 group-hover:text-neutral-600"} />
                    {n.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="shrink-0 border-t border-line p-2.5">
        <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
          <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-subtle text-xs font-semibold uppercase text-neutral-700 ring-1 ring-line">{email.slice(0, 1)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-neutral-900" title={email}>{email}</p>
            <p className="text-[11px] text-neutral-500">Sandbox account</p>
          </div>
          <form action={Actions.Auth.signOut}>
            <button type="submit" aria-label="Sign out" title="Sign out" className={`rounded-md p-1.5 text-neutral-500 hover:bg-subtle hover:text-neutral-900 ${FOCUS}`}><Icon name="signout" /></button>
          </form>
        </div>
      </div>
    </div>
  );
}

export function DashboardShell({ email, children }: { email: string; children: ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const trail = crumbs(path);

  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); menuRef.current?.focus(); } };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open]);

  return (
    <div className="min-h-screen bg-canvas">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-sidebar lg:block"><SidebarBody email={email} path={path} /></aside>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" aria-label="Close menu" tabIndex={-1} className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside role="dialog" aria-modal="true" aria-label="Navigation" className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-line bg-sidebar shadow-xl">
            <button ref={closeRef} type="button" aria-label="Close menu" onClick={() => setOpen(false)} className={`absolute right-2 top-2 rounded-md p-1.5 text-neutral-500 hover:bg-subtle hover:text-neutral-900 ${FOCUS}`}><Icon name="close" /></button>
            <SidebarBody email={email} path={path} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-line bg-canvas/85 px-4 backdrop-blur sm:px-6 lg:px-8">
          <button ref={menuRef} type="button" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)} className={`-ml-1.5 rounded-md p-1.5 text-neutral-600 hover:bg-subtle lg:hidden ${FOCUS}`}><Icon name="menu" size={18} /></button>
          <Link href="/" className={`rounded-md lg:hidden ${FOCUS}`}><Brand className="text-sm" /></Link>
          <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-[13px] lg:flex">
            {trail.map((c, i) => (
              <span key={i} className="flex min-w-0 items-center gap-1.5">
                {i > 0 && <Icon name="chevron" size={12} className="text-neutral-400" />}
                {c.href && i < trail.length - 1
                  ? <Link href={c.href} className={`rounded text-neutral-500 hover:text-neutral-900 ${FOCUS}`}>{c.label}</Link>
                  : <span aria-current="page" className="truncate font-medium text-neutral-900">{c.label}</span>}
              </span>
            ))}
          </nav>
          <div className="ml-auto"><SandboxPill /></div>
        </header>
        <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
