import { notFound } from "next/navigation";
import { ApiError } from "@/server/api/errors";
import { db } from "@/server/db";
import { sessionDetail } from "@/server/services/dashboard";
import { fmtTime, scenarioLabel } from "@/lib/scenarios";
import { Badge, Card, DetailList, EmptyState, PageHeader, Row, RowList } from "@components/ui/form";
import { DashboardFrame } from "../../shell";
import { CancelSession, ResolvePayment } from "../csr/Controls";

export const SessionDetail = async ({ id }: { id: string }) => (
  <DashboardFrame>
    {async (user) => {
      let d;
      try { d = await sessionDetail(db(), user.id, id, new Date()); } catch (e) { if (e instanceof ApiError && e.status === 404) notFound(); throw e; }
      const s = d.session;
      const rows: [string, string][] = [
        ["Amount", `${s.amount} ${s.currency}`], ["Scenario", scenarioLabel(s.scenario)], ["Reference", s.external_reference ?? "–"],
        ["Created", fmtTime(s.created)], ["Expires", fmtTime(s.expires_at)],
      ];
      return (
        <>
          <PageHeader title={s.id} mono badge={<Badge status={s.status} />} description="Checkout session" action={s.status === "open" ? <CancelSession sessionId={s.id} /> : undefined} />
          <Card title="Details">
            <DetailList rows={rows} />
            {Object.keys(s.metadata as object).length > 0 && <pre className="mt-4 overflow-x-auto rounded-md border border-line bg-subtle p-3 font-mono text-xs">{JSON.stringify(s.metadata, null, 2)}</pre>}
            <p className="mt-4 text-xs text-neutral-500">The checkout link is shown only when a session is created. Its token is stored as a hash and cannot be recovered.</p>
          </Card>
          <Card flush title="Payments">
            {d.payments.length === 0 ? <EmptyState>No payment attempts yet.</EmptyState> : (
              <ul className="divide-y divide-line text-sm">
                {d.payments.map((p) => (
                  <li key={p.id} className="space-y-2 px-4 py-3.5">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5"><span className="font-mono text-xs font-medium">{p.id}</span><Badge status={p.status} /><span className="tabular font-medium">{p.amount} {p.currency}</span><span className="text-neutral-500">{scenarioLabel(p.scenario)}</span>{p.failure_code && <span className="text-neutral-500">code: {p.failure_code}</span>}</div>
                    <div className="text-xs text-neutral-500">Created {fmtTime(p.created)}{p.status === "pending" && p.resolve_at ? ` · resolves ${fmtTime(p.resolve_at)}` : ""}</div>
                    {p.status === "pending" && <ResolvePayment paymentId={p.id} />}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card flush title="Events">
            {d.events.length === 0 ? <EmptyState>No events.</EmptyState> : (
              <RowList>{d.events.map((e) => (<Row key={e.id} className="justify-between"><code className="font-mono text-xs">{e.type}</code><span className="text-xs text-neutral-500">{fmtTime(e.created)}</span></Row>))}</RowList>
            )}
          </Card>
        </>
      );
    }}
  </DashboardFrame>
);
