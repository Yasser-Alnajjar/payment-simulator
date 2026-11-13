import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, generateCredentials, hashSecret, secretHint, verifySecret } from "./index";

describe("credentials", () => {
  it("generates unique, prefixed secrets and a matching hash", () => {
    const a = generateCredentials();
    const b = generateCredentials();
    expect(a.clientSecret).not.toBe(b.clientSecret);
    expect(a.clientId.startsWith("sbx_cid_")).toBe(true);
    expect(a.clientSecretHash).toBe(hashSecret(a.clientSecret));
    expect(a.clientSecretHash).not.toContain(a.clientSecret);
  });
  it("verifies only the right secret", () => {
    const c = generateCredentials();
    expect(verifySecret(c.clientSecret, c.clientSecretHash)).toBe(true);
    expect(verifySecret(c.clientSecret + "x", c.clientSecretHash)).toBe(false);
    expect(verifySecret("", c.clientSecretHash)).toBe(false);
    expect(verifySecret(c.clientSecret, "zz")).toBe(false);
  });
  it("hint never reveals the secret", () => {
    const c = generateCredentials();
    expect(secretHint(c.clientSecret).length).toBeLessThan(16);
  });
});

describe("encryption", () => {
  const key = randomBytes(32).toString("base64");
  it("round-trips and uses a fresh IV", () => {
    const e1 = encryptSecret("whsec_abc", key);
    const e2 = encryptSecret("whsec_abc", key);
    expect(e1).not.toBe(e2);
    expect(decryptSecret(e1, key)).toBe("whsec_abc");
  });
  it("rejects tampering and wrong keys", () => {
    const e = encryptSecret("whsec_abc", key);
    expect(() => decryptSecret(e.slice(0, -2) + "AA", key)).toThrow();
    expect(() => decryptSecret(e, randomBytes(32).toString("base64"))).toThrow();
    expect(() => encryptSecret("x", "short")).toThrow();
  });
});
