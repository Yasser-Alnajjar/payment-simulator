import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/session";
import { ResetPasswordForm } from "../csr/ResetPasswordForm";

export const ResetPassword = async () => {
  const user = await getSessionUser(); // set by /auth/callback after the recovery link is exchanged
  if (!user) redirect("/forgot-password");
  return <ResetPasswordForm />;
};
