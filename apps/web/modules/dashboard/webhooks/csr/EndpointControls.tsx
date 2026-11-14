"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Actions } from "@/actions/client";
import type { ActionResult } from "@/lib/types/common";
import { Button } from "@components/ui/form";
import { SecretOnce } from "./SecretOnce";

/** Enable/disable, send a test event, rotate the secret, delete. The server re-validates ownership and state. */
export function EndpointControls({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [secret, setSecret] = useState<string>();
  const run = (fn: () => Promise<ActionResult<unknown>>, done?: string, after?: string) => start(async () => {
    const r = await fn();
    setError(r.ok ? undefined : r.error);
    setInfo(r.ok ? done : undefined);
    if (r.ok && after) router.push(after); else router.refresh();
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" disabled={pending || status !== "enabled"} onClick={() => run(() => Actions.Webhooks.sendTestAction({ id }), "Test event queued. It is sent by the next scheduler run (about a minute).")}>Send test event</Button>
        {status === "enabled"
          ? <Button variant="ghost" disabled={pending} onClick={() => run(() => Actions.Webhooks.updateEndpointAction({ id, status: "disabled" }), "Endpoint disabled. Pending deliveries wait until it is enabled again.")}>Disable</Button>
          : <Button variant="ghost" disabled={pending} onClick={() => run(() => Actions.Webhooks.updateEndpointAction({ id, status: "enabled" }), "Endpoint enabled.")}>Enable</Button>}
        <Button variant="ghost" disabled={pending} onClick={() => {
          if (!window.confirm("Rotate the signing secret? The old secret keeps working for 24 hours.")) return;
          start(async () => { const r = await Actions.Webhooks.rotateSecretAction({ id }); setError(r.ok ? undefined : r.error); if (r.ok) setSecret(r.data.secret); router.refresh(); });
        }}>Rotate secret</Button>
        <Button variant="danger" disabled={pending} onClick={() => { if (window.confirm("Delete this endpoint? Pending deliveries are cancelled; history is kept.")) run(() => Actions.Webhooks.deleteEndpointAction({ id }), undefined, "/webhooks"); }}>Delete</Button>
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {info && <p className="text-sm text-neutral-600">{info}</p>}
      {secret && <SecretOnce secret={secret} title="New signing secret. Copy it now: it will not be shown again. The previous secret also signs for 24 hours." />}
    </div>
  );
}
