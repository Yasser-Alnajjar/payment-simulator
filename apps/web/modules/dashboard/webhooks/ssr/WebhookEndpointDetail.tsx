import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { webhookEndpointDetail } from "@/server/services/dashboard";
import { fmtTime } from "@/lib/scenarios";
import { Badge, Card, DetailList, EmptyState, Notice, PageHeader, Row, RowList } from "@components/ui/form";
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
          <PageHeader title={e.url} badge={<Badge status={e.status} />} description="Webhook endpoint" />
          {e.failure_simulation.mode !== "none" && (
            <div role="status" className="rounded-md border border-purple-300 bg-purple-50 px-3.5 py-3 text-sm text-purple-900">Failure simulation is active: <b>{e.failure_simulation.mode}</b>{e.failure_simulation.remaining !== null ? ` (${e.failure_simulation.remaining} attempt(s) left)` : ""}. Affected attempts are labelled “simulated”.</div>
          )}
          {data.consecutiveFailures >= 3 && <Notice tone="error">The last {data.consecutiveFailures} deliveries to this endpoint failed.</Notice>}
          <Card title="Endpoint">
            <DetailList rows={[
              ["ID", <span key="id" className="font-mono text-xs">{e.id}</span>],
              ["Description", e.description ?? "–"],
              ["Events", <span key="ev" className="font-mono text-xs">{e.enabled_events.join(", ")}</span>],
              ["Max attempts", String(e.max_attempts)],
              ["Previous secret valid until", fmtTime(e.previous_secret_expires_at)],
              ["Created", fmtTime(e.created)],
            ]} />
            <div className="mt-5 border-t border-line pt-4"><EndpointControls id={e.id} status={e.status} /></div>
          </Card>
          <FailureSimulation id={e.id} mode={e.failure_simulation.mode} remaining={e.failure_simulation.remaining} delaySeconds={e.failure_simulation.delay_seconds} />
          <Card flush title="Recent deliveries">
            {deliveries.length === 0 ? <EmptyState>No deliveries yet. Send a test event above.</EmptyState> : (
              <RowList>
                {deliveries.map((d) => (
                  <Row key={d.id}>
                    <Link href={`/webhooks/deliveries/${d.id}`} className="font-mono text-xs font-medium hover:underline">{d.id.slice(0, 16)}…</Link>
                    <Badge status={d.status} /><span className="text-xs text-neutral-500">{d.attempt_count} attempt(s) · {fmtTime(d.created)}</span>
                  </Row>
                ))}
              </RowList>
            )}
          </Card>
        </>
      );
    }}
  </DashboardFrame>
);
