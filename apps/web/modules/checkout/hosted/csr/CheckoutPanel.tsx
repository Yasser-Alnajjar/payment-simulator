"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Actions } from "@/actions/client";
import type { CheckoutView } from "@/server/services/checkout-public";
import { DELAY_SCENARIOS, fmtTime, scenarioLabel, SCENARIO_OPTIONS } from "@/lib/scenarios";
import type { ActionResult } from "@/lib/types/common";
import { BEHAVIOR_LABEL, BRAND_LABEL } from "@/lib/test-cards";
import { Button, FieldLabel, FormError, Input, Notice } from "@components/ui/form";
import { CardForm } from "@components/ui/card-form";

const FAILURE_TEXT: Record<string, string> = {
  declined: "The payment was declined.",
  payment_cancelled: "The payment was cancelled.",
  session_expired: "The payment was cancelled because the checkout expired.",
  session_cancelled: "The payment was cancelled because the checkout was cancelled.",
  timeout: "The payment timed out.",
  card_declined: "The test card was declined.",
  insufficient_funds: "The test card has insufficient funds.",
  authentication_required: "The test card requires authentication (not simulated: the payment fails).",
  processor_error: "The simulated payment processor failed.",
};

/** The page never decides anything: it shows server state and sends the customer's choice to the server, which validates and applies it. */
export function CheckoutPanel({ token, view }: { token: string; view: CheckoutView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [scenario, setScenario] = useState<string>(view.presetScenario ?? "success");
  const [delay, setDelay] = useState(5);
  const usable = view.savedCards.filter((c) => c.status === "active");
  const [choice, setChoice] = useState<string>(view.cardAllowed ? (usable.find((c) => c.isDefault) ?? usable[0])?.id ?? "new" : "simulated");
  const [save, setSave] = useState(true);
  const waiting = view.status === "open" && view.payment?.status === "pending";

  // Poll while a payment is pending; also refresh once when the session is due to expire.
  useEffect(() => {
    if (view.status !== "open") return;
    const id = waiting ? setInterval(() => router.refresh(), 3000) : undefined;
    const ms = new Date(view.expiresAt).getTime() - Date.now();
    const t = ms > 0 && ms < 2 ** 31 - 1 ? setTimeout(() => router.refresh(), ms + 500) : undefined;
    return () => { if (id) clearInterval(id); if (t) clearTimeout(t); };
  }, [waiting, view.status, view.expiresAt, router]);

  const act = (fn: () => Promise<ActionResult<unknown>>) => start(async () => {
    const r = await fn();
    setError(r.ok ? undefined : r.error);
    router.refresh();
  });

  const reason = view.payment?.failureCode ? FAILURE_TEXT[view.payment.failureCode] ?? "The payment did not complete." : "The payment did not complete.";

  return (
    <div className="grid md:grid-cols-[2fr_3fr]">
      <div className="border-b border-line bg-sidebar p-6 sm:p-8 md:border-b-0 md:border-r">
        <p className="text-sm text-neutral-500">Amount due</p>
        <p className="tabular mt-1 text-4xl font-semibold tracking-tight text-neutral-900" aria-label={`${view.amount} ${view.currency}`}>{view.amount} <span className="text-lg font-medium text-neutral-500">{view.currency}</span></p>
        {view.reference && <p className="mt-3 break-all text-sm text-neutral-500">Reference <span className="font-mono text-xs text-neutral-900">{view.reference}</span></p>}
        {view.status === "open" && <p className="mt-1 text-sm text-neutral-500">Expires <span className="text-neutral-900">{fmtTime(view.expiresAt)}</span></p>}
      </div>
      <div className="space-y-5 p-6 sm:p-8">

      {view.status === "completed" && (
        <Notice tone="success" className="p-4 text-center"><p className="font-semibold">Payment successful</p><p>{view.payment?.card ? `Paid with test card ending ${view.payment.card.last4}. ` : ""}This is a simulated payment. You can close this page.</p></Notice>
      )}
      {view.status === "expired" && (
        <Notice className="p-4 text-center"><p className="font-semibold">This checkout has expired</p><p>{view.payment?.status === "cancelled" ? `${reason} ` : ""}Return to the merchant to start a new one.</p></Notice>
      )}
      {view.status === "cancelled" && (
        <Notice className="p-4 text-center"><p className="font-semibold">This checkout was cancelled</p><p>No payment was taken.</p></Notice>
      )}

      {waiting && (
        <Notice tone="warning" className="p-4 text-center">
          <p className="font-semibold">Payment pending</p>
          <p>{view.payment?.resolveAt ? `Resolves automatically at ${fmtTime(view.payment.resolveAt)}. ` : "Waiting for the merchant to resolve it in the dashboard. "}This page updates by itself.</p>
        </Notice>
      )}

      {view.status === "open" && view.payment && (view.payment.status === "failed" || view.payment.status === "cancelled") && (
        <Notice tone="error" className="text-center">{reason} You can try again.</Notice>
      )}

      {view.canPay && (
        <div className="space-y-4">
          {view.cardAllowed && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium text-neutral-900">Pay with</legend>
              {view.savedCards.map((c) => (
                <label key={c.id} className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent hover:bg-subtle ${choice === c.id ? "border-accent bg-subtle" : "border-line"} ${c.status !== "active" ? "opacity-60" : ""}`}>
                  <input type="radio" className="mt-1 accent-accent" name="method" value={c.id} disabled={c.status !== "active"} checked={choice === c.id} onChange={() => setChoice(c.id)} />
                  <span><span className="block font-medium">{BRAND_LABEL[c.brand] ?? c.brand} ending {c.last4}{c.isDefault ? " · default" : ""}</span>
                    <span className="text-xs text-neutral-500">Expires {String(c.expMonth).padStart(2, "0")}/{c.expYear} · test card · {c.status === "active" ? BEHAVIOR_LABEL[c.behavior] ?? c.behavior : "expired"}</span></span>
                </label>
              ))}
              <label className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent hover:bg-subtle ${choice === "new" ? "border-accent bg-subtle" : "border-line"}`}>
                <input type="radio" className="mt-1 accent-accent" name="method" value="new" checked={choice === "new"} onChange={() => setChoice("new")} />
                <span><span className="block font-medium">Use a new test card</span><span className="text-xs text-neutral-500">The outcome comes from the test card you enter.</span></span>
              </label>
              <label className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent hover:bg-subtle ${choice === "simulated" ? "border-accent bg-subtle" : "border-line"}`}>
                <input type="radio" className="mt-1 accent-accent" name="method" value="simulated" checked={choice === "simulated"} onChange={() => setChoice("simulated")} />
                <span><span className="block font-medium">No card: choose the outcome</span><span className="text-xs text-neutral-500">Pick a simulated result directly.</span></span>
              </label>
            </fieldset>
          )}

          {view.cardAllowed && choice !== "new" && choice !== "simulated" && (
            <div className="space-y-3">
              <FormError>{error}</FormError>
              <Button type="button" disabled={pending} className="w-full py-2.5" onClick={() => act(() => Actions.Checkout.payWithCardAction({ token, saved: choice }))}>{pending ? "Processing…" : `Pay ${view.amount} ${view.currency}`}</Button>
            </div>
          )}

          {view.cardAllowed && choice === "new" && (
            <CardForm
              submitLabel={`Pay ${view.amount} ${view.currency}`} pendingLabel="Processing…" disabled={pending}
              extra={view.customer ? (
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-accent" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save this test card for this customer</label>
              ) : undefined}
              onSubmit={async (v) => {
                const r = await Actions.Checkout.payWithCardAction({ token, card: v, save: view.customer ? save : false });
                if (r.ok) router.refresh();
                return r;
              }}
            />
          )}

          {(!view.cardAllowed || choice === "simulated") && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                act(() => Actions.Checkout.payAction({ token, ...(view.presetScenario ? {} : { scenario }), ...(DELAY_SCENARIOS.includes(scenario) ? { delaySeconds: delay } : {}) }));
              }}
            >
              {view.presetScenario ? (
                <p className="rounded-md border border-line bg-subtle p-3 text-sm">Simulated outcome: <strong>{scenarioLabel(view.presetScenario)}</strong> <span className="text-xs text-neutral-500">(set by the merchant)</span></p>
              ) : (
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm font-medium text-neutral-900">Choose the simulated outcome</legend>
                  {SCENARIO_OPTIONS.map((o) => (
                    <label key={o.value} className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent hover:bg-subtle ${scenario === o.value ? "border-accent bg-subtle" : "border-line"}`}>
                      <input type="radio" className="mt-1 accent-accent" name="scenario" value={o.value} checked={scenario === o.value} onChange={() => setScenario(o.value)} />
                      <span><span className="block font-medium">{o.label}</span><span className="text-xs text-neutral-500">{o.hint}</span></span>
                    </label>
                  ))}
                </fieldset>
              )}
              {DELAY_SCENARIOS.includes(scenario) && (
                <FieldLabel label="Delay before the outcome (seconds)"><Input type="number" min={1} max={3600} step={1} value={delay} onChange={(e) => setDelay(Math.round(Number(e.target.value)) || 1)} className="!w-28" /></FieldLabel>
              )}
              <FormError>{error}</FormError>
              <Button type="submit" disabled={pending} className="w-full py-2.5">{pending ? "Processing…" : `Pay ${view.amount} ${view.currency}`}</Button>
            </form>
          )}
        </div>
      )}
      {!view.canPay && <FormError className="text-center">{error}</FormError>}

      {view.status === "open" && (
        <div className="flex justify-center border-t border-line pt-4 text-sm text-neutral-500">
          <button type="button" disabled={pending} className="rounded underline hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50" onClick={() => { if (window.confirm("Cancel this checkout?")) act(() => Actions.Checkout.cancelCheckoutAction({ token })); }}>Cancel checkout</button>
        </div>
      )}
      </div>
    </div>
  );
}
