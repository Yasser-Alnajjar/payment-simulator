import Link from "next/link";
import { db } from "@/server/db";
import { methodsPage } from "@/server/services/dashboard";
import { BEHAVIOR_LABEL, BRAND_LABEL } from "@/lib/test-cards";
import { fmtTime } from "@/lib/scenarios";
import { Badge, Card } from "@components/ui/form";
import { DashboardFrame } from "../../shell";
import { AddTestCard } from "../csr/AddTestCard";
import { CreateSetupLink } from "../csr/CreateSetupLink";
import { MethodControls } from "../csr/MethodControls";

const FILTERS = ["all", "active", "expired", "disabled"] as const;

export const PaymentMethods = async ({ after, status, customer }: { after?: string; status?: string; customer?: string }) => (
  <DashboardFrame>
    {async (user) => {
      const st = FILTERS.includes(status as never) && status !== "all" ? status : undefined;
      const cu = customer && /^[A-Za-z0-9_.:@-]{1,128}$/.test(customer) ? customer : undefined;
      let page;
      try { page = await methodsPage(db(), user.id, new Date(), { after, status: st, customer: cu }); } catch { page = await methodsPage(db(), user.id, new Date(), { status: st, customer: cu }); }
      const q = (extra: Record<string, string>) => { const p = new URLSearchParams({ ...(st ? { status: st } : {}), ...(cu ? { customer: cu } : {}), ...extra }); return `/payment-methods${p.size ? `?${p}` : ""}`; };
      return (
        <>
          <div className="flex flex-wrap items-center gap-3"><h1 className="text-xl font-semibold">Payment methods</h1><span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">Simulated test cards</span></div>
          <div className="grid gap-6 lg:grid-cols-2">
            <AddTestCard canCreate={user.emailVerified} />
            <CreateSetupLink canCreate={user.emailVerified} />
          </div>
          <Card>
            <nav aria-label="Filter by status" className="mb-3 flex flex-wrap gap-3 text-sm">
              {FILTERS.map((f) => (<Link key={f} href={q(f === "all" ? {} : { status: f }).replace(/status=[^&]*&?/, f === "all" ? "" : "$&")} className={(st ?? "all") === f ? "font-medium underline" : "text-neutral-500 hover:text-neutral-900"}>{f}</Link>))}
              {cu && <span className="text-neutral-500">· customer: <code>{cu}</code> <Link href={q({}).replace(/customer=[^&]*&?/, "")} className="underline">clear</Link></span>}
            </nav>
            {page.items.length === 0 ? <p className="text-sm text-neutral-500">No saved test cards yet. Add one above or send a customer a setup link.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <thead className="text-neutral-500"><tr><th className="py-1 pr-3 font-medium">Card</th><th className="pr-3 font-medium">Customer</th><th className="pr-3 font-medium">Expires</th><th className="pr-3 font-medium">Status</th><th className="pr-3 font-medium">Test behavior</th><th className="font-medium">Actions</th></tr></thead>
                  <tbody className="divide-y divide-neutral-100">
                    {page.items.map((m) => (
                      <tr key={m.id}>
                        <td className="py-2 pr-3"><Link href={`/payment-methods/${m.id}`} className="font-medium underline">{BRAND_LABEL[m.card.brand] ?? m.card.brand} •••• {m.card.last4}</Link>{m.is_default && <span className="ml-2 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800">default</span>}<div className="text-xs text-neutral-500">added {fmtTime(m.created)}</div></td>
                        <td className="pr-3"><Link href={q({ customer: m.customer })} className="font-mono text-xs underline">{m.customer}</Link></td>
                        <td className="pr-3">{String(m.card.exp_month).padStart(2, "0")}/{m.card.exp_year}</td>
                        <td className="pr-3"><Badge status={m.status} /></td>
                        <td className="pr-3 text-neutral-600">{BEHAVIOR_LABEL[m.test_behavior] ?? m.test_behavior}</td>
                        <td><MethodControls id={m.id} status={m.status} isDefault={m.is_default} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {page.next && <p className="mt-3 text-sm"><Link className="underline" href={q({ after: page.next })}>Older cards →</Link></p>}
          </Card>
          <p className="text-xs text-neutral-500">Test cards only. The full number and security code are never stored; only the brand, last four digits, expiry and a keyed fingerprint are kept. This simulator is not PCI certified.</p>
        </>
      );
    }}
  </DashboardFrame>
);
