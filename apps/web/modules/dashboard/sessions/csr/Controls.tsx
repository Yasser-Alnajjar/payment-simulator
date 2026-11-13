"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Actions } from "@/actions/client";
import type { ActionResult } from "@/lib/types/common";
import { Button } from "@components/ui/form";

function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const run = (fn: () => Promise<ActionResult>) => start(async () => {
    const r = await fn();
    setError(r.ok ? undefined : r.error);
    router.refresh();
  });
  return { pending, error, run };
}

export function CancelSession({ sessionId }: { sessionId: string }) {
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-1">
      <Button variant="danger" disabled={pending} onClick={() => run(() => Actions.Dashboard.cancelSessionAction({ sessionId }))}>Cancel session</Button>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

/** Scenario control for a pending payment. The backend decides whether the transition is allowed. */
export function ResolvePayment({ paymentId }: { paymentId: string }) {
  const { pending, error, run } = useAction();
  const go = (to: "succeeded" | "failed" | "cancelled") => run(() => Actions.Dashboard.resolvePaymentAction({ paymentId, to }));
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={() => go("succeeded")}>Mark succeeded</Button>
        <Button variant="ghost" disabled={pending} onClick={() => go("failed")}>Mark failed</Button>
        <Button variant="ghost" disabled={pending} onClick={() => go("cancelled")}>Cancel payment</Button>
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
