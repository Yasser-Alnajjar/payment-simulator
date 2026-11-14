import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { webhookDeliveryDetail } from "@/server/services/dashboard";
import { fmtTime } from "@/lib/scenarios";
import { Badge, Card } from "@components/ui/form";
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
          <p className="text-sm"><Link href={`/webhooks/${d.endpoint_id}`} className="underline">← Endpoint</Link></p>
          <div className="flex flex-wrap items-center gap-3"><h1 className="text-xl font-semibold">Delivery</h1><Badge status={d.status} />{d.manual_retry_pending && <span className="text-xs text-neutral-500">manual retry queued</span>}</div>
          <Card>
            <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-neutral-500">Delivery ID</dt><dd className="font-mono text-xs">{d.id}</dd>
              <dt className="text-neutral-500">Event</dt><dd className="font-mono text-xs">{d.event_id} · {data.eventType}</dd>
              <dt className="text-neutral-500">Attempts</dt><dd>{d.attempt_count}</dd>
              <dt className="text-neutral-500">Next attempt</dt><dd>{fmtTime(d.next_attempt_at)}</dd>
              <dt className="text-neutral-500">Completed</dt><dd>{fmtTime(d.completed_at)}</dd>
            </dl>
            <div className="mt-4"><RetryDelivery id={d.id} disabled={!canRetry} /></div>
          </Card>
          <Card title="Attempts">
            {attempts.length === 0 ? <p className="text-sm text-neutral-500">Not attempted yet. The scheduler runs about once a minute.</p> : (
              <ol className="space-y-3 text-sm">
                {attempts.map((a) => (
                  <li key={a.attempt} className="rounded-md border border-neutral-200 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">#{a.attempt}</span><Badge status={a.outcome} />
                      <span className="text-xs text-neutral-500">{a.trigger} · {fmtTime(a.started)}{a.duration_ms !== null ? ` · ${a.duration_ms} ms` : ""}</span>
                      {a.simulated && <span className="rounded-full bg-purple-50 px-2 py-0.5 text-xs text-purple-800">simulated</span>}
                      {a.stale && <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700">late result (lease lost)</span>}
                    </div>
                    <p className="mt-1 text-xs">Result: {a.status_code !== null ? `HTTP ${a.status_code}` : ""} {a.error_code ?? ""}{a.signature ? ` · signature ${a.signature}` : ""}{a.next_retry_at ? ` · next retry ${fmtTime(a.next_retry_at)}` : ""}</p>
                    {a.response_excerpt && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-50 p-2 text-xs">{a.response_excerpt}</pre>}
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <Card title="Payload (exact bytes are signed)">
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-50 p-2 text-xs">{pretty}</pre>
          </Card>
        </>
      );
    }}
  </DashboardFrame>
);
