import Link from "next/link";
import { db } from "@/server/db";
import { getOverview } from "@/server/services/dashboard";
import { scenarioLabel, fmtTime } from "@/lib/scenarios";
import { Badge, Card } from "@components/ui/form";
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-xl font-semibold">Overview</h1>
            <Link href="/sessions" className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700">Create a test checkout</Link>
          </div>
          {empty && (
            <Card>
              <p className="text-sm text-neutral-600">No checkout sessions yet. Create one through the API with your credentials, or start a test checkout from the dashboard.</p>
            </Card>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="Checkout sessions">
              <dl className="grid grid-cols-2 gap-2 text-sm">
                {STATUS_ORDER.map((s) => (<div key={s}><dt><Badge status={s} /></dt><dd className="text-2xl font-semibold">{o.sessions[s] ?? 0}</dd></div>))}
              </dl>
            </Card>
            <Card title="Payments">
              <dl className="grid grid-cols-2 gap-2 text-sm">
                {PAY_ORDER.map((s) => (<div key={s}><dt><Badge status={s} /></dt><dd className="text-2xl font-semibold">{o.payments[s] ?? 0}</dd></div>))}
              </dl>
            </Card>
          </div>
          {o.succeededVolume.length > 0 && (
            <Card title="Succeeded volume (simulated)">
              <ul className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
                {o.succeededVolume.map((v) => (<li key={v.currency}><span className="font-semibold">{v.amount} {v.currency}</span> <span className="text-neutral-500">across {v.count} payment{v.count === 1 ? "" : "s"}</span></li>))}
              </ul>
            </Card>
          )}
          <Card title="Recent checkout sessions">
            {o.recentSessions.length === 0 ? <p className="text-sm text-neutral-500">Nothing yet.</p> : (
              <ul className="divide-y divide-neutral-100 text-sm">
                {o.recentSessions.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link href={`/sessions/${s.id}`} className="font-mono text-xs underline">{s.id}</Link>
                    <span>{s.amount} {s.currency}</span>
                    <span className="text-neutral-500">{scenarioLabel(s.scenario)}</span>
                    <Badge status={s.status} />
                    <span className="text-neutral-400">{fmtTime(s.created)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Recent payments">
            {o.recentPayments.length === 0 ? <p className="text-sm text-neutral-500">Nothing yet.</p> : (
              <ul className="divide-y divide-neutral-100 text-sm">
                {o.recentPayments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="font-mono text-xs">{p.id}</span>
                    <span>{p.amount} {p.currency}</span>
                    <Badge status={p.status} />
                    <span className="text-neutral-400">{fmtTime(p.created)}</span>
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
