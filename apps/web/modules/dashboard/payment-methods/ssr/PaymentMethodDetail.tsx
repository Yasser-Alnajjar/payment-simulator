import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiError } from "@/server/api/errors";
import { db } from "@/server/db";
import { methodDetail } from "@/server/services/dashboard";
import { BEHAVIOR_LABEL, BRAND_LABEL } from "@/lib/test-cards";
import { fmtTime } from "@/lib/scenarios";
import { Badge, Card } from "@components/ui/form";
import { DashboardFrame } from "../../shell";
import { MethodControls } from "../csr/MethodControls";

export const PaymentMethodDetail = async ({ id }: { id: string }) => (
  <DashboardFrame>
    {async (user) => {
      let d;
      try { d = await methodDetail(db(), user.id, id, new Date()); } catch (e) { if (e instanceof ApiError && e.status === 404) notFound(); throw e; }
      const m = d.method;
      const rows: [string, string][] = [
        ["Customer", m.customer], ["Project / account", user.email], ["Expires", `${String(m.card.exp_month).padStart(2, "0")}/${m.card.exp_year}`],
        ["Cardholder", m.cardholder_name ?? "–"], ["Test behavior", BEHAVIOR_LABEL[m.test_behavior] ?? m.test_behavior], ["Added", fmtTime(m.created)], ["Updated", fmtTime(m.updated)],
      ];
      return (
        <>
          <p className="text-sm"><Link href="/payment-methods" className="text-neutral-500 underline">← Payment methods</Link></p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">{BRAND_LABEL[m.card.brand] ?? m.card.brand} •••• {m.card.last4}</h1><Badge status={m.status} />
            {m.is_default && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800">default</span>}
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">Simulated test card</span>
          </div>
          <Card title="Details">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">{rows.map(([k, v]) => (<div key={k}><dt className="text-neutral-500">{k}</dt><dd className="break-all">{v}</dd></div>))}</dl>
            <p className="mt-2 break-all font-mono text-xs text-neutral-500">{m.id}</p>
            <div className="mt-4"><MethodControls id={m.id} status={m.status} isDefault={m.is_default} redirectTo="/payment-methods" /></div>
          </Card>
          <Card title="Related payment attempts">
            {d.payments.length === 0 ? <p className="text-sm text-neutral-500">No payments have used this card.</p> : (
              <ul className="divide-y divide-neutral-100 text-sm">
                {d.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                    <span className="font-mono text-xs">{p.id.slice(0, 12)}…</span><Badge status={p.status} /><span>{p.amount} {p.currency}</span>
                    {p.failure_code && <span className="text-neutral-500">code: {p.failure_code}</span>}
                    {p.external_reference && <span className="text-neutral-500">ref: {p.external_reference}</span>}
                    <span className="text-neutral-500">{p.checkout_session_id ? "hosted checkout" : "saved-card charge"} · {fmtTime(p.created)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Events">
            {d.events.length === 0 ? <p className="text-sm text-neutral-500">No events.</p> : (
              <ul className="divide-y divide-neutral-100 text-sm">{d.events.map((e) => (<li key={e.id} className="flex flex-wrap justify-between gap-2 py-1.5"><code>{e.type}</code><span className="text-neutral-500">{fmtTime(e.created)}</span></li>))}</ul>
            )}
            <p className="mt-3 text-xs text-neutral-500">Events are stored for later signed-webhook delivery (S4). Nothing is delivered yet.</p>
          </Card>
        </>
      );
    }}
  </DashboardFrame>
);
