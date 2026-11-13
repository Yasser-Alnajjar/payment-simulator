import { formatAmount, toPublicId } from "@sandbox/core";
import type { PrismaClient } from "@sandbox/db";
import { paymentDto, sessionDto } from "../api/dto";
import { sweepUser } from "../lifecycle";
import { getCheckoutSession, listCheckoutSessions } from "./checkout-sessions";
import { listPayments } from "./payments";

export type SessionRow = ReturnType<typeof sessionDto>;
export type PaymentRow = ReturnType<typeof paymentDto>;
export interface Counts { [status: string]: number }
export interface Overview {
  sessions: Counts;
  payments: Counts;
  succeededVolume: { currency: string; amount: string; count: number }[];
  recentSessions: SessionRow[];
  recentPayments: PaymentRow[];
}

/** Everything is scoped by the signed-in user's id, which only ever comes from the session. */
export async function getOverview(db: PrismaClient, userId: string, now: Date): Promise<Overview> {
  await sweepUser(db, userId, now);
  const [sg, pg, vol, rs, rp] = await Promise.all([
    db.checkoutSession.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }),
    db.transaction.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }),
    db.transaction.groupBy({ by: ["currency"], where: { userId, status: "succeeded" }, _sum: { amountMinor: true }, _count: { _all: true } }),
    listCheckoutSessions(db, userId, now, { limit: 5 }),
    listPayments(db, userId, now, { limit: 5 }),
  ]);
  const counts = (g: { status: string; _count: { _all: number } }[]): Counts => Object.fromEntries(g.map((r) => [r.status, r._count._all]));
  return {
    sessions: counts(sg),
    payments: counts(pg),
    succeededVolume: vol.map((v) => ({ currency: v.currency, amount: formatAmount(v._sum.amountMinor ?? 0n, v.currency), count: v._count._all })),
    recentSessions: rs.items.map((s) => sessionDto(s)),
    recentPayments: rp.items.map((r) => paymentDto(r.payment, r.session)),
  };
}

export interface Paged<T> { items: T[]; next: string | null }

export async function sessionsPage(db: PrismaClient, userId: string, now: Date, q: { after?: string; status?: string }): Promise<Paged<SessionRow>> {
  const page = await listCheckoutSessions(db, userId, now, { limit: 20, startingAfter: q.after, status: q.status });
  const items = page.items.map((s) => sessionDto(s));
  return { items, next: page.hasMore ? items[items.length - 1]!.id : null };
}

export async function paymentsPage(db: PrismaClient, userId: string, now: Date, q: { after?: string; status?: string }): Promise<Paged<PaymentRow>> {
  const page = await listPayments(db, userId, now, { limit: 20, startingAfter: q.after, status: q.status });
  const items = page.items.map((r) => paymentDto(r.payment, r.session));
  return { items, next: page.hasMore ? items[items.length - 1]!.id : null };
}

export interface SessionDetail { session: SessionRow; payments: PaymentRow[]; events: { id: string; type: string; created: string }[] }

export async function sessionDetail(db: PrismaClient, userId: string, publicId: string, now: Date): Promise<SessionDetail> {
  const s = await getCheckoutSession(db, userId, publicId, now); // owner-scoped; settles anything due
  const payments = await db.transaction.findMany({ where: { checkoutSessionId: s.id, userId }, orderBy: { seq: "desc" }, take: 50 });
  const subjects = [s.id, ...payments.map((p) => p.id)];
  const events = await db.event.findMany({ where: { userId, subjectId: { in: subjects } }, orderBy: { seq: "desc" }, take: 100, select: { id: true, type: true, createdAt: true } });
  return {
    session: sessionDto(s),
    payments: payments.map((p) => paymentDto(p, s)),
    events: events.map((e) => ({ id: toPublicId("event", e.id), type: e.type, created: e.createdAt.toISOString() })),
  };
}
