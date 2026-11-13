import type { PaymentStatus } from "./state-machine";

export const SCENARIOS = ["success", "decline", "pending", "pending_then_success", "pending_then_failure", "cancel", "timeout"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const isScenario = (v: unknown): v is Scenario => typeof v === "string" && (SCENARIOS as readonly string[]).includes(v);

/** Bounds for the simulated pending delay, in seconds. */
export const DEFAULT_PENDING_DELAY_SECONDS = 5;
export const MIN_PENDING_DELAY_SECONDS = 1;
export const MAX_PENDING_DELAY_SECONDS = 3600;

export interface ScenarioPlan {
  /** Status the payment is created in. */
  initial: PaymentStatus;
  /** Scheduled later resolution, if any. */
  resolveTo: "succeeded" | "failed" | null;
  /** Seconds until the scheduled resolution. */
  resolveAfterSeconds: number | null;
  failureCode: string | null;
}

/**
 * Scenario -> plan. The plan only says how the payment starts and whether a resolution is scheduled; every actual status
 * change still goes through the state machine and the database.
 *  - pending / timeout: stay pending until resolved by an operator action or the session expires (expiry cancels the payment).
 */
export function planScenario(scenario: Scenario, delaySeconds: number = DEFAULT_PENDING_DELAY_SECONDS): ScenarioPlan {
  switch (scenario) {
    case "success": return { initial: "succeeded", resolveTo: null, resolveAfterSeconds: null, failureCode: null };
    case "decline": return { initial: "failed", resolveTo: null, resolveAfterSeconds: null, failureCode: "declined" };
    case "cancel": return { initial: "cancelled", resolveTo: null, resolveAfterSeconds: null, failureCode: "payment_cancelled" };
    case "pending": return { initial: "pending", resolveTo: null, resolveAfterSeconds: null, failureCode: null };
    case "timeout": return { initial: "pending", resolveTo: null, resolveAfterSeconds: null, failureCode: null };
    case "pending_then_success": return { initial: "pending", resolveTo: "succeeded", resolveAfterSeconds: delaySeconds, failureCode: null };
    case "pending_then_failure": return { initial: "pending", resolveTo: "failed", resolveAfterSeconds: delaySeconds, failureCode: null };
  }
}
