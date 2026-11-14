import Link from "next/link";
import { db } from "@/server/db";
import { sessionsPage } from "@/server/services/dashboard";
import { fmtTime, scenarioLabel } from "@/lib/scenarios";
import { Badge, Card, EmptyState, FilterTabs, MoreLink, PageHeader, TBody, THead, Table, Td, Th } from "@components/ui/form";
import { DashboardFrame } from "../../shell";
import { CreateTestSession } from "../csr/CreateTestSession";

const FILTERS = ["all", "open", "completed", "expired", "cancelled"] as const;

export const Sessions = async ({ after, status }: { after?: string; status?: string }) => (
  <DashboardFrame>
    {async (user) => {
      const st = FILTERS.includes(status as never) && status !== "all" ? status : undefined;
      let page;
      try { page = await sessionsPage(db(), user.id, new Date(), { after, status: st }); } catch { page = await sessionsPage(db(), user.id, new Date(), { status: st }); } // stale cursor: start over
      return (
        <>
          <PageHeader title="Checkout sessions" description="Hosted checkouts your customers pay through. Each simulates one payment outcome." />
          <CreateTestSession canCreate={user.emailVerified} />
          <Card flush title="All sessions" action={<FilterTabs label="Filter by status" current={st ?? "all"} items={FILTERS.map((f) => ({ key: f, href: f === "all" ? "/sessions" : `/sessions?status=${f}` }))} />}>
            {page.items.length === 0 ? <EmptyState title="No checkout sessions">{st ? "No sessions match this filter." : "Create a test checkout above, or create one through the API."}</EmptyState> : (
              <Table>
                <THead><Th>Session</Th><Th>Amount</Th><Th>Scenario</Th><Th>Status</Th><Th>Created</Th></THead>
                <TBody>
                  {page.items.map((s) => (
                    <tr key={s.id}>
                      <Td><Link href={`/sessions/${s.id}`} className="font-mono text-xs font-medium hover:underline">{s.id.slice(0, 11)}…</Link>{s.external_reference && <div className="text-xs text-neutral-500">{s.external_reference}</div>}</Td>
                      <Td className="tabular whitespace-nowrap font-medium">{s.amount} {s.currency}</Td>
                      <Td className="text-neutral-600">{scenarioLabel(s.scenario)}</Td>
                      <Td><Badge status={s.status} /></Td>
                      <Td className="whitespace-nowrap text-neutral-500">{fmtTime(s.created)}</Td>
                    </tr>
                  ))}
                </TBody>
              </Table>
            )}
            {page.next && <MoreLink href={`/sessions?after=${page.next}${st ? `&status=${st}` : ""}`}>Older sessions →</MoreLink>}
          </Card>
        </>
      );
    }}
  </DashboardFrame>
);
