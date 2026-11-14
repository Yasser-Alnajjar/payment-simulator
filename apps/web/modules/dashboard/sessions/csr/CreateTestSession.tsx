"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Actions } from "@/actions/client";
import { CURRENCY_CHOICES, SCENARIO_OPTIONS } from "@/lib/scenarios";
import { Button, ButtonLink, Card, FieldLabel, FormError, Input, Notice, SecretBlock, Select } from "@components/ui/form";

/** Creates a session through the same service as the API. The checkout URL holds the secret token, so it is shown once. */
export function CreateTestSession({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ sessionId: string; url: string }>();

  return (
    <Card title="Create a test checkout">
      {!canCreate && <Notice tone="warning" className="mb-3">Verify your email address to create test checkouts.</Notice>}
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
        <FieldLabel label="Amount"><Input name="amount" required inputMode="decimal" defaultValue="10.00" /></FieldLabel>
        <FieldLabel label="Currency"><Select name="currency" defaultValue="USD">{CURRENCY_CHOICES.map((c) => <option key={c}>{c}</option>)}</Select></FieldLabel>
        <FieldLabel label="Scenario">
          <Select name="scenario" defaultValue="">
            <option value="">Customer chooses on the page</option>
            {SCENARIO_OPTIONS.map((o) => <option key={o.value} value={o.value}>Fixed: {o.label}</option>)}
          </Select></FieldLabel>
        <FieldLabel label="Reference (optional)"><Input name="reference" maxLength={255} /></FieldLabel>
        <div className="sm:col-span-2 lg:col-span-4"><Button type="submit" disabled={pending || !canCreate}>{pending ? "Creating…" : "Create checkout"}</Button></div>
      </form>
      <FormError className="mt-3">{error}</FormError>
      {created && (
        <Notice tone="warning" title="Checkout link created. It contains a secret and will not be shown again." className="mt-3 space-y-2">
          <div className="mt-2 space-y-3">
            <SecretBlock value={created.url} />
            <div className="flex gap-2">
              <ButtonLink href={created.url} external>Open checkout</ButtonLink>
              <Button variant="ghost" onClick={() => setCreated(undefined)}>Dismiss</Button>
            </div>
          </div>
        </Notice>
      )}
    </Card>
  );
}
