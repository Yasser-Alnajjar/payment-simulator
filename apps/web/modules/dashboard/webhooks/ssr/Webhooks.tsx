import Link from "next/link";
import { WEBHOOK_MAX_ENDPOINTS_PER_USER, WEBHOOK_SUBSCRIBABLE_EVENTS } from "@sandbox/core";
import { db } from "@/server/db";
import { webhooksPage } from "@/server/services/dashboard";
import { fmtTime } from "@/lib/scenarios";
import { Badge, Card } from "@components/ui/form";
import { DashboardFrame } from "../../shell";
import { CreateEndpoint } from "../csr/CreateEndpoint";
import { SchedulerNotice } from "./SchedulerNotice";

export const Webhooks = async ({ after }: { after?: string }) => (
  <DashboardFrame>
    {async (user) => {
      let data;
      try { data = await webhooksPage(db(), user.id, new Date(), { after }); } catch { data = await webhooksPage(db(), user.id, new Date(), {}); }
      const endpoints = data.endpoints ?? [];
      const deliveries = data.deliveries ?? [];
      return (
        <>
          <div className="flex flex-wrap items-center gap-3"><h1 className="text-xl font-semibold">Webhooks</h1></div>
          <SchedulerNotice s={data.scheduler} />
          <Card title="Endpoints">
            {endpoints.length === 0 ? <p className="text-sm text-neutral-500">No endpoints yet. Add one below to receive signed events.</p> : (
              <ul className="divide-y divide-neutral-100 text-sm">
                {endpoints.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-3 py-2">
                    <Link href={`/webhooks/${e.id}`} className="break-all font-medium underline">{e.url}</Link>
                    <Badge status={e.status} />
                    {e.failure_simulation.mode !== "none" && <span className="rounded-full bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-800">simulating {e.failure_simulation.mode}</span>}
                    <span className="text-xs text-neutral-500">{e.enabled_events.includes("*") ? "all events" : `${e.enabled_events.length} event type(s)`}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <CreateEndpoint eventTypes={[...WEBHOOK_SUBSCRIBABLE_EVENTS]} canCreate={user.emailVerified} atLimit={endpoints.length >= WEBHOOK_MAX_ENDPOINTS_PER_USER} />
          <Card title="Recent deliveries">
            {deliveries.length === 0 ? <p className="text-sm text-neutral-500">No deliveries yet.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <thead className="text-neutral-500"><tr><th className="py-1 pr-3 font-medium">Delivery</th><th className="pr-3 font-medium">Status</th><th className="pr-3 font-medium">Attempts</th><th className="pr-3 font-medium">Last result</th><th className="font-medium">Next attempt</th></tr></thead>
                  <tbody className="divide-y divide-neutral-100">
                    {deliveries.map((d) => (
                      <tr key={d.id}>
                        <td className="py-2 pr-3"><Link href={`/webhooks/deliveries/${d.id}`} className="font-mono text-xs underline">{d.id.slice(0, 16)}…</Link><div className="text-xs text-neutral-500">{fmtTime(d.created)}</div></td>
                        <td className="pr-3"><Badge status={d.status} /></td>
                        <td className="pr-3">{d.attempt_count}</td>
                        <td className="pr-3 text-xs">{d.last_status_code ?? d.last_error_code ?? "–"}</td>
                        <td className="text-xs">{fmtTime(d.next_attempt_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.nextDeliveries && <p className="mt-3 text-sm"><Link className="underline" href={`/webhooks?after=${encodeURIComponent(data.nextDeliveries)}`}>Older deliveries →</Link></p>}
          </Card>
          <p className="text-xs text-neutral-500">Each request carries <code>Sandbox-Signature: t=…,v1=…</code> (HMAC-SHA256 of <code>timestamp.raw_body</code> with the endpoint secret). Deliveries are at least once: deduplicate by the event <code>id</code>.</p>
        </>
      );
    }}
  </DashboardFrame>
);
