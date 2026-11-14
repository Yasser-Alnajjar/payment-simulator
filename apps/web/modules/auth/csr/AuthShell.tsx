import type { ReactNode } from "react";
import { Brand, SandboxPill } from "@components/ui/form";

/** Independent layout for sign-in flows: a quiet centered column on the sidebar tone, no dashboard chrome. */
export function AuthShell({ title, description, children, footer }: { title: string; description?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-sidebar">
      <header className="flex items-center justify-between px-5 py-4 sm:px-8"><Brand className="text-sm" /><SandboxPill /></header>
      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-8 sm:items-center sm:pt-0">
        <div className="w-full max-w-sm">
          <div className="rounded-xl border border-line bg-surface p-6 shadow-sm sm:p-7">
            <h1 className="text-lg font-semibold tracking-tight text-neutral-900">{title}</h1>
            {description && <p className="mt-1 text-sm text-neutral-500">{description}</p>}
            <div className="mt-6 space-y-4">{children}</div>
          </div>
          {footer && <p className="mt-5 text-center text-sm text-neutral-500">{footer}</p>}
        </div>
      </main>
    </div>
  );
}
