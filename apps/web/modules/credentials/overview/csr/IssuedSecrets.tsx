"use client";

import type { IssuedCredential } from "@/lib/types/credential";
import { Button } from "@components/ui/form";

export function IssuedSecrets({ issued, onDismiss }: { issued: IssuedCredential; onDismiss: () => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
      <p className="font-semibold">Copy these now. They will not be shown again.</p>
      {([["Client ID", issued.credential.clientId], ["Client secret", issued.clientSecret], ["Webhook secret", issued.webhookSecret]] as const).map(([k, v]) => (
        <div key={k}><span className="text-neutral-600">{k}</span><code className="block break-all rounded bg-white p-2">{v}</code></div>
      ))}
      <Button variant="ghost" onClick={onDismiss}>I have saved them</Button>
    </div>
  );
}
