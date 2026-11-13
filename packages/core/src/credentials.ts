import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const CLIENT_ID_PREFIX = "sbx_cid_";
const CLIENT_SECRET_PREFIX = "sbx_sk_";
const WEBHOOK_SECRET_PREFIX = "whsec_";

export interface GeneratedCredentials {
  clientId: string;
  /** Plaintext: show once, never persist. */
  clientSecret: string;
  clientSecretHash: string;
  /** Plaintext: show once; persist only encrypted (see crypto.ts). */
  webhookSecret: string;
}

const b64url = (n: number) => randomBytes(n).toString("base64url");

/** Secrets are 256-bit random values, so a fast hash is sufficient (no password stretching needed). */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function generateCredentials(): GeneratedCredentials {
  const clientSecret = CLIENT_SECRET_PREFIX + b64url(32);
  return {
    clientId: CLIENT_ID_PREFIX + b64url(16),
    clientSecret,
    clientSecretHash: hashSecret(clientSecret),
    webhookSecret: WEBHOOK_SECRET_PREFIX + b64url(32),
  };
}

export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + b64url(32);
}

/** Constant-time comparison of a presented secret against a stored hash. */
export function verifySecret(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(presented), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Safe-to-display hint, e.g. "sbx_sk_…a1b2". */
export function secretHint(secret: string): string {
  return `${secret.slice(0, secret.indexOf("_", 4) + 1)}…${secret.slice(-4)}`;
}

const CHECKOUT_TOKEN_PREFIX = "sbx_cs_";

/** Checkout token: 256-bit random, shown only in the checkout URL; only its SHA-256 is stored. */
export function generateCheckoutToken(): { token: string; tokenHash: string } {
  const token = CHECKOUT_TOKEN_PREFIX + b64url(32);
  return { token, tokenHash: hashSecret(token) };
}
