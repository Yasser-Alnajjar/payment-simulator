import type { Metadata } from "next";
import { Checkout } from "@modules";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sandbox checkout", robots: { index: false, follow: false }, referrer: "no-referrer" };

// No Suspense boundary on purpose: an unknown token must produce a real 404 status, which needs the lookup to finish before streaming starts.
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Checkout.HostedCheckout token={token} />;
}
