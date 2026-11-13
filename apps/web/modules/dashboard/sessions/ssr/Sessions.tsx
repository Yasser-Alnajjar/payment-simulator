import Link from "next/link";
import { db } from "@/server/db";
import { sessionsPage } from "@/server/services/dashboard";
import { fmtTime, scenarioLabel } from "@/lib/scenarios";
import { Badge, Card } from "@components/ui/form";
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
          <h1 className="text-xl font-semibold">Checkout sessions</h1>
          <CreateTestSession canCreate={user.emailVerified} />
          <Card>
            <nav aria-label="Filter by status" className="mb-3 flex flex-wrap gap-3 text-sm">
              {FILTERS.map((f) => (
                <Link key={f} href={f === "all" ? "/sessions" : `/sessions?status=${f}`} className={(st ?? "all") === f ? "font-medium underline" : "text-neutral-500 hover:text-neutral-900"}>{f}</Link>
              ))}
            </nav>
            {page.items.length === 0 ? <p className="text-sm text-neutral-500">No checkout sessions.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-left text-sm">
                  <thead className="text-neutral-500"><tr><th className="py-1 pr-3 font-medium">Session</th><th className="pr-3 font-medium">Amount</th><th className="pr-3 font-medium">Scenario</th><th className="pr-3 font-medium">Status</th><th className="font-medium">Created</th></tr></thead>
                  <tbody className="divide-y divide-neutral-100">
                    {page.items.map((s) => (
                      <tr key={s.id}>
                        <td className="py-2 pr-3"><Link href={`/sessions/${s.id}`} className="font-mono text-xs underline">{s.id.slice(0, 11)}…</Link>{s.external_reference && <div className="text-xs text-neutral-500">{s.external_reference}</div>}</td>
                        <td className="pr-3">{s.amount} {s.currency}</td>
                        <td className="pr-3 text-neutral-600">{scenarioLabel(s.scenario)}</td>
                        <td className="pr-3"><Badge status={s.status} /></td>
                        <td className="text-neutral-500">{fmtTime(s.created)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {page.next && <p className="mt-3 text-sm"><Link className="underline" href={`/sessions?after=${page.next}${st ? `&status=${st}` : ""}`}>Older sessions →</Link></p>}
          </Card>
        </>
      );
    }}
  </DashboardFrame>
);
