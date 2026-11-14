"use client";

import { useState, useTransition } from "react";
import { Actions } from "@/actions/client";
import type { ActionResult } from "@/lib/types/common";
import type { CredentialView, IssuedCredential } from "@/lib/types/credential";
import { Badge, Button, Card, DetailList, FormError, Notice, PageHeader, Row, RowList } from "@components/ui/form";
import { IssuedSecrets } from "./IssuedSecrets";

/** Deterministic UTC date so the server and browser render the same text. */
const fmtDate = (iso: string) => iso.slice(0, 10);

interface Props {
  credentials: CredentialView[];
  emailVerified: boolean;
}

export function CredentialsView({ credentials, emailVerified }: Props) {
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
      <PageHeader title="Credentials" description="API credentials authenticate your server requests to the sandbox API." />
      <div className="space-y-6">
        {!emailVerified && <Notice tone="warning">Verify your email address to create or manage credentials.</Notice>}
        <FormError>{error}</FormError>
        {issued && <IssuedSecrets issued={issued} onDismiss={() => setIssued(undefined)} />}
        <Card title="API credentials" action={active && <Badge status="active" />}>
          {active ? (
            <div className="space-y-5 text-sm">
              <DetailList cols={4} rows={[
                ["Client ID", <span key="c" className="font-mono text-xs">{active.clientId}</span>],
                ["Client secret", <span key="s" className="font-mono text-xs">{active.clientSecretHint}</span>],
                ["Created", fmtDate(active.createdAt)],
                ["Last used", active.lastUsedAt ? fmtDate(active.lastUsedAt) : "never used"],
              ]} />
              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                <Button variant="ghost" disabled={pending} onClick={() => run(() => Actions.Credentials.rotateCredentialAction({ credentialId: active.id }))}>Rotate</Button>
                <Button variant="danger" disabled={pending} onClick={() => run(async () => Actions.Credentials.revokeCredentialAction({ credentialId: active.id }).then((r) => (r.ok ? { ok: true as const, data: undefined } : r)))}>Revoke</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-neutral-500">You have no active credentials. Create a set to call the API.</p>
              <Button disabled={pending} onClick={() => run(() => Actions.Credentials.createCredentialAction())}>Create credentials</Button>
            </div>
          )}
        </Card>
        {history.length > 0 && (
          <Card flush title="Revoked">
            <RowList>
              {history.map((c) => (
                <Row key={c.id} className="justify-between text-neutral-500">
                  <span className="font-mono text-xs">{c.clientId}</span><span className="text-xs">revoked {c.revokedAt ? fmtDate(c.revokedAt) : ""}</span>
                </Row>
              ))}
            </RowList>
          </Card>
        )}
      </div>
    </>
  );
}
