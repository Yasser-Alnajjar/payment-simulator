import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { getCheckoutView } from "@/server/services/checkout-public";
import { getSetupView } from "@/server/services/setup-sessions";
import { Brand, SandboxPill } from "@components/ui/form";
import { CheckoutPanel } from "../csr/CheckoutPanel";
import { SetupPanel } from "../csr/SetupPanel";

/** Public page authorized by the secret token in the URL. An unknown, malformed or foreign token is a plain 404 (no hint which). Two modes: payment and setup. */
export const HostedCheckout = async ({ token }: { token: string }) => {
  const now = new Date();
  const view = await getCheckoutView(db(), token, now);
  const setup = view ? null : await getSetupView(db(), token, now);
  if (!view && !setup) notFound();
  return (
    <div className="flex min-h-screen flex-col bg-sidebar">
      <header className="flex items-center justify-between px-5 py-4 sm:px-8"><Brand className="text-sm" /><SandboxPill /></header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 pb-12 pt-4">
        <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
          {view ? <CheckoutPanel token={token} view={view} /> : <SetupPanel token={token} view={setup!} />}
        </div>
        <p className="mt-5 text-center text-xs text-neutral-500">Test cards only. Real card numbers are rejected, nothing is stored beyond the last four digits, and no real money moves.</p>
      </main>
    </div>
  );
};
