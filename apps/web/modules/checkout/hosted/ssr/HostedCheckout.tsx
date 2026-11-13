import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { getCheckoutView } from "@/server/services/checkout-public";
import { getSetupView } from "@/server/services/setup-sessions";
import { SandboxBanner } from "@components/ui/form";
import { CheckoutPanel } from "../csr/CheckoutPanel";
import { SetupPanel } from "../csr/SetupPanel";

/** Public page authorized by the secret token in the URL. An unknown, malformed or foreign token is a plain 404 (no hint which). Two modes: payment and setup. */
export const HostedCheckout = async ({ token }: { token: string }) => {
  const now = new Date();
  const view = await getCheckoutView(db(), token, now);
  const setup = view ? null : await getSetupView(db(), token, now);
  if (!view && !setup) notFound();
  return (
    <>
      <SandboxBanner />
      <main className="mx-auto w-full max-w-md p-4 sm:py-10">
        <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-7">
          <p className="mb-4 text-center text-xs font-medium uppercase tracking-wide text-amber-800">Sandbox checkout · simulation only</p>
          {view ? <CheckoutPanel token={token} view={view} /> : <SetupPanel token={token} view={setup!} />}
        </div>
        <p className="mt-4 text-center text-xs text-neutral-500">Test cards only. Real card numbers are rejected, nothing is stored beyond the last four digits, and no real money moves.</p>
      </main>
    </>
  );
};
