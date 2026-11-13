"use client";

import { useState, useTransition } from "react";
import { Actions } from "@/actions/client";
import type { ActionResult } from "@/lib/types/common";
import type { CredentialView, IssuedCredential } from "@/lib/types/credential";
import { Button, Card, SandboxBanner } from "@components/ui/form";
import { IssuedSecrets } from "./IssuedSecrets";

interface Props {
  credentials: CredentialView[];
  email: string;
  emailVerified: boolean;
}

export function CredentialsView({ credentials, email, emailVerified }: Props) {
  const [issued, setIssued] = useState<IssuedCredential>();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const active = credentials.find((c) => c.status === "active");
  const history = credentials.filter((c) => c.status === "revoked").slice(0, 20);

  const run = (fn: () => Promise<ActionResult<IssuedCredential | undefined>>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) { setError(r.error); return; }
      setError(undefined);
      setIssued(r.data);
    });

  return (
    <>
      <SandboxBanner />
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
        <span className="font-semibold">Payment Sandbox</span>
        <form action={Actions.Auth.signOut} className="flex items-center gap-3 text-sm">
          <span className="text-neutral-500">{email}</span>
          <Button variant="ghost" type="submit">Sign out</Button>
        </form>
      </header>
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        {!emailVerified && (
          <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">Verify your email address to create or manage credentials.</p>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {issued && <IssuedSecrets issued={issued} onDismiss={() => setIssued(undefined)} />}
        <Card title="API credentials">
          {active ? (
            <div className="space-y-3 text-sm">
              <div>
                <div className="font-mono">{active.clientId}</div>
                <div className="text-neutral-500">
                  secret {active.clientSecretHint} · created {new Date(active.createdAt).toLocaleDateString()} ·{" "}
                  {active.lastUsedAt ? `last used ${new Date(active.lastUsedAt).toLocaleDateString()}` : "never used"}
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" disabled={pending} onClick={() => run(() => Actions.Credentials.rotateCredentialAction({ credentialId: active.id }))}>Rotate</Button>
                <Button variant="danger" disabled={pending} onClick={() => run(async () => Actions.Credentials.revokeCredentialAction({ credentialId: active.id }).then((r) => (r.ok ? { ok: true as const, data: undefined } : r)))}>Revoke</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-neutral-500">You have no active credentials.</p>
              <Button disabled={pending} onClick={() => run(() => Actions.Credentials.createCredentialAction())}>Create credentials</Button>
            </div>
          )}
        </Card>
        {history.length > 0 && (
          <Card title="Revoked">
            <ul className="divide-y divide-neutral-100 text-sm">
              {history.map((c) => (
                <li key={c.id} className="py-2 text-neutral-500">
                  <span className="font-mono">{c.clientId}</span> · revoked {c.revokedAt ? new Date(c.revokedAt).toLocaleDateString() : ""}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </main>
    </>
  );
}
