"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Actions } from "@/actions/client";
import { Button, Field, Notice } from "@components/ui/form";
import { AuthShell } from "../../csr/AuthShell";

export function ForgotPasswordForm() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  return (
    <AuthShell title="Reset password" description="Enter your email and we will send a reset link." footer={<Link href="/login" className="font-medium text-neutral-900 underline">Back to sign in</Link>}>
      {done ? (
        <Notice tone="success">If an account exists for that address, a reset link is on its way.</Notice>
      ) : (
        <form
          method="post"
          className="space-y-4"
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
          <Button type="submit" disabled={pending} className="w-full">{pending ? "Sending…" : "Send reset link"}</Button>
        </form>
      )}
    </AuthShell>
  );
}
