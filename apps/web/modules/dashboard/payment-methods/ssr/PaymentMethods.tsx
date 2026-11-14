import Link from "next/link";
import { db } from "@/server/db";
import { methodsPage } from "@/server/services/dashboard";
import { BEHAVIOR_LABEL, BRAND_LABEL } from "@/lib/test-cards";
import { fmtTime } from "@/lib/scenarios";
import { Badge, Card, EmptyState, FilterTabs, MoreLink, PageHeader, TBody, THead, Table, Tag, Td, Th } from "@components/ui/form";
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
          <PageHeader title="Payment methods" description="Simulated test cards saved for your customers. Full card numbers are never stored." badge={<Tag tone="amber">Test cards</Tag>} />
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <AddTestCard canCreate={user.emailVerified} />
            <CreateSetupLink canCreate={user.emailVerified} />
          </div>
          <Card flush title="Saved cards" action={<FilterTabs label="Filter by status" current={st ?? "all"} items={FILTERS.map((f) => ({ key: f, href: q(f === "all" ? {} : { status: f }).replace(/status=[^&]*&?/, f === "all" ? "" : "$&") }))} />}>
            {cu && <p className="border-b border-line px-4 py-2.5 text-[13px] text-neutral-500">Filtered by customer <code className="font-mono text-xs text-neutral-900">{cu}</code> · <Link href={q({}).replace(/customer=[^&]*&?/, "")} className="underline">clear</Link></p>}
            {page.items.length === 0 ? <EmptyState title="No saved test cards">Add one above or send a customer a setup link.</EmptyState> : (
              <Table minWidth="44rem">
                <THead><Th>Card</Th><Th>Customer</Th><Th>Expires</Th><Th>Status</Th><Th>Test behavior</Th><Th>Actions</Th></THead>
                <TBody>
                  {page.items.map((m) => (
                    <tr key={m.id}>
                      <Td><Link href={`/payment-methods/${m.id}`} className="font-medium hover:underline">{BRAND_LABEL[m.card.brand] ?? m.card.brand} •••• {m.card.last4}</Link>{m.is_default && <span className="ml-2"><Tag tone="blue">default</Tag></span>}<div className="text-xs text-neutral-500">added {fmtTime(m.created)}</div></Td>
                      <Td><Link href={q({ customer: m.customer })} className="font-mono text-xs hover:underline">{m.customer}</Link></Td>
                      <Td className="tabular whitespace-nowrap">{String(m.card.exp_month).padStart(2, "0")}/{m.card.exp_year}</Td>
                      <Td><Badge status={m.status} /></Td>
                      <Td className="text-neutral-600">{BEHAVIOR_LABEL[m.test_behavior] ?? m.test_behavior}</Td>
                      <Td><MethodControls id={m.id} status={m.status} isDefault={m.is_default} /></Td>
                    </tr>
                  ))}
                </TBody>
              </Table>
            )}
            {page.next && <MoreLink href={q({ after: page.next })}>Older cards →</MoreLink>}
          </Card>
          <p className="text-xs text-neutral-500">Test cards only. The full number and security code are never stored; only the brand, last four digits, expiry and a keyed fingerprint are kept. This simulator is not PCI certified.</p>
        </>
      );
    }}
  </DashboardFrame>
);
