import { randomUUID } from "node:crypto";

/** Public ids are a type prefix plus the internal uuid. A wrong prefix or any other shape is rejected. */
export const ID_PREFIX = { session: "cs_", payment: "pay_", event: "evt_", paymentMethod: "pm_", setupSession: "seti_", webhookEndpoint: "we_", webhookDelivery: "whd_" } as const;
export type IdKind = keyof typeof ID_PREFIX;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const toPublicId = (kind: IdKind, uuid: string): string => ID_PREFIX[kind] + uuid;

/** Returns the internal uuid, or null when the value is not a well-formed public id of that kind. */
export function parsePublicId(kind: IdKind, value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const prefix = ID_PREFIX[kind];
  if (!value.startsWith(prefix)) return null;
  const uuid = value.slice(prefix.length);
  return UUID.test(uuid) ? uuid : null;
}

export const newUuid = (): string => randomUUID();
