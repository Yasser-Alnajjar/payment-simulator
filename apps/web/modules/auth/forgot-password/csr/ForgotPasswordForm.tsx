"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Actions } from "@/actions/client";
import { Button, Field } from "@components/ui/form";
import { AuthShell } from "../../csr/AuthShell";

export function ForgotPasswordForm() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  return (
    <AuthShell title="Reset password">
      {done ? (
        <p className="text-sm">If an account exists for that address, a reset link is on its way.</p>
      ) : (
        <form
          method="post"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            start(async () => {
              const r = await Actions.Auth.requestPasswordReset({ email: f.get("email") });
              if (r.ok) setDone(true);
              else setError(r.fieldErrors?.email ?? r.error); // only malformed input fails; unknown accounts still look successful
            });
          }}
        >
          <Field label="Email" name="email" type="email" required error={error} />
          <Button type="submit" disabled={pending} className="w-full">Send reset link</Button>
        </form>
      )}
      <p className="text-sm"><Link href="/login" className="underline">Back to sign in</Link></p>
    </AuthShell>
  );
}
