import { Suspense } from "react";
import { Loader } from "@components/ui/form";
import { Docs } from "@modules";

export default function DocsPage() {
  return (
    <Suspense fallback={<Loader />}>
      <Docs.ApiReference />
    </Suspense>
  );
}
