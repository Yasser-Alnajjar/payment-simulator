"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Actions } from "@/actions/client";
import type { ActionResult } from "@/lib/types/common";
import { Button } from "@components/ui/form";

/** Set default / disable / remove. The server re-validates ownership and state; the buttons only reflect what is currently allowed. */
export function MethodControls({ id, status, isDefault, redirectTo }: { id: string; status: string; isDefault: boolean; redirectTo?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const run = (fn: () => Promise<ActionResult<unknown>>, after?: string) => start(async () => {
    const r = await fn();
    setError(r.ok ? undefined : r.error);
    if (r.ok && after) router.push(after);
    else router.refresh();
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "active" && !isDefault && <Button variant="ghost" disabled={pending} onClick={() => run(() => Actions.PaymentMethods.setDefaultAction({ id }))}>Set default</Button>}
      {status !== "disabled" && <Button variant="ghost" disabled={pending} onClick={() => { if (window.confirm("Disable this test card? It can no longer be used and cannot be re-enabled.")) run(() => Actions.PaymentMethods.disableAction({ id })); }}>Disable</Button>}
      <Button variant="danger" disabled={pending} onClick={() => { if (window.confirm("Remove this test card? Payment history is kept.")) run(() => Actions.PaymentMethods.removeAction({ id }), redirectTo); }}>Remove</Button>
      {error && <span role="alert" className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
