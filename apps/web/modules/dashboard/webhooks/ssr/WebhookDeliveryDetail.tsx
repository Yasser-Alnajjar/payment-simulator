import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { webhookDeliveryDetail } from "@/server/services/dashboard";
import { fmtTime } from "@/lib/scenarios";
import { Badge, Card, DetailList, EmptyState, PageHeader, Tag } from "@components/ui/form";
import { DashboardFrame } from "../../shell";
import { RetryDelivery } from "../csr/RetryDelivery";

export const WebhookDeliveryDetail = async ({ id }: { id: string }) => (
  <DashboardFrame>
    {async (user) => {
      const data = await webhookDeliveryDetail(db(), user.id, id).catch(() => null);
      if (!data) notFound();
      const d = data.delivery;
      const attempts = d.attempts ?? [];
      let pretty = data.payload;
      try { pretty = JSON.stringify(JSON.parse(data.payload), null, 2); } catch { /* show as stored */ }
      const canRetry = ["failed", "succeeded", "retrying"].includes(d.status) && !d.manual_retry_pending;
      return (
        <>
          <PageHeader title="Delivery" description="Webhook delivery attempts and payload" back={{ href: `/webhooks/${d.endpoint_id}`, label: "Endpoint" }} badge={<><Badge status={d.status} />{d.manual_retry_pending && <span className="text-xs text-neutral-500">manual retry queued</span>}</>} />
          <Card>
            <DetailList rows={[
              ["Delivery ID", <span key="id" className="font-mono text-xs">{d.id}</span>],
              ["Event", <span key="ev" className="font-mono text-xs">{d.event_id} · {data.eventType}</span>],
              ["Attempts", String(d.attempt_count)],
              ["Next attempt", fmtTime(d.next_attempt_at)],
              ["Completed", fmtTime(d.completed_at)],
            ]} />
            <div className="mt-5 border-t border-line pt-4"><RetryDelivery id={d.id} disabled={!canRetry} /></div>
          </Card>
          <Card title="Attempts">
            {attempts.length === 0 ? <EmptyState>Not attempted yet. The scheduler runs about once a minute.</EmptyState> : (
              <ol className="space-y-3 text-sm">
                {attempts.map((a) => (
                  <li key={a.attempt} className="rounded-md border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">#{a.attempt}</span><Badge status={a.outcome} />
                      <span className="text-xs text-neutral-500">{a.trigger} · {fmtTime(a.started)}{a.duration_ms !== null ? ` · ${a.duration_ms} ms` : ""}</span>
                      {a.simulated && <Tag tone="purple">simulated</Tag>}
                      {a.stale && <Tag>late result (lease lost)</Tag>}
                    </div>
                    <p className="mt-1 text-xs">Result: {a.status_code !== null ? `HTTP ${a.status_code}` : ""} {a.error_code ?? ""}{a.signature ? ` · signature ${a.signature}` : ""}{a.next_retry_at ? ` · next retry ${fmtTime(a.next_retry_at)}` : ""}</p>
                    {a.response_excerpt && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-subtle p-2 font-mono text-xs">{a.response_excerpt}</pre>}
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <Card title="Payload (exact bytes are signed)">
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-subtle p-3 font-mono text-xs">{pretty}</pre>
          </Card>
        </>
      );
    }}
  </DashboardFrame>
);
