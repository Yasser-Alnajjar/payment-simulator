"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Actions } from "@/actions/client";
import { Button, Field } from "@components/ui/form";
import { AuthShell } from "../../csr/AuthShell";

export function RegisterForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();
  if (sent) {
    return (
      <AuthShell title="Check your email">
        <p className="text-sm">We sent a confirmation link. Confirm your address, then <Link href="/login" className="underline">sign in</Link>. API credentials can only be created after verification.</p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Create account">
      <form
        method="post"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          start(async () => {
            const r = await Actions.Auth.signUp({ email: f.get("email"), password: f.get("password") });
            if (!r.ok) { setError(r.error); setFields(r.fieldErrors ?? {}); return; }
            if (r.data.needsVerification) setSent(true);
            else router.push("/credentials");
          });
        }}
      >
        <Field label="Email" name="email" type="email" autoComplete="email" required error={fields.email} />
        <Field label="Password" name="password" type="password" autoComplete="new-password" required error={fields.password} />
        {error && !Object.keys(fields).length && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" disabled={pending} className="w-full">Create account</Button>
      </form>
      <p className="text-sm">Already registered? <Link href="/login" className="underline">Sign in</Link></p>
    </AuthShell>
  );
}
