"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Actions } from "@/actions/client";
import { CardForm } from "@components/ui/card-form";
import { Card, FieldLabel, Input, Notice } from "@components/ui/form";

/** Adds a TEST card through the same service as the API. The number and code are sent once, validated in memory, and never stored. */
export function AddTestCard({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [customer, setCustomer] = useState("");
  const [setDefault, setSetDefault] = useState(false);
  const [done, setDone] = useState<string>();

  return (
    <Card title="Add a test card">
      {!canCreate && <Notice tone="warning" className="mb-3">Verify your email address to add test cards.</Notice>}
      <div className="mb-3 text-sm">
        <FieldLabel label="Customer reference"><Input value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={128} placeholder="e.g. cus_123 (your own customer id)" /></FieldLabel>
      </div>
      <CardForm
        submitLabel="Add test card" pendingLabel="Adding…" disabled={!canCreate}
        extra={<label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-accent" checked={setDefault} onChange={(e) => setSetDefault(e.target.checked)} /> Make this the customer&apos;s default card</label>}
        onSubmit={async (v) => {
          const r = await Actions.PaymentMethods.addTestCardAction({ customer: customer.trim(), ...v, setDefault });
          if (r.ok) { setDone(r.data.id); router.refresh(); } else setDone(undefined);
          return r;
        }}
      />
      {done && <Notice tone="success" className="mt-3">Test card added: <span className="font-mono text-xs">{done}</span></Notice>}
    </Card>
  );
}
