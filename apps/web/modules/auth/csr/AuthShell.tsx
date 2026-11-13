import type { ReactNode } from "react";
import { SandboxBanner } from "@components/ui/form";

export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <SandboxBanner />
      <main className="mx-auto mt-16 w-full max-w-sm space-y-4 px-4">
        <h1 className="text-xl font-semibold">{title}</h1>
        {children}
      </main>
    </>
  );
}
