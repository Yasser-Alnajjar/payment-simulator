import { Suspense } from "react";
import { Loader } from "@components/ui/form";
import { Dashboard } from "@modules";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<Loader />}>
      <Dashboard.WebhookDeliveryDetail id={id.slice(0, 64)} />
    </Suspense>
  );
}
