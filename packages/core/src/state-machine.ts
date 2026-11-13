/** Table-driven state machines. Every status change in the application goes through these tables. */
export const SESSION_STATUSES = ["open", "completed", "expired", "cancelled"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const PAYMENT_STATUSES = ["pending", "succeeded", "failed", "cancelled"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  open: ["completed", "expired", "cancelled"],
  completed: [],
  expired: [],
  cancelled: [],
};

const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  pending: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

/** A payment is created directly in any status (pending or already terminal), never in two steps. */
export const PAYMENT_INITIAL_STATUSES: readonly PaymentStatus[] = PAYMENT_STATUSES;

export const canTransitionSession = (from: SessionStatus, to: SessionStatus) => SESSION_TRANSITIONS[from].includes(to);
export const canTransitionPayment = (from: PaymentStatus, to: PaymentStatus) => PAYMENT_TRANSITIONS[from].includes(to);
export const isTerminalSession = (s: SessionStatus) => SESSION_TRANSITIONS[s].length === 0;
export const isTerminalPayment = (s: PaymentStatus) => PAYMENT_TRANSITIONS[s].length === 0;
/** Statuses that block another attempt on the same session (mirrors the partial unique index). */
export const ACTIVE_PAYMENT_STATUSES: readonly PaymentStatus[] = ["pending", "succeeded"];

export const EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.cancelled",
  "payment.pending",
  "payment.succeeded",
  "payment.failed",
  "payment.cancelled",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const paymentEventType = (s: PaymentStatus): EventType => `payment.${s}`;
export const sessionEventType = (s: Exclude<SessionStatus, "open">): EventType => `checkout.session.${s}`;
