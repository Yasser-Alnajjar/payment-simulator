"use client";

import { useState, useTransition } from "react";
import { Actions } from "@/actions/client";
import { Button, ButtonLink, Card, FieldLabel, FormError, Input, Notice, SecretBlock } from "@components/ui/form";

/** Creates a hosted setup checkout (mode = setup). The link holds a secret token, so it is shown once. */
export function CreateSetupLink({ canCreate }: { canCreate: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ id: string; url: string }>();
  return (
    <Card title="Create a hosted setup link">
      <p className="mb-3 text-sm text-neutral-500">A customer opens the link and adds a test card. Nothing is charged and no payment is created.</p>
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
        <FieldLabel label="Customer reference" className="min-w-[14rem] flex-1"><Input name="customer" required maxLength={128} /></FieldLabel>
        <Button type="submit" disabled={pending || !canCreate}>{pending ? "Creating…" : "Create setup link"}</Button>
      </form>
      <FormError className="mt-3">{error}</FormError>
      {created && (
        <Notice tone="warning" title="Setup link created. It contains a secret and will not be shown again." className="mt-3">
          <div className="mt-2 space-y-3">
            <SecretBlock value={created.url} />
            <ButtonLink href={created.url} external>Open setup page</ButtonLink>
          </div>
        </Notice>
      )}
    </Card>
  );
}
