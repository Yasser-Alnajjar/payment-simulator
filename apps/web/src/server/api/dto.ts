import { formatAmount, minorToNumber, toPublicId } from "@sandbox/core";
import type { CheckoutSession, Event, Transaction } from "@sandbox/db";

/** Public DTOs. Internal columns (user_id, seq, token_hash, version) are never exposed. Amounts: decimal string plus a JSON-safe integer. */
export function sessionDto(s: CheckoutSession, extra: { url?: string } = {}) {
  return {
    id: toPublicId("session", s.id),
    object: "checkout.session" as const,
    status: s.status,
    amount: formatAmount(s.amountMinor, s.currency),
    amount_minor: minorToNumber(s.amountMinor),
    currency: s.currency,
    external_reference: s.externalReference,
    metadata: s.metadata,
    scenario: s.presetScenario,
    expires_at: s.expiresAt.toISOString(),
    created: s.createdAt.toISOString(),
    ...(extra.url ? { url: extra.url } : {}),
  };
}

export function paymentDto(p: Transaction, s: Pick<CheckoutSession, "externalReference" | "metadata">) {
  return {
    id: toPublicId("payment", p.id),
    object: "payment" as const,
    checkout_session_id: toPublicId("session", p.checkoutSessionId),
    status: p.status,
    amount: formatAmount(p.amountMinor, p.currency),
    amount_minor: minorToNumber(p.amountMinor),
    currency: p.currency,
    scenario: p.scenario,
    failure_code: p.failureCode,
    external_reference: s.externalReference,
    metadata: s.metadata,
    resolve_at: p.resolveAt?.toISOString() ?? null,
    created: p.createdAt.toISOString(),
    updated: p.updatedAt.toISOString(),
  };
}

/** The stored payload text is the response, byte for byte. */
export const eventRaw = (e: Pick<Event, "payload">) => e.payload;

/** Marker for a pre-serialized JSON string, so exact event bytes survive the response pipeline. */
export class RawJson {
  constructor(public readonly text: string) {}
}

export const listDto = <T>(data: T[], hasMore: boolean) => ({ object: "list" as const, data, has_more: hasMore });
export const rawList = (items: string[], hasMore: boolean) => new RawJson(`{"object":"list","data":[${items.join(",")}],"has_more":${hasMore}}`);
