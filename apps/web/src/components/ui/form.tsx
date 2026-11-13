import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Button({ variant = "primary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const v = { primary: "bg-neutral-900 text-white hover:bg-neutral-700", ghost: "border border-neutral-300 hover:bg-neutral-100", danger: "border border-red-300 text-red-700 hover:bg-red-50" }[variant];
  return <button {...p} className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${v} ${className}`} />;
}

export function Field({ label, error, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <input {...p} className="w-full rounded-md border border-neutral-300 px-3 py-2 outline-none focus:border-neutral-900" />
      {error && <span className="mt-1 block text-red-600">{error}</span>}
    </label>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-5">
      {title && <h2 className="mb-3 text-base font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

export function Loader() {
  return <p className="p-6 text-sm text-neutral-500">Loading…</p>;
}

export function SandboxBanner() {
  return <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">Sandbox environment: no real payments are processed.</div>;
}
