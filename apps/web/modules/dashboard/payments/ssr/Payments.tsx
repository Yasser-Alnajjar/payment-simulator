import Link from "next/link";
import { db } from "@/server/db";
import { paymentsPage } from "@/server/services/dashboard";
import { fmtTime, scenarioLabel } from "@/lib/scenarios";
import { Badge, Card, EmptyState, FilterTabs, MoreLink, PageHeader, TBody, THead, Table, Td, Th } from "@components/ui/form";
import { DashboardFrame } from "../../shell";

const FILTERS = ["all", "pending", "succeeded", "failed", "cancelled"] as const;

export const Payments = async ({ after, status }: { after?: string; status?: string }) => (
  <DashboardFrame>
    {async (user) => {
      const st = FILTERS.includes(status as never) && status !== "all" ? status : undefined;
      let page;
      try { page = await paymentsPage(db(), user.id, new Date(), { after, status: st }); } catch { page = await paymentsPage(db(), user.id, new Date(), { status: st }); }
      return (
        <>
          <PageHeader title="Payments" description="Every payment attempt made against your checkout sessions." />
          <Card flush title="All payments" action={<FilterTabs label="Filter by status" current={st ?? "all"} items={FILTERS.map((f) => ({ key: f, href: f === "all" ? "/payments" : `/payments?status=${f}` }))} />}>
            {page.items.length === 0 ? <EmptyState title="No payments">{st ? "No payments match this filter." : "Payments appear here once a customer pays a checkout."}</EmptyState> : (
              <Table>
                <THead><Th>Payment</Th><Th>Amount</Th><Th>Scenario</Th><Th>Status</Th><Th>Created</Th></THead>
                <TBody>
                  {page.items.map((p) => (
                    <tr key={p.id}>
                      <Td><Link href={`/sessions/${p.checkout_session_id}`} className="font-mono text-xs font-medium hover:underline">{p.id.slice(0, 12)}…</Link>{p.failure_code && <div className="text-xs text-neutral-500">{p.failure_code}</div>}</Td>
                      <Td className="tabular whitespace-nowrap font-medium">{p.amount} {p.currency}</Td>
                      <Td className="text-neutral-600">{scenarioLabel(p.scenario)}</Td>
                      <Td><Badge status={p.status} /></Td>
                      <Td className="whitespace-nowrap text-neutral-500">{fmtTime(p.created)}</Td>
                    </tr>
                  ))}
                </TBody>
              </Table>
            )}
            {page.next && <MoreLink href={`/payments?after=${page.next}${st ? `&status=${st}` : ""}`}>Older payments →</MoreLink>}
          </Card>
        </>
      );
    }}
  </DashboardFrame>
);
