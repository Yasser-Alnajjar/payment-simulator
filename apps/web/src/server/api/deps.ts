import type { PrismaClient } from "@sandbox/db";

export interface ApiConfig {
  /** Authenticated requests allowed per user per minute. */
  rateLimitPerMinute: number;
  /** Failed-authentication limits per minute. ip is checked before verification; client_id and global after a failure. */
  authFailureLimits: { ip: number; clientId: number; global: number };
}

export const DEFAULT_API_CONFIG: ApiConfig = { rateLimitPerMinute: 100, authFailureLimits: { ip: 30, clientId: 30, global: 600 } };

/** Everything the API needs, injected so the exact same handlers run in route files and in integration tests. */
export interface ApiDeps {
  db: PrismaClient;
  /** SECRETS_ENCRYPTION_KEY (base64, 32 bytes). */
  encKey: string;
  appUrl: string;
  now: () => Date;
  config: ApiConfig;
  /** Webhook URLs may target http/localhost/private addresses. Only ever true in development (see webhooks/config.ts) or tests. */
  allowPrivateWebhookTargets?: boolean;
}
