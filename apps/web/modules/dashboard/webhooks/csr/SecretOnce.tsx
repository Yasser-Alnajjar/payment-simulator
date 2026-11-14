"use client";

import { Button, Notice, SecretBlock } from "@components/ui/form";

/** Displays a newly issued signing secret exactly once (it is not stored anywhere readable afterwards). */
export function SecretOnce({ secret, title }: { secret: string; title: string }) {
  return (
    <Notice tone="warning" title={title} className="mt-3">
      <div className="mt-2 space-y-3">
        <SecretBlock value={secret} />
        <Button type="button" onClick={() => void navigator.clipboard?.writeText(secret)}>Copy secret</Button>
      </div>
    </Notice>
  );
}
