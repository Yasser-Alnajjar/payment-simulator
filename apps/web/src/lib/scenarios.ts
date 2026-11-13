/** Display metadata for the simulator scenarios (client-safe: no server imports). The server validates every value again. */
export const SCENARIO_OPTIONS = [
  { value: "success", label: "Succeed", hint: "Payment succeeds immediately." },
  { value: "decline", label: "Decline", hint: "Payment is declined; you can try again." },
  { value: "cancel", label: "Cancel payment", hint: "The payment is cancelled; you can try again." },
  { value: "pending", label: "Stay pending", hint: "Payment stays pending until resolved from the dashboard or the session expires." },
  { value: "pending_then_success", label: "Pending, then succeed", hint: "Pending, then succeeds after the delay." },
  { value: "pending_then_failure", label: "Pending, then fail", hint: "Pending, then fails after the delay." },
  { value: "timeout", label: "Time out", hint: "Stays pending until the session expires, then is cancelled as a timeout." },
] as const;

export const scenarioLabel = (v: string | null) => SCENARIO_OPTIONS.find((o) => o.value === v)?.label ?? v ?? "Customer chooses";
export const DELAY_SCENARIOS: readonly string[] = ["pending_then_success", "pending_then_failure"];
export const CURRENCY_CHOICES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "SEK", "INR", "AED", "KWD"] as const;

/** Deterministic UTC timestamp so server and client renders always agree. */
export const fmtTime = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : "–");
