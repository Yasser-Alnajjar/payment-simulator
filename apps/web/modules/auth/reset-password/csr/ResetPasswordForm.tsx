"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Actions } from "@/actions/client";
import { Button, Field, FormError } from "@components/ui/form";
import { AuthShell } from "../../csr/AuthShell";

export function ResetPasswordForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  return (
    <AuthShell title="Choose a new password" description="Pick a strong password for your account.">
      <form
        method="post"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          start(async () => {
            const r = await Actions.Auth.updatePassword({ password: f.get("password") });
            if (r.ok) router.push("/");
            else setError(r.fieldErrors?.password ?? r.error);
          });
        }}
      >
        <Field label="New password" name="password" type="password" autoComplete="new-password" required />
        <FormError>{error}</FormError>
        <Button type="submit" disabled={pending} className="w-full">{pending ? "Updating…" : "Update password"}</Button>
      </form>
    </AuthShell>
  );
}
