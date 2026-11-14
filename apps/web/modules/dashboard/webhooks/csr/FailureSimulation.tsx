"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Actions } from "@/actions/client";
import { Button, Card } from "@components/ui/form";

const MODES: { value: string; label: string; help: string }[] = [
  { value: "none", label: "None (normal delivery)", help: "" },
  { value: "http_500", label: "Simulate HTTP 500", help: "Attempts are recorded as 500 without contacting your endpoint, then retried." },
  { value: "timeout", label: "Simulate timeout", help: "Attempts are recorded as timeouts without contacting your endpoint, then retried." },
  { value: "invalid_signature", label: "Invalid signature", help: "Real requests, signed with a wrong key: your verification should reject them." },
  { value: "duplicate", label: "Duplicate delivery", help: "Each attempt sends the same request twice: your handler should process it once." },
  { value: "delay", label: "Delay", help: "New deliveries wait the given seconds before their first attempt." },
  { value: "out_of_order", label: "Out of order", help: "New deliveries get a random 0..N second delay, so they arrive out of order." },
];
const COUNTED = new Set(["http_500", "timeout", "invalid_signature", "duplicate"]);
const DELAYED = new Set(["delay", "out_of_order"]);

/** Per-endpoint failure simulation. Affects only this endpoint; every simulated attempt is labelled in the history. */
export function FailureSimulation({ id, mode, remaining, delaySeconds }: { id: string; mode: string; remaining: number | null; delaySeconds: number | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [sel, setSel] = useState(mode);
  const [error, setError] = useState<string>();
  return (
    <Card title="Failure simulation">
      <form className="space-y-3 text-sm" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const num = (k: string) => { const v = String(f.get(k) ?? "").trim(); return v === "" ? null : Number(v); };
        start(async () => {
          const r = await Actions.Webhooks.updateEndpointAction({
            id, failureMode: sel,
            failureModeRemaining: COUNTED.has(sel) ? num("remaining") : null,
            failureDelaySeconds: DELAYED.has(sel) ? num("delay") : null,
          });
          setError(r.ok ? undefined : r.fieldErrors ? Object.values(r.fieldErrors)[0] : r.error);
          router.refresh();
        });
      }}>
        <select value={sel} onChange={(e) => setSel(e.target.value)} className="w-full rounded-md border border-neutral-300 px-3 py-2">
          {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        {MODES.find((m) => m.value === sel)?.help && <p className="text-neutral-600">{MODES.find((m) => m.value === sel)!.help}</p>}
        {COUNTED.has(sel) && <label className="block"><span className="mb-1 block font-medium">Number of attempts to affect, then recover (empty = until turned off)</span>
          <input name="remaining" type="number" min={1} max={100} defaultValue={remaining ?? ""} className="w-32 rounded-md border border-neutral-300 px-3 py-2" /></label>}
        {DELAYED.has(sel) && <label className="block"><span className="mb-1 block font-medium">Seconds (1-300)</span>
          <input name="delay" type="number" min={1} max={300} required defaultValue={delaySeconds ?? 30} className="w-32 rounded-md border border-neutral-300 px-3 py-2" /></label>}
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        {error && <p role="alert" className="text-red-600">{error}</p>}
      </form>
    </Card>
  );
}
