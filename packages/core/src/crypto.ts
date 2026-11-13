import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** AES-256-GCM envelope: v1.<iv>.<tag>.<ciphertext>, all base64url. Key = 32 bytes, base64. */
function loadKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function encryptSecret(plaintext: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(keyB64), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), ct].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decryptSecret(envelope: string, keyB64: string): string {
  const [version, iv, tag, ct] = envelope.split(".");
  if (version !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported secret envelope");
  const decipher = createDecipheriv("aes-256-gcm", loadKey(keyB64), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * Purpose-bound authenticated encryption. The AES-256 key is derived from the master key with HKDF-SHA256 using the purpose as
 * context, and the caller's `context` string is authenticated as AAD, so a ciphertext cannot be opened for another purpose,
 * another record, or another owner. Envelope: v2.<iv>.<tag>.<ciphertext>.
 */
function derivePurposeKey(masterB64: string, purpose: string): Buffer {
  const master = loadKey(masterB64);
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `sandbox/v1/${purpose}`, 32));
}

export function sealBound(plaintext: string, masterB64: string, purpose: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivePurposeKey(masterB64, purpose), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v2", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function openBound(envelope: string, masterB64: string, purpose: string, context: string): string {
  const [version, iv, tag, ct] = envelope.split(".");
  if (version !== "v2" || !iv || !tag || !ct) throw new Error("Unsupported secret envelope");
  const decipher = createDecipheriv("aes-256-gcm", derivePurposeKey(masterB64, purpose), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
