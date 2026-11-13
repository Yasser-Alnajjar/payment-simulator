import { redirect } from "next/navigation";
import { Actions } from "@/actions";
import { getSessionUser } from "@/server/session";
import { CredentialsView } from "../csr/CredentialsView";

export const CredentialsOverview = async () => {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const res = await Actions.Credentials.getCredentials();
  const credentials = res.ok ? res.data : [];
  return <CredentialsView credentials={credentials} email={user.email} emailVerified={user.emailVerified} />;
};
