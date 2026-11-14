import Link from "next/link";
import { WEBHOOK_MAX_ENDPOINTS_PER_USER, WEBHOOK_SUBSCRIBABLE_EVENTS } from "@sandbox/core";
import { db } from "@/server/db";
import { webhooksPage } from "@/server/services/dashboard";
import { fmtTime } from "@/lib/scenarios";
import { Badge, Card, EmptyState, MoreLink, PageHeader, Row, RowList, TBody, THead, Table, Tag, Td, Th } from "@components/ui/form";
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
          <PageHeader title="Webhooks" description="Signed events delivered to your endpoints. Deliveries are at least once." />
          <SchedulerNotice s={data.scheduler} />
          <Card flush title="Endpoints">
            {endpoints.length === 0 ? <EmptyState title="No endpoints yet">Add one below to receive signed events.</EmptyState> : (
              <RowList>
                {endpoints.map((e) => (
                  <Row key={e.id}>
                    <Link href={`/webhooks/${e.id}`} className="min-w-0 flex-1 break-all font-medium hover:underline">{e.url}</Link>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge status={e.status} />
                      {e.failure_simulation.mode !== "none" && <Tag tone="purple">simulating {e.failure_simulation.mode}</Tag>}
                      <span className="text-xs text-neutral-500">{e.enabled_events.includes("*") ? "all events" : `${e.enabled_events.length} event type(s)`}</span>
                    </div>
                  </Row>
                ))}
              </RowList>
            )}
          </Card>
          <CreateEndpoint eventTypes={[...WEBHOOK_SUBSCRIBABLE_EVENTS]} canCreate={user.emailVerified} atLimit={endpoints.length >= WEBHOOK_MAX_ENDPOINTS_PER_USER} />
          <Card flush title="Recent deliveries">
            {deliveries.length === 0 ? <EmptyState>No deliveries yet.</EmptyState> : (
              <Table minWidth="40rem">
                <THead><Th>Delivery</Th><Th>Status</Th><Th>Attempts</Th><Th>Last result</Th><Th>Next attempt</Th></THead>
                <TBody>
                  {deliveries.map((d) => (
                    <tr key={d.id}>
                      <Td><Link href={`/webhooks/deliveries/${d.id}`} className="font-mono text-xs font-medium hover:underline">{d.id.slice(0, 16)}…</Link><div className="text-xs text-neutral-500">{fmtTime(d.created)}</div></Td>
                      <Td><Badge status={d.status} /></Td>
                      <Td className="tabular">{d.attempt_count}</Td>
                      <Td className="font-mono text-xs">{d.last_status_code ?? d.last_error_code ?? "–"}</Td>
                      <Td className="whitespace-nowrap text-xs text-neutral-500">{fmtTime(d.next_attempt_at)}</Td>
                    </tr>
                  ))}
                </TBody>
              </Table>
            )}
            {data.nextDeliveries && <MoreLink href={`/webhooks?after=${encodeURIComponent(data.nextDeliveries)}`}>Older deliveries →</MoreLink>}
          </Card>
          <p className="text-xs text-neutral-500">Each request carries <code>Sandbox-Signature: t=…,v1=…</code> (HMAC-SHA256 of <code>timestamp.raw_body</code> with the endpoint secret). Deliveries are at least once: deduplicate by the event <code>id</code>.</p>
        </>
      );
    }}
  </DashboardFrame>
);
