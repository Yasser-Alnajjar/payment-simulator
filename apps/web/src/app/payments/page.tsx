import { Suspense } from "react";
import { Loader } from "@components/ui/form";
import { Dashboard } from "@modules";

export const dynamic = "force-dynamic";
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.slice(0, 64) : undefined);

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  return (
    <Suspense fallback={<Loader />}>
      <Dashboard.Payments after={one(q.after)} status={one(q.status)} />
    </Suspense>
  );
}
