import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { webhookEndpointDetail } from "@/server/services/dashboard";
import { fmtTime } from "@/lib/scenarios";
import { Badge, Card } from "@components/ui/form";
import { DashboardFrame } from "../../shell";
import { EndpointControls } from "../csr/EndpointControls";
import { FailureSimulation } from "../csr/FailureSimulation";

export const WebhookEndpointDetail = async ({ id }: { id: string }) => (
  <DashboardFrame>
    {async (user) => {
      const data = await webhookEndpointDetail(db(), user.id, id).catch(() => null);
      if (!data) notFound();
      const e = data.endpoint;
      const deliveries = data.deliveries ?? [];
      return (
        <>
          <p className="text-sm"><Link href="/webhooks" className="underline">← Webhooks</Link></p>
          <div className="flex flex-wrap items-center gap-3"><h1 className="break-all text-xl font-semibold">{e.url}</h1><Badge status={e.status} /></div>
          {e.failure_simulation.mode !== "none" && (
            <div role="status" className="rounded-lg border border-purple-300 bg-purple-50 p-3 text-sm text-purple-900">Failure simulation is active: <b>{e.failure_simulation.mode}</b>{e.failure_simulation.remaining !== null ? ` (${e.failure_simulation.remaining} attempt(s) left)` : ""}. Affected attempts are labelled “simulated”.</div>
          )}
          {data.consecutiveFailures >= 3 && <div role="status" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">The last {data.consecutiveFailures} deliveries to this endpoint failed.</div>}
          <Card title="Endpoint">
            <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-neutral-500">ID</dt><dd className="font-mono text-xs">{e.id}</dd>
              <dt className="text-neutral-500">Description</dt><dd>{e.description ?? "–"}</dd>
              <dt className="text-neutral-500">Events</dt><dd className="font-mono text-xs">{e.enabled_events.join(", ")}</dd>
              <dt className="text-neutral-500">Max attempts</dt><dd>{e.max_attempts}</dd>
              <dt className="text-neutral-500">Previous secret valid until</dt><dd>{fmtTime(e.previous_secret_expires_at)}</dd>
              <dt className="text-neutral-500">Created</dt><dd>{fmtTime(e.created)}</dd>
            </dl>
            <div className="mt-4"><EndpointControls id={e.id} status={e.status} /></div>
          </Card>
          <FailureSimulation id={e.id} mode={e.failure_simulation.mode} remaining={e.failure_simulation.remaining} delaySeconds={e.failure_simulation.delay_seconds} />
          <Card title="Recent deliveries">
            {deliveries.length === 0 ? <p className="text-sm text-neutral-500">No deliveries yet. Send a test event above.</p> : (
              <ul className="divide-y divide-neutral-100 text-sm">
                {deliveries.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-3 py-2">
                    <Link href={`/webhooks/deliveries/${d.id}`} className="font-mono text-xs underline">{d.id.slice(0, 16)}…</Link>
                    <Badge status={d.status} /><span className="text-xs text-neutral-500">{d.attempt_count} attempt(s) · {fmtTime(d.created)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      );
    }}
  </DashboardFrame>
);
