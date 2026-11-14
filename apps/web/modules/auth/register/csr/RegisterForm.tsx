"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Actions } from "@/actions/client";
import { Button, Field, FormError, Notice } from "@components/ui/form";
import { AuthShell } from "../../csr/AuthShell";

export function RegisterForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();
  if (sent) {
    return (
      <AuthShell title="Check your email" footer={<Link href="/login" className="font-medium text-neutral-900 underline">Back to sign in</Link>}>
        <Notice tone="success">We sent a confirmation link. Confirm your address, then sign in. API credentials can only be created after verification.</Notice>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Create account" description="Get sandbox API credentials. No real payments are ever processed." footer={<>Already registered? <Link href="/login" className="font-medium text-neutral-900 underline">Sign in</Link></>}>
      <form
        method="post"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          start(async () => {
            const r = await Actions.Auth.signUp({ email: f.get("email"), password: f.get("password") });
            if (!r.ok) { setError(r.error); setFields(r.fieldErrors ?? {}); return; }
            if (r.data.needsVerification) setSent(true);
            else router.push("/");
          });
        }}
      >
        <Field label="Email" name="email" type="email" autoComplete="email" required error={fields.email} />
        <Field label="Password" name="password" type="password" autoComplete="new-password" required error={fields.password} />
        {!Object.keys(fields).length && <FormError>{error}</FormError>}
        <Button type="submit" disabled={pending} className="w-full">{pending ? "Creating account…" : "Create account"}</Button>
      </form>
    </AuthShell>
  );
}
