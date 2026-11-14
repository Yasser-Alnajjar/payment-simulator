import { notFound } from "next/navigation";
import { ApiError } from "@/server/api/errors";
import { db } from "@/server/db";
import { methodDetail } from "@/server/services/dashboard";
import { BEHAVIOR_LABEL, BRAND_LABEL } from "@/lib/test-cards";
import { fmtTime } from "@/lib/scenarios";
import { Badge, Card, DetailList, EmptyState, PageHeader, Row, RowList, Tag } from "@components/ui/form";
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
          <PageHeader
            title={`${BRAND_LABEL[m.card.brand] ?? m.card.brand} •••• ${m.card.last4}`}
            description="Simulated test card"
            badge={<>
              <Badge status={m.status} />
              {m.is_default && <Tag tone="blue">default</Tag>}
            </>}
          />
          <Card title="Details">
            <DetailList rows={rows} />
            <p className="mt-4 break-all font-mono text-xs text-neutral-500">{m.id}</p>
            <div className="mt-4 border-t border-line pt-4"><MethodControls id={m.id} status={m.status} isDefault={m.is_default} redirectTo="/payment-methods" /></div>
          </Card>
          <Card flush title="Related payment attempts">
            {d.payments.length === 0 ? <EmptyState>No payments have used this card.</EmptyState> : (
              <RowList>
                {d.payments.map((p) => (
                  <Row key={p.id}>
                    <span className="font-mono text-xs">{p.id.slice(0, 12)}…</span><Badge status={p.status} /><span>{p.amount} {p.currency}</span>
                    {p.failure_code && <span className="text-neutral-500">code: {p.failure_code}</span>}
                    {p.external_reference && <span className="text-neutral-500">ref: {p.external_reference}</span>}
                    <span className="text-neutral-500">{p.checkout_session_id ? "hosted checkout" : "saved-card charge"} · {fmtTime(p.created)}</span>
                  </Row>
                ))}
              </RowList>
            )}
          </Card>
          <Card flush title="Events">
            {d.events.length === 0 ? <EmptyState>No events.</EmptyState> : (
              <RowList>{d.events.map((e) => (<Row key={e.id} className="justify-between"><code className="font-mono text-xs">{e.type}</code><span className="text-xs text-neutral-500">{fmtTime(e.created)}</span></Row>))}</RowList>
            )}
            <p className="border-t border-line px-4 py-3 text-xs text-neutral-500">Events are delivered to your webhook endpoints as signed requests.</p>
          </Card>
        </>
      );
    }}
  </DashboardFrame>
);
