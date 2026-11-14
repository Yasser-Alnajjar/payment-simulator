"use client";

/** Displays a newly issued signing secret exactly once (it is not stored anywhere readable afterwards). */
export function SecretOnce({ secret, title }: { secret: string; title: string }) {
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
      <p className="font-semibold">{title}</p>
      <code className="block break-all rounded bg-white p-2">{secret}</code>
      <button type="button" className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700" onClick={() => void navigator.clipboard?.writeText(secret)}>Copy secret</button>
    </div>
  );
}
