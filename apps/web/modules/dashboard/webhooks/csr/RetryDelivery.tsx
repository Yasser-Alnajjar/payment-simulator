"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Actions } from "@/actions/client";
import { Button } from "@components/ui/form";

/** Queues a manual retry for the next scheduler run. The server refuses while an attempt is in flight. */
export function RetryDelivery({ id, disabled }: { id: string; disabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" disabled={pending || disabled} onClick={() => start(async () => {
        const r = await Actions.Webhooks.retryDeliveryAction({ id });
        setMsg(r.ok ? { ok: true, text: "Retry queued for the next scheduler run (about a minute)." } : { ok: false, text: r.error });
        router.refresh();
      })}>Retry now</Button>
      {msg && <span role={msg.ok ? undefined : "alert"} className={`text-sm ${msg.ok ? "text-neutral-600" : "text-red-600"}`}>{msg.text}</span>}
    </div>
  );
}
