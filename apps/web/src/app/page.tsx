import { Suspense } from "react";
import { Loader } from "@components/ui/form";
import { Dashboard } from "@modules";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={<Loader />}>
      <Dashboard.Overview />
    </Suspense>
  );
}
