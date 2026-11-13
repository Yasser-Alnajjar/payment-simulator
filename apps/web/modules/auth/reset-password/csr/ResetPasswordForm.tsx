"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Actions } from "@/actions/client";
import { Button, Field } from "@components/ui/form";
import { AuthShell } from "../../csr/AuthShell";

export function ResetPasswordForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  return (
    <AuthShell title="Choose a new password">
      <form
        method="post"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          start(async () => {
            const r = await Actions.Auth.updatePassword({ password: f.get("password") });
            if (r.ok) router.push("/credentials");
            else setError(r.fieldErrors?.password ?? r.error);
          });
        }}
      >
        <Field label="New password" name="password" type="password" autoComplete="new-password" required />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" disabled={pending} className="w-full">Update password</Button>
      </form>
    </AuthShell>
  );
}
