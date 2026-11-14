import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/** Shared UI primitives for the dashboard, auth pages and hosted checkout. Surfaces and lines come from the tokens in globals.css. */

export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const BUTTON_VARIANT = {
  primary: "bg-neutral-900 text-white hover:bg-neutral-700",
  ghost: "border border-line-strong bg-surface text-neutral-900 hover:bg-subtle",
  danger: "border border-red-300 bg-surface text-red-700 hover:bg-red-50",
} as const;
type ButtonVariant = keyof typeof BUTTON_VARIANT;

export const buttonClass = (variant: ButtonVariant = "primary", className = "") =>
  `inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS} ${BUTTON_VARIANT[variant]} ${className}`;

export function Button({ variant = "primary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button {...p} className={buttonClass(variant, className)} />;
}

/** A link that looks like a Button (internal navigation uses next/link; `external` opens a new tab). */
export function ButtonLink({ variant = "primary", className = "", external, href, ...p }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { variant?: ButtonVariant; href: string; external?: boolean }) {
  return external
    ? <a {...p} href={href} target="_blank" rel="noopener" className={buttonClass(variant, className)} />
    : <Link {...p} href={href} className={buttonClass(variant, className)} />;
}

/** One input look for every text field: 16px on small screens (no iOS zoom), 14px from `sm`, visible focus ring. */
export const inputClass = "w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-base text-neutral-900 shadow-[0_1px_0_rgb(0_0_0/0.02)] placeholder:text-neutral-400 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent disabled:opacity-50 sm:py-1.5 sm:text-sm";

export function Input({ className = "", ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={`${inputClass} ${className}`} />;
}

export function Select({ className = "", ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={`${inputClass} ${className}`} />;
}

/** Label + control + hint/error wrapper for any control. */
export function FieldLabel({ label, hint, error, children, className = "" }: { label: string; hint?: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block text-sm ${className}`}>
      <span className="mb-1.5 block text-[13px] font-medium text-neutral-900">{label}</span>
      {children}
      {hint && !error && <span className="mt-1.5 block text-xs text-neutral-500">{hint}</span>}
      {error && <span role="alert" className="mt-1.5 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

export function Field({ label, error, hint, className, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  return (
    <FieldLabel label={label} error={error} hint={hint} className={className}>
      <Input {...p} aria-invalid={error ? true : undefined} />
    </FieldLabel>
  );
}

/** A bordered surface. `flush` removes padding so a Table can span edge to edge. */
export function Card({ title, description, action, children, className = "", flush = false }: { title?: string; description?: string; action?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={`overflow-hidden rounded-lg border border-line bg-surface ${className}`}>
      {(title || action) && (
        <div className={`flex flex-wrap items-center justify-between gap-2 ${flush ? "border-b border-line px-4 py-3" : "px-4 pt-4 sm:px-5 sm:pt-5"}`}>
          <div>
            {title && <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-neutral-500">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className={flush ? "" : `px-4 pb-4 sm:px-5 sm:pb-5 ${title || action ? "pt-3" : "pt-4 sm:pt-5"}`}>{children}</div>
    </section>
  );
}

/** Page title block used by every authenticated page. Breadcrumbs live in the topbar; `back` is only for parents the route cannot express. */
export function PageHeader({ title, description, back, badge, action, mono }: { title: ReactNode; description?: ReactNode; back?: { href: string; label: string }; badge?: ReactNode; action?: ReactNode; mono?: boolean }) {
  return (
    <div className="space-y-1.5">
      {back && <Link href={back.href} className={`inline-block text-[13px] text-neutral-500 hover:text-neutral-900 ${FOCUS}`}>← {back.label}</Link>}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className={`min-w-0 break-all font-semibold tracking-tight text-neutral-900 ${mono ? "font-mono text-base" : "text-xl"}`}>{title}</h1>
            {badge}
          </div>
          {description && <p className="mt-1 max-w-2xl text-sm text-neutral-500">{description}</p>}
        </div>
        {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
      </div>
    </div>
  );
}

const NOTICE = {
  info: "border-line bg-subtle text-neutral-700",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  error: "border-red-300 bg-red-50 text-red-800",
  success: "border-green-800/25 bg-green-50 text-green-900",
} as const;

/** Inline message box. `error` is announced as an alert, the rest as status. */
export function Notice({ tone = "info", title, children, className = "" }: { tone?: keyof typeof NOTICE; title?: string; children: ReactNode; className?: string }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-md border px-3.5 py-3 text-sm ${NOTICE[tone]} ${className}`}>
      {title && <p className="font-medium">{title}</p>}
      <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>
    </div>
  );
}

/** Inline error under a form or control. */
export function FormError({ children, className = "" }: { children?: ReactNode; className?: string }) {
  if (!children) return null;
  return <p role="alert" className={`text-sm text-red-600 ${className}`}>{children}</p>;
}

/** A value that is only shown once (links, secrets). */
export function SecretBlock({ label, value }: { label?: string; value: string }) {
  return (
    <div>
      {label && <span className="mb-1 block text-xs font-medium text-neutral-600">{label}</span>}
      <code className="block break-all rounded-md border border-line bg-surface p-2.5 font-mono text-xs text-neutral-900">{value}</code>
    </div>
  );
}

/** Label/value pairs in a quiet two-column grid. */
export function DetailList({ rows, cols = 3 }: { rows: readonly (readonly [string, ReactNode])[]; cols?: 3 | 4 }) {
  return (
    <dl className={`grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2 ${cols === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
      {rows.map(([k, v]) => (<div key={k} className="min-w-0"><dt className="text-xs text-neutral-500">{k}</dt><dd className="mt-1 break-words text-neutral-900">{v}</dd></div>))}
    </dl>
  );
}

/** Headline numbers in one bordered strip instead of one card per number. */
export function StatStrip({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 divide-line overflow-hidden rounded-lg border border-line bg-surface sm:grid-cols-4 sm:divide-x [&>*]:border-line [&>*:nth-child(n+3)]:border-t sm:[&>*:nth-child(n+3)]:border-t-0 [&>*:nth-child(even)]:border-l sm:[&>*:nth-child(even)]:border-l-0">{children}</div>;
}
export function Stat({ label, value, status }: { label: string; value: ReactNode; status?: string }) {
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-2 text-xs text-neutral-500">{status && <StatusDot status={status} />}{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold tracking-tight text-neutral-900">{value}</div>
    </div>
  );
}

/** Tables span the card edge to edge (use inside `<Card flush>`) and scroll horizontally on narrow screens. */
export function Table({ minWidth = "34rem", children }: { minWidth?: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" style={{ minWidth }}>{children}</table>
    </div>
  );
}
export const THead = ({ children }: { children: ReactNode }) => <thead className="bg-subtle/60 text-xs text-neutral-500"><tr>{children}</tr></thead>;
export const Th = ({ children, className = "" }: { children?: ReactNode; className?: string }) => (
  <th scope="col" className={`whitespace-nowrap px-4 py-2 font-medium ${className}`}>{children}</th>
);
export const Td = ({ children, className = "" }: { children?: ReactNode; className?: string }) => (
  <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>
);
export const TBody = ({ children }: { children: ReactNode }) => <tbody className="divide-y divide-line [&>tr:hover]:bg-subtle/50">{children}</tbody>;

/** Rows of a plain list inside a flush Card. */
export const RowList = ({ children }: { children: ReactNode }) => <ul className="divide-y divide-line text-sm">{children}</ul>;
export const Row = ({ children, className = "" }: { children: ReactNode; className?: string }) => <li className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 ${className}`}>{children}</li>;

/** Status filters rendered as a segmented control of links (state lives in the URL). */
export function FilterTabs({ label, items, current }: { label: string; items: readonly { key: string; href: string }[]; current: string }) {
  return (
    <nav aria-label={label} className="inline-flex max-w-full flex-wrap gap-0.5 rounded-md bg-subtle p-0.5 text-[13px]">
      {items.map((i) => (
        <Link key={i.key} href={i.href} aria-current={current === i.key ? "page" : undefined}
          className={`rounded px-2.5 py-1 capitalize transition-colors ${FOCUS} ${current === i.key ? "bg-surface font-medium text-neutral-900 shadow-sm ring-1 ring-line" : "text-neutral-500 hover:text-neutral-900"}`}>{i.key}</Link>
      ))}
    </nav>
  );
}

export function EmptyState({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      {title && <p className="text-sm font-medium text-neutral-900">{title}</p>}
      {children && <p className={`mx-auto max-w-sm text-sm text-neutral-500 ${title ? "mt-1" : ""}`}>{children}</p>}
    </div>
  );
}

/** Pagination footer link for a Card. */
export function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return <div className="border-t border-line px-4 py-2.5 text-sm"><Link href={href} className={`font-medium text-neutral-900 hover:underline ${FOCUS}`}>{children}</Link></div>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}

/** Loading placeholder shown while a page's data resolves. */
export function Loader() {
  return (
    <div role="status" aria-label="Loading" className="space-y-6 p-4 sm:p-6 lg:p-8">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

export function SandboxBanner() {
  return <div className="border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900">Sandbox environment: no real payments are processed.</div>;
}

/** Small pill for the sandbox environment. */
export function SandboxPill() {
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-900"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-800" />Sandbox<span className="hidden sm:inline"> · no real payments</span></span>;
}

/** Brand mark used in the sidebar, auth pages and hosted checkout. */
export function Brand({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 font-semibold tracking-tight text-neutral-900 ${className}`}>
      <span aria-hidden className="flex h-6 w-6 items-center justify-center rounded-md bg-neutral-900 text-white">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </span>
      Payment Sandbox
    </span>
  );
}

const TONE = {
  blue: "bg-blue-50 text-blue-800", amber: "bg-amber-50 text-amber-800", green: "bg-green-50 text-green-800", red: "bg-red-50 text-red-800", gray: "bg-subtle text-neutral-600",
} as const;
const STATUS_TONE: Record<string, keyof typeof TONE> = {
  open: "blue", pending: "amber", completed: "green", succeeded: "green", failed: "red", expired: "gray", cancelled: "gray",
  retrying: "amber", enabled: "green", disabled: "gray", success: "green", retryable: "amber", permanent: "red", abandoned: "gray", active: "green",
};
const toneOf = (s: string) => TONE[STATUS_TONE[s] ?? "gray"];

export function StatusDot({ status }: { status: string }) {
  return <span aria-hidden className={`h-1.5 w-1.5 rounded-full bg-current ${toneOf(status).split(" ")[1]}`} />;
}

export function Badge({ status }: { status: string }) {
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${toneOf(status)}`}><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />{status}</span>;
}

/** Neutral/accent pill for non-status labels (default card, simulated, test). */
export function Tag({ children, tone = "gray" }: { children: ReactNode; tone?: keyof typeof TONE | "purple" }) {
  const cls = tone === "purple" ? "bg-purple-50 text-purple-800" : TONE[tone];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}
