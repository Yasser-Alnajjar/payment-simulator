import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiError } from "@/server/api/errors";
import { db } from "@/server/db";
import { sessionDetail } from "@/server/services/dashboard";
import { fmtTime, scenarioLabel } from "@/lib/scenarios";
import { Badge, Card } from "@components/ui/form";
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
          <p className="text-sm"><Link href="/sessions" className="text-neutral-500 underline">← Checkout sessions</Link></p>
          <div className="flex flex-wrap items-center gap-3"><h1 className="break-all font-mono text-base font-semibold">{s.id}</h1><Badge status={s.status} /></div>
          <Card title="Details">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {rows.map(([k, v]) => (<div key={k}><dt className="text-neutral-500">{k}</dt><dd>{v}</dd></div>))}
            </dl>
            {Object.keys(s.metadata as object).length > 0 && <pre className="mt-3 overflow-x-auto rounded bg-neutral-50 p-2 text-xs">{JSON.stringify(s.metadata, null, 2)}</pre>}
            {s.status === "open" && <div className="mt-4"><CancelSession sessionId={s.id} /></div>}
            <p className="mt-3 text-xs text-neutral-500">The checkout link is shown only when a session is created. Its token is stored as a hash and cannot be recovered.</p>
          </Card>
          <Card title="Payments">
            {d.payments.length === 0 ? <p className="text-sm text-neutral-500">No payment attempts yet.</p> : (
              <ul className="divide-y divide-neutral-100 text-sm">
                {d.payments.map((p) => (
                  <li key={p.id} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-center gap-3"><span className="font-mono text-xs">{p.id}</span><Badge status={p.status} /><span>{p.amount} {p.currency}</span><span className="text-neutral-500">{scenarioLabel(p.scenario)}</span>{p.failure_code && <span className="text-neutral-500">code: {p.failure_code}</span>}</div>
                    <div className="text-xs text-neutral-500">Created {fmtTime(p.created)}{p.status === "pending" && p.resolve_at ? ` · resolves ${fmtTime(p.resolve_at)}` : ""}</div>
                    {p.status === "pending" && <ResolvePayment paymentId={p.id} />}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Events">
            {d.events.length === 0 ? <p className="text-sm text-neutral-500">No events.</p> : (
              <ul className="divide-y divide-neutral-100 text-sm">{d.events.map((e) => (<li key={e.id} className="flex flex-wrap justify-between gap-2 py-1.5"><code>{e.type}</code><span className="text-neutral-500">{fmtTime(e.created)}</span></li>))}</ul>
            )}
          </Card>
        </>
      );
    }}
  </DashboardFrame>
);
