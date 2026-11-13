"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Actions } from "@/actions/client";
import { CURRENCY_CHOICES, SCENARIO_OPTIONS } from "@/lib/scenarios";
import { Button, Card } from "@components/ui/form";

/** Creates a session through the same service as the API. The checkout URL holds the secret token, so it is shown once. */
export function CreateTestSession({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ sessionId: string; url: string }>();

  return (
    <Card title="Create a test checkout">
      {!canCreate && <p className="mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900">Verify your email address to create test checkouts.</p>}
      <form
        className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const scenario = String(f.get("scenario") ?? "");
          const reference = String(f.get("reference") ?? "").trim();
          start(async () => {
            const r = await Actions.Dashboard.createTestSessionAction({ amount: f.get("amount"), currency: f.get("currency"), ...(scenario ? { scenario } : {}), ...(reference ? { reference } : {}) });
            if (!r.ok) { setError(r.fieldErrors ? Object.values(r.fieldErrors)[0] : r.error); setCreated(undefined); return; }
            setError(undefined);
            setCreated(r.data);
            router.refresh();
          });
        }}
      >
        <label className="block"><span className="mb-1 block font-medium">Amount</span>
          <input name="amount" required inputMode="decimal" defaultValue="10.00" className="w-full rounded-md border border-neutral-300 px-3 py-2" /></label>
        <label className="block"><span className="mb-1 block font-medium">Currency</span>
          <select name="currency" defaultValue="USD" className="w-full rounded-md border border-neutral-300 px-3 py-2">{CURRENCY_CHOICES.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="block"><span className="mb-1 block font-medium">Scenario</span>
          <select name="scenario" defaultValue="" className="w-full rounded-md border border-neutral-300 px-3 py-2">
            <option value="">Customer chooses on the page</option>
            {SCENARIO_OPTIONS.map((o) => <option key={o.value} value={o.value}>Fixed: {o.label}</option>)}
          </select></label>
        <label className="block"><span className="mb-1 block font-medium">Reference (optional)</span>
          <input name="reference" maxLength={255} className="w-full rounded-md border border-neutral-300 px-3 py-2" /></label>
        <div className="sm:col-span-2 lg:col-span-4"><Button type="submit" disabled={pending || !canCreate}>{pending ? "Creating…" : "Create checkout"}</Button></div>
      </form>
      {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
      {created && (
        <div className="mt-3 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-semibold">Checkout link created. It contains a secret and will not be shown again.</p>
          <code className="block break-all rounded bg-white p-2">{created.url}</code>
          <div className="flex gap-2">
            <a href={created.url} target="_blank" rel="noopener" className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700">Open checkout</a>
            <Button variant="ghost" onClick={() => setCreated(undefined)}>Dismiss</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
