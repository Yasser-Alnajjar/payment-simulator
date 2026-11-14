"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Actions } from "@/actions/client";
import { Button, Field, FormError } from "@components/ui/form";
import { AuthShell } from "../../csr/AuthShell";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  return (
    <AuthShell title="Sign in" description="Access your sandbox dashboard and API credentials." footer={<>New here? <Link href="/register" className="font-medium text-neutral-900 underline">Create account</Link></>}>
      <form
        method="post"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          start(async () => {
            const r = await Actions.Auth.signIn({ email: f.get("email"), password: f.get("password") });
            if (r.ok) router.push("/");
            else { setError(r.error); setFields(r.fieldErrors ?? {}); }
          });
        }}
      >
        <Field label="Email" name="email" type="email" autoComplete="email" required error={fields.email} />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        {!Object.keys(fields).length && <FormError>{error}</FormError>}
        <Button type="submit" disabled={pending} className="w-full">{pending ? "Signing in…" : "Sign in"}</Button>
      </form>
      <p className="text-center text-sm"><Link href="/forgot-password" className="text-neutral-600 underline hover:text-neutral-900">Forgot password?</Link></p>
    </AuthShell>
  );
}
