import type { webhookAttemptDto, webhookDeliveryDto, webhookEndpointDto } from "@/server/api/dto";

export type WebhookEndpointRow = Omit<ReturnType<typeof webhookEndpointDto>, "secret">;
export type WebhookDeliveryRow = ReturnType<typeof webhookDeliveryDto>;
export type WebhookAttemptRow = ReturnType<typeof webhookAttemptDto>;

/** Scheduler status shown to every signed-in user: timing only, never cross-account counts. */
export interface SchedulerStatus {
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  /** True when no tick finished in the last 3 minutes (cron paused, not configured, or failing). */
  stale: boolean;
}

export interface WebhooksPageData {
  endpoints: WebhookEndpointRow[];
  deliveries: WebhookDeliveryRow[];
  nextDeliveries: string | null;
  scheduler: SchedulerStatus;
}

export interface WebhookEndpointDetailData {
  endpoint: WebhookEndpointRow;
  deliveries: WebhookDeliveryRow[];
  consecutiveFailures: number;
}

export interface WebhookDeliveryDetailData {
  delivery: WebhookDeliveryRow & { attempts: WebhookAttemptRow[] };
  eventType: string;
  payload: string;
}

export interface CreatedEndpoint { id: string; secret: string }
