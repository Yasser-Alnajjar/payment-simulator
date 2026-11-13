import { Suspense } from "react";
import { Loader } from "@components/ui/form";
import { Auth } from "@modules";

export default function Page() {
  return (
    <Suspense fallback={<Loader />}>
      <Auth.Register />
    </Suspense>
  );
}
