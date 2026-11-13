import { Suspense } from "react";
import { Loader } from "@components/ui/form";
import { Credentials } from "@modules";

export default function Page() {
  return (
    <Suspense fallback={<Loader />}>
      <Credentials.CredentialsOverview />
    </Suspense>
  );
}
