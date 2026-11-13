"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Actions } from "@/actions/client";
import type { SetupView } from "@/server/services/setup-sessions";
import { BRAND_LABEL } from "@/lib/test-cards";
import { fmtTime } from "@/lib/scenarios";
import { CardForm } from "@components/ui/card-form";

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
    <div className="space-y-5">
      <div className="text-center">
        <p className="text-sm text-neutral-500">Add a payment method</p>
        <p className="text-2xl font-semibold tracking-tight">No payment today</p>
        <p className="mt-1 break-all text-sm text-neutral-500">Customer: {view.customer}{view.reference ? ` · Reference: ${view.reference}` : ""}</p>
      </div>

      {view.status === "completed" && (
        <div role="status" className="rounded-md bg-green-50 p-4 text-center text-green-900">
          <p className="font-semibold">Test card saved</p>
          <p className="text-sm">{view.card ? `${BRAND_LABEL[view.card.brand] ?? view.card.brand} ending ${view.card.last4}, expires ${String(view.card.expMonth).padStart(2, "0")}/${view.card.expYear}. ` : ""}Nothing was charged. You can close this page.</p>
        </div>
      )}
      {view.status === "expired" && <div role="status" className="rounded-md bg-neutral-100 p-4 text-center"><p className="font-semibold">This link has expired</p><p className="text-sm text-neutral-600">No card was saved. Return to the merchant to start again.</p></div>}
      {view.status === "cancelled" && <div role="status" className="rounded-md bg-neutral-100 p-4 text-center"><p className="font-semibold">This setup was cancelled</p><p className="text-sm text-neutral-600">No card was saved.</p></div>}

      {view.status === "open" && (
        <>
          {view.failureCode && !error && <p role="alert" className="rounded-md bg-red-50 p-3 text-center text-sm text-red-800">{FAILURE_TEXT[view.failureCode] ?? "The last attempt did not complete."}</p>}
          <CardForm
            submitLabel="Save test card" pendingLabel="Saving…" disabled={pending}
            onSubmit={async (v) => {
              const r = await Actions.Checkout.setupCardAction({ token, card: v });
              setError(r.ok ? undefined : r.error);
              router.refresh();
              return r;
            }}
          />
          <div className="flex flex-col items-center gap-1 text-sm text-neutral-500">
            <span>Expires {fmtTime(view.expiresAt)}</span>
            <button type="button" disabled={pending} className="underline hover:text-neutral-900 disabled:opacity-50" onClick={() => { if (window.confirm("Cancel adding a card?")) start(async () => { await Actions.Checkout.cancelSetupAction({ token }); router.refresh(); }); }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
