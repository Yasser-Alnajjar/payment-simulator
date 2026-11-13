"use client";

import { useRef, useState, useTransition } from "react";
import { TEST_CARD_OPTIONS } from "@/lib/test-cards";
import type { ActionResult } from "@/lib/types/common";
import { Button } from "./form";

export interface CardFormValues { number: string; expMonth: number; expYear: number; cvc: string; name?: string }

/** Prominent, always-visible reminder. The simulator only accepts its published test numbers. */
export function TestCardNotice() {
  return (
    <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
      <strong>Test cards only.</strong> This is a simulator: use one of the published test numbers below. Never enter a real card number; real numbers are rejected and nothing is charged.
    </p>
  );
}

/**
 * Test-card entry. Inputs are uncontrolled and read once on submit, then the form is reset, so the number and code are never kept in
 * React state or shown again. Nothing is stored in the browser (autocomplete is off).
 */
export function CardForm({ submitLabel, pendingLabel, onSubmit, extra, disabled }: {
  submitLabel: string;
  pendingLabel: string;
  onSubmit: (v: CardFormValues) => Promise<ActionResult<unknown>>;
  extra?: React.ReactNode;
  disabled?: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});

  const fill = (n: string) => {
    const o = TEST_CARD_OPTIONS.find((c) => c.number === n);
    const f = form.current;
    if (!o || !f) return;
    (f.elements.namedItem("number") as HTMLInputElement).value = o.number;
    (f.elements.namedItem("cvc") as HTMLInputElement).value = o.cvc;
    if (!(f.elements.namedItem("expMonth") as HTMLInputElement).value) (f.elements.namedItem("expMonth") as HTMLInputElement).value = "12";
    if (!(f.elements.namedItem("expYear") as HTMLInputElement).value) (f.elements.namedItem("expYear") as HTMLInputElement).value = String(new Date().getFullYear() + 3);
  };

  const inp = "w-full rounded-md border border-neutral-300 px-3 py-2 text-base outline-none focus:border-neutral-900 sm:text-sm";
  const err = (k: string) => fields[k] && <span role="alert" className="mt-1 block text-xs text-red-600">{fields[k]}</span>;

  return (
    <form
      ref={form}
      className="space-y-3 text-sm"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const name = String(f.get("name") ?? "").trim();
        const values: CardFormValues = { number: String(f.get("number") ?? ""), expMonth: Number(f.get("expMonth")), expYear: Number(f.get("expYear")), cvc: String(f.get("cvc") ?? ""), ...(name ? { name } : {}) };
        start(async () => {
          const r = await onSubmit(values);
          if (r.ok) { setError(undefined); setFields({}); form.current?.reset(); return; }
          setError(r.error);
          setFields(r.fieldErrors ?? {});
        });
      }}
    >
      <TestCardNotice />
      <label className="block"><span className="mb-1 block font-medium">Fill a test card</span>
        <select aria-label="Fill a test card" defaultValue="" onChange={(e) => { if (e.target.value) fill(e.target.value); e.target.value = ""; }} className={inp}>
          <option value="">Choose a published test card…</option>
          {TEST_CARD_OPTIONS.map((c) => <option key={c.number} value={c.number}>{c.label} ({c.number.slice(-4)})</option>)}
        </select></label>
      <label className="block"><span className="mb-1 block font-medium">Test card number</span>
        <input name="number" required inputMode="numeric" autoComplete="off" maxLength={23} placeholder="4242 4242 4242 4242" className={inp} />{err("number")}</label>
      <div className="grid grid-cols-3 gap-3">
        <label className="block"><span className="mb-1 block font-medium">Month</span>
          <input name="expMonth" required type="number" inputMode="numeric" min={1} max={12} autoComplete="off" placeholder="MM" className={inp} />{err("expMonth")}</label>
        <label className="block"><span className="mb-1 block font-medium">Year</span>
          <input name="expYear" required type="number" inputMode="numeric" min={2000} max={2200} autoComplete="off" placeholder="YYYY" className={inp} />{err("expYear")}</label>
        <label className="block"><span className="mb-1 block font-medium">Code</span>
          <input name="cvc" required inputMode="numeric" maxLength={4} autoComplete="off" placeholder="123" className={inp} />{err("cvc")}</label>
      </div>
      <label className="block"><span className="mb-1 block font-medium">Cardholder name (optional)</span>
        <input name="name" maxLength={100} autoComplete="off" className={inp} />{err("name")}</label>
      {extra}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={pending || disabled} className="w-full py-2.5">{pending ? pendingLabel : submitLabel}</Button>
    </form>
  );
}
