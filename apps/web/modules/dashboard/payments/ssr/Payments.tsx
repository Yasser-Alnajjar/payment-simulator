import Link from "next/link";
import { db } from "@/server/db";
import { paymentsPage } from "@/server/services/dashboard";
import { fmtTime, scenarioLabel } from "@/lib/scenarios";
import { Badge, Card } from "@components/ui/form";
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
          <h1 className="text-xl font-semibold">Payments</h1>
          <Card>
            <nav aria-label="Filter by status" className="mb-3 flex flex-wrap gap-3 text-sm">
              {FILTERS.map((f) => (<Link key={f} href={f === "all" ? "/payments" : `/payments?status=${f}`} className={(st ?? "all") === f ? "font-medium underline" : "text-neutral-500 hover:text-neutral-900"}>{f}</Link>))}
            </nav>
            {page.items.length === 0 ? <p className="text-sm text-neutral-500">No payments.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-left text-sm">
                  <thead className="text-neutral-500"><tr><th className="py-1 pr-3 font-medium">Payment</th><th className="pr-3 font-medium">Amount</th><th className="pr-3 font-medium">Scenario</th><th className="pr-3 font-medium">Status</th><th className="font-medium">Created</th></tr></thead>
                  <tbody className="divide-y divide-neutral-100">
                    {page.items.map((p) => (
                      <tr key={p.id}>
                        <td className="py-2 pr-3"><Link href={`/sessions/${p.checkout_session_id}`} className="font-mono text-xs underline">{p.id.slice(0, 12)}…</Link>{p.failure_code && <div className="text-xs text-neutral-500">{p.failure_code}</div>}</td>
                        <td className="pr-3">{p.amount} {p.currency}</td>
                        <td className="pr-3 text-neutral-600">{scenarioLabel(p.scenario)}</td>
                        <td className="pr-3"><Badge status={p.status} /></td>
                        <td className="text-neutral-500">{fmtTime(p.created)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {page.next && <p className="mt-3 text-sm"><Link className="underline" href={`/payments?after=${page.next}${st ? `&status=${st}` : ""}`}>Older payments →</Link></p>}
          </Card>
        </>
      );
    }}
  </DashboardFrame>
);
