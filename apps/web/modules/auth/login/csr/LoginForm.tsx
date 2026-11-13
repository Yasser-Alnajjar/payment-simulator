"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Actions } from "@/actions/client";
import { Button, Field } from "@components/ui/form";
import { AuthShell } from "../../csr/AuthShell";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  return (
    <AuthShell title="Sign in">
      <form
        method="post"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          start(async () => {
            const r = await Actions.Auth.signIn({ email: f.get("email"), password: f.get("password") });
            if (r.ok) router.push("/credentials");
            else { setError(r.error); setFields(r.fieldErrors ?? {}); }
          });
        }}
      >
        <Field label="Email" name="email" type="email" autoComplete="email" required error={fields.email} />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        {error && !Object.keys(fields).length && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" disabled={pending} className="w-full">Sign in</Button>
      </form>
      <p className="text-sm"><Link href="/forgot-password" className="underline">Forgot password?</Link> · <Link href="/register" className="underline">Create account</Link></p>
    </AuthShell>
  );
}
