import { EVENT_TYPES, parsePublicId } from "@sandbox/core";
import type { Event, PrismaClient } from "@sandbox/db";
import { invalidRequest, notFound } from "../api/errors";
import { sweepUser } from "../lifecycle";
import type { Page } from "./checkout-sessions";

export async function getEvent(db: PrismaClient, userId: string, publicId: string): Promise<Event> {
  const id = parsePublicId("event", publicId);
  if (!id) throw notFound("Event");
  const e = await db.event.findFirst({ where: { id, userId } });
  if (!e) throw notFound("Event");
  return e;
}

export async function listEvents(db: PrismaClient, userId: string, now: Date, q: { limit?: number; startingAfter?: string; type?: string }): Promise<Page<Event>> {
  const limit = q.limit ?? 10;
  if (q.type !== undefined && !(EVENT_TYPES as readonly string[]).includes(q.type)) throw invalidRequest("invalid_parameter", "Unknown event type", "type");
  let after: bigint | undefined;
  if (q.startingAfter !== undefined) {
    const id = parsePublicId("event", q.startingAfter);
    const cur = id ? await db.event.findFirst({ where: { id, userId }, select: { seq: true } }) : null;
    if (!cur) throw invalidRequest("invalid_cursor", "starting_after does not match an event", "starting_after");
    after = cur.seq;
  }
  await sweepUser(db, userId, now); // make due expiries/resolutions visible as events before listing
  const rows = await db.event.findMany({ where: { userId, ...(q.type ? { type: q.type } : {}), ...(after !== undefined ? { seq: { lt: after } } : {}) }, orderBy: { seq: "desc" }, take: limit + 1 });
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}
