"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Actions } from "@/actions/client";
import type { SetupView } from "@/server/services/setup-sessions";
import { BRAND_LABEL } from "@/lib/test-cards";
import { fmtTime } from "@/lib/scenarios";
import { CardForm } from "@components/ui/card-form";
import { Notice } from "@components/ui/form";

const FAILURE_TEXT: Record<string, string> = {
  card_declined: "The test card was declined and was not saved. Try another test card.",
  duplicate_payment_method: "That test card is already saved for this customer. Try another one.",
};

/** Setup mode: adds a test card to the session's customer. Nothing is charged and no payment or invoice exists. */
export function SetupPanel({ token, view }: { token: string; view: SetupView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();

  return (
    <div className="grid md:grid-cols-[2fr_3fr]">
      <div className="border-b border-line bg-sidebar p-6 sm:p-8 md:border-b-0 md:border-r">
        <p className="text-sm text-neutral-500">Add a payment method</p>
        <p className="mt-1 text-3xl font-semibold tracking-tight text-neutral-900">No payment today</p>
        <p className="mt-3 break-all text-sm text-neutral-500">Customer <span className="font-mono text-xs text-neutral-900">{view.customer}</span></p>
        {view.reference && <p className="mt-1 break-all text-sm text-neutral-500">Reference <span className="font-mono text-xs text-neutral-900">{view.reference}</span></p>}
        {view.status === "open" && <p className="mt-1 text-sm text-neutral-500">Expires <span className="text-neutral-900">{fmtTime(view.expiresAt)}</span></p>}
      </div>
      <div className="space-y-5 p-6 sm:p-8">

      {view.status === "completed" && (
        <Notice tone="success" className="p-4 text-center">
          <p className="font-semibold">Test card saved</p>
          <p>{view.card ? `${BRAND_LABEL[view.card.brand] ?? view.card.brand} ending ${view.card.last4}, expires ${String(view.card.expMonth).padStart(2, "0")}/${view.card.expYear}. ` : ""}Nothing was charged. You can close this page.</p>
        </Notice>
      )}
      {view.status === "expired" && <Notice className="p-4 text-center"><p className="font-semibold">This link has expired</p><p>No card was saved. Return to the merchant to start again.</p></Notice>}
      {view.status === "cancelled" && <Notice className="p-4 text-center"><p className="font-semibold">This setup was cancelled</p><p>No card was saved.</p></Notice>}

      {view.status === "open" && (
        <>
          {view.failureCode && !error && <Notice tone="error" className="text-center">{FAILURE_TEXT[view.failureCode] ?? "The last attempt did not complete."}</Notice>}
          <CardForm
            submitLabel="Save test card" pendingLabel="Saving…" disabled={pending}
            onSubmit={async (v) => {
              const r = await Actions.Checkout.setupCardAction({ token, card: v });
              setError(r.ok ? undefined : r.error);
              router.refresh();
              return r;
            }}
          />
          <div className="flex justify-center border-t border-line pt-4 text-sm text-neutral-500">
            <button type="button" disabled={pending} className="rounded underline hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50" onClick={() => { if (window.confirm("Cancel adding a card?")) start(async () => { await Actions.Checkout.cancelSetupAction({ token }); router.refresh(); }); }}>Cancel</button>
          </div>
        </>
      )}
      </div>
    </div>
  );
}
