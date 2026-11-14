"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Actions } from "@/actions/client";
import type { CreatedEndpoint } from "@/lib/types/webhook";
import { Button, Card, FieldLabel, FormError, Input } from "@components/ui/form";
import { SecretOnce } from "./SecretOnce";

/** Creates an endpoint. The signing secret is returned once and shown once. */
export function CreateEndpoint({ eventTypes, canCreate, atLimit }: { eventTypes: string[]; canCreate: boolean; atLimit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [all, setAll] = useState(true);
  const [created, setCreated] = useState<CreatedEndpoint>();
  return (
    <Card title="Add a webhook endpoint">
      <form
        className="space-y-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const events = all ? ["*"] : f.getAll("events").map(String);
          start(async () => {
            const r = await Actions.Webhooks.createEndpointAction({ url: String(f.get("url") ?? "").trim(), description: String(f.get("description") ?? ""), events });
            if (!r.ok) { setError(r.fieldErrors ? Object.values(r.fieldErrors)[0] : r.error); return; }
            setError(undefined);
            setCreated(r.data);
            router.refresh();
          });
        }}
      >
        <FieldLabel label="Endpoint URL (https)"><Input name="url" type="url" required maxLength={2048} placeholder="https://example.com/webhooks/sandbox" /></FieldLabel>
        <FieldLabel label="Description (optional)"><Input name="description" maxLength={500} /></FieldLabel>
        <fieldset className="space-y-1">
          <legend className="mb-1 font-medium">Events</legend>
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-accent" checked={all} onChange={(e) => setAll(e.target.checked)} /> All events (including types added later)</label>
          {!all && (
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {eventTypes.map((t) => (<label key={t} className="flex items-center gap-2 font-mono text-xs"><input type="checkbox" className="accent-accent" name="events" value={t} /> {t}</label>))}
            </div>
          )}
        </fieldset>
        <Button type="submit" disabled={pending || !canCreate || atLimit}>{pending ? "Adding…" : "Add endpoint"}</Button>
        {atLimit && <p className="text-neutral-500">You have reached the endpoint limit. Delete one to add another.</p>}
      </form>
      <FormError className="mt-3">{error}</FormError>
      {created && <SecretOnce secret={created.secret} title="Endpoint added. Copy its signing secret now: it will not be shown again." />}
    </Card>
  );
}
