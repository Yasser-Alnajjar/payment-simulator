import { z } from "zod";

const schema = z.object({
  APP_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_URL: z.url().default("http://localhost:3100"),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SECRETS_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64"),
});

/**
 * Public base URL used to build checkout / auth links.
 * An explicit APP_URL wins, except a localhost value while running on Vercel
 * (e.g. a copied local .env). On Vercel we fall back to its system env vars:
 * the production domain for production deploys, otherwise the branch/deployment URL.
 */
function resolveAppUrl(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.APP_URL?.trim();
  const onVercel = !!env.VERCEL;
  const isLocal = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(u);
  if (explicit && !(onVercel && isLocal(explicit))) return explicit;
  if (onVercel) {
    const host =
      (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL) ||
      env.VERCEL_BRANCH_URL ||
      env.VERCEL_URL;
    if (host) return `https://${host}`;
  }
  return explicit;
}

export type ServerEnv = z.infer<typeof schema>;
let cached: ServerEnv | undefined;

/** Server-side only. Throws a clear error listing invalid variables (never their values). */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse({ ...process.env, APP_URL: resolveAppUrl(process.env) });
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration: ${names}`);
  }
  cached = parsed.data;
  return cached;
}
