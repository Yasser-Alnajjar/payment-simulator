import Link from "next/link";
import { db } from "@/server/db";
import { getOverview } from "@/server/services/dashboard";
import { scenarioLabel, fmtTime } from "@/lib/scenarios";
import { Badge, ButtonLink, Card, EmptyState, MoreLink, Notice, PageHeader, Row, RowList, Stat, StatStrip } from "@components/ui/form";
import { DashboardFrame } from "../../shell";

const STATUS_ORDER = ["open", "completed", "expired", "cancelled"] as const;
const PAY_ORDER = ["pending", "succeeded", "failed", "cancelled"] as const;

export const Overview = async () => (
  <DashboardFrame>
    {async (user) => {
      const o = await getOverview(db(), user.id, new Date());
      const empty = Object.keys(o.sessions).length === 0;
      return (
        <>
          <PageHeader title="Overview" description="Activity across your checkout sessions and payments in the sandbox." action={<ButtonLink href="/sessions">Create a test checkout</ButtonLink>} />
          {empty && <Notice>No checkout sessions yet. Create one through the API with your credentials, or start a test checkout from the dashboard.</Notice>}

          <section aria-labelledby="ov-sessions" className="space-y-2">
            <h2 id="ov-sessions" className="text-sm font-semibold text-neutral-900">Checkout sessions</h2>
            <StatStrip>{STATUS_ORDER.map((s) => <Stat key={s} label={s} status={s} value={o.sessions[s] ?? 0} />)}</StatStrip>
          </section>
          <section aria-labelledby="ov-payments" className="space-y-2">
            <h2 id="ov-payments" className="text-sm font-semibold text-neutral-900">Payments</h2>
            <StatStrip>{PAY_ORDER.map((s) => <Stat key={s} label={s} status={s} value={o.payments[s] ?? 0} />)}</StatStrip>
          </section>

          {o.succeededVolume.length > 0 && (
            <Card title="Succeeded volume" description="Simulated, by currency">
              <ul className="flex flex-wrap gap-x-10 gap-y-3 text-sm">
                {o.succeededVolume.map((v) => (<li key={v.currency}><span className="tabular text-lg font-semibold tracking-tight">{v.amount} {v.currency}</span><span className="block text-xs text-neutral-500">across {v.count} payment{v.count === 1 ? "" : "s"}</span></li>))}
              </ul>
            </Card>
          )}

          <div className="grid gap-6 xl:grid-cols-2">
            <Card flush title="Recent checkout sessions" action={<Link href="/sessions" className="text-[13px] text-neutral-500 hover:text-neutral-900">View all</Link>}>
              {o.recentSessions.length === 0 ? <EmptyState>Nothing yet.</EmptyState> : (
                <RowList>
                  {o.recentSessions.map((s) => (
                    <Row key={s.id} className="justify-between">
                      <div className="min-w-0">
                        <Link href={`/sessions/${s.id}`} className="block truncate font-mono text-xs font-medium hover:underline">{s.id}</Link>
                        <span className="text-xs text-neutral-500">{scenarioLabel(s.scenario)} · {fmtTime(s.created)}</span>
                      </div>
                      <div className="flex items-center gap-3"><span className="tabular whitespace-nowrap">{s.amount} {s.currency}</span><Badge status={s.status} /></div>
                    </Row>
                  ))}
                </RowList>
              )}
            </Card>
            <Card flush title="Recent payments" action={<Link href="/payments" className="text-[13px] text-neutral-500 hover:text-neutral-900">View all</Link>}>
              {o.recentPayments.length === 0 ? <EmptyState>Nothing yet.</EmptyState> : (
                <RowList>
                  {o.recentPayments.map((p) => (
                    <Row key={p.id} className="justify-between">
                      <div className="min-w-0">
                        <span className="block truncate font-mono text-xs font-medium">{p.id}</span>
                        <span className="text-xs text-neutral-500">{fmtTime(p.created)}</span>
                      </div>
                      <div className="flex items-center gap-3"><span className="tabular whitespace-nowrap">{p.amount} {p.currency}</span><Badge status={p.status} /></div>
                    </Row>
                  ))}
                </RowList>
              )}
            </Card>
          </div>
        </>
      );
    }}
  </DashboardFrame>
);
