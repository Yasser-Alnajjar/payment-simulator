"use client";

import { useState, useTransition } from "react";
import { Actions } from "@/actions/client";
import { Button, Card } from "@components/ui/form";

/** Creates a hosted setup checkout (mode = setup). The link holds a secret token, so it is shown once. */
export function CreateSetupLink({ canCreate }: { canCreate: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ id: string; url: string }>();
  return (
    <Card title="Create a hosted setup link">
      <p className="mb-3 text-sm text-neutral-600">A customer opens the link and adds a test card. Nothing is charged and no payment is created.</p>
      <form
        className="flex flex-wrap items-end gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          start(async () => {
            const r = await Actions.PaymentMethods.createSetupLinkAction({ customer: String(f.get("customer") ?? "").trim() });
            if (!r.ok) { setError(r.fieldErrors ? Object.values(r.fieldErrors)[0] : r.error); setCreated(undefined); return; }
            setError(undefined);
            setCreated(r.data);
          });
        }}
      >
        <label className="block min-w-[14rem] flex-1"><span className="mb-1 block font-medium">Customer reference</span>
          <input name="customer" required maxLength={128} className="w-full rounded-md border border-neutral-300 px-3 py-2 text-base sm:text-sm" /></label>
        <Button type="submit" disabled={pending || !canCreate}>{pending ? "Creating…" : "Create setup link"}</Button>
      </form>
      {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
      {created && (
        <div className="mt-3 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-semibold">Setup link created. It contains a secret and will not be shown again.</p>
          <code className="block break-all rounded bg-white p-2">{created.url}</code>
          <a href={created.url} target="_blank" rel="noopener" className="inline-block rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700">Open setup page</a>
        </div>
      )}
    </Card>
  );
}
