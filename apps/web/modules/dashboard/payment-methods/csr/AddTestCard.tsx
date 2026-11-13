"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Actions } from "@/actions/client";
import { CardForm } from "@components/ui/card-form";
import { Card } from "@components/ui/form";

/** Adds a TEST card through the same service as the API. The number and code are sent once, validated in memory, and never stored. */
export function AddTestCard({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [customer, setCustomer] = useState("");
  const [setDefault, setSetDefault] = useState(false);
  const [done, setDone] = useState<string>();

  return (
    <Card title="Add a test card">
      {!canCreate && <p className="mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900">Verify your email address to add test cards.</p>}
      <div className="mb-3 text-sm">
        <label className="block"><span className="mb-1 block font-medium">Customer reference</span>
          <input value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={128} placeholder="e.g. cus_123 (your own customer id)" className="w-full rounded-md border border-neutral-300 px-3 py-2 text-base sm:text-sm" /></label>
      </div>
      <CardForm
        submitLabel="Add test card" pendingLabel="Adding…" disabled={!canCreate}
        extra={<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={setDefault} onChange={(e) => setSetDefault(e.target.checked)} /> Make this the customer&apos;s default card</label>}
        onSubmit={async (v) => {
          const r = await Actions.PaymentMethods.addTestCardAction({ customer: customer.trim(), ...v, setDefault });
          if (r.ok) { setDone(r.data.id); router.refresh(); } else setDone(undefined);
          return r;
        }}
      />
      {done && <p role="status" className="mt-3 text-sm text-green-800">Test card added: <span className="font-mono text-xs">{done}</span></p>}
    </Card>
  );
}
