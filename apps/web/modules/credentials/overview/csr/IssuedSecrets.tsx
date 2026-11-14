"use client";

import type { IssuedCredential } from "@/lib/types/credential";
import { Button, Notice, SecretBlock } from "@components/ui/form";

export function IssuedSecrets({ issued, onDismiss }: { issued: IssuedCredential; onDismiss: () => void }) {
  return (
    <Notice tone="warning" title="Copy these now. They will not be shown again.">
      <div className="mt-2 space-y-3">
        {([["Client ID", issued.credential.clientId], ["Client secret", issued.clientSecret], ["Webhook secret", issued.webhookSecret]] as const).map(([k, v]) => (
          <SecretBlock key={k} label={k} value={v} />
        ))}
        <Button variant="ghost" onClick={onDismiss}>I have saved them</Button>
      </div>
    </Notice>
  );
}
