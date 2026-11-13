import { Actions } from "@/actions";
import { DashboardFrame } from "../../../dashboard/shell";
import { CredentialsView } from "../csr/CredentialsView";

export const CredentialsOverview = async () => (
  <DashboardFrame>
    {async (user) => {
      const res = await Actions.Credentials.getCredentials();
      return <CredentialsView credentials={res.ok ? res.data : []} emailVerified={user.emailVerified} />;
    }}
  </DashboardFrame>
);
