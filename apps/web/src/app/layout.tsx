import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Payment Simulate",
  description: "Simulate payment provider. No real payments.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className="min-h-screen bg-canvas text-neutral-900 antialiased"
      >
        {children}
      </body>
    </html>
  );
}
