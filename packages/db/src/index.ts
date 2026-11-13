import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

export * from "./generated/client";
export * from "./identity";

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

/** Server-side only. Runtime uses DATABASE_URL (transaction pooler); the worker passes WORKER_DATABASE_URL. */
export function getPrisma(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  if (process.env.NODE_ENV === "production") return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return (globalForPrisma.__prisma ??= new PrismaClient({ adapter: new PrismaPg({ connectionString }) }));
}

/** Explicit factory (worker and test harness). `max` caps the connection pool. */
export function createPrismaClient(connectionString: string, opts: { schema?: string; max?: number } = {}): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, ...(opts.max ? { max: opts.max } : {}) }, opts.schema ? { schema: opts.schema } : undefined) });
}
