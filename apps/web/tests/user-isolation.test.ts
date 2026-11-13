import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, verifySecret } from "@sandbox/core";
import { AppError } from "@/server/errors";
import { createCredential, listCredentials, revokeCredential, rotateCredential } from "@/server/services/credentials";
import { createTestDb, DB_TESTS_ENABLED } from "./harness";

const KEY = randomBytes(32).toString("base64");

describe.skipIf(!DB_TESTS_ENABLED)("user ownership, credentials and audit (real Postgres)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t?.close(); });

  const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof AppError ? e.code : `other:${(e as Error).message}`; } };
  const activeCount = (userId: string) => t.prisma.apiCredential.count({ where: { userId, revokedAt: null } });

  it("cross-user read, rotate and revoke return not_found and change nothing", async () => {
    const a = await t.user(), b = await t.user();
    const issued = await createCredential(t.prisma, a.id, KEY);
    expect(await listCredentials(t.prisma, b.id)).toEqual([]);
    expect(await code(rotateCredential(t.prisma, b.id, issued.credential.id, KEY))).toBe("not_found");
    expect(await code(revokeCredential(t.prisma, b.id, issued.credential.id))).toBe("not_found");
    expect(await activeCount(a.id)).toBe(1);
    expect(await activeCount(b.id)).toBe(0);
    expect((await listCredentials(t.prisma, a.id)).map((c) => c.id)).toEqual([issued.credential.id]);
  });

  it("allows one active credential per user; create after revoke works", async () => {
    const u = await t.user();
    const first = await createCredential(t.prisma, u.id, KEY);
    expect(await code(createCredential(t.prisma, u.id, KEY))).toBe("conflict");
    await revokeCredential(t.prisma, u.id, first.credential.id);
    expect(await code(createCredential(t.prisma, u.id, KEY))).toBe("ok");
  });

  it("concurrent creates: exactly one succeeds, exactly one active row (DB is the final guard)", async () => {
    const u = await t.user();
    const r = await Promise.allSettled(Array.from({ length: 8 }, () => createCredential(t.prisma, u.id, KEY)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const x of r) if (x.status === "rejected") expect((x.reason as AppError).code).toBe("conflict");
    expect(await activeCount(u.id)).toBe(1);
  });

  it("concurrent rotates of one credential: exactly one winner, one active row, old one revoked", async () => {
    const u = await t.user();
    const first = await createCredential(t.prisma, u.id, KEY);
    const r = await Promise.allSettled(Array.from({ length: 6 }, () => rotateCredential(t.prisma, u.id, first.credential.id, KEY)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await activeCount(u.id)).toBe(1);
    const old = await t.prisma.apiCredential.findUniqueOrThrow({ where: { id: first.credential.id } });
    expect(old.revokedAt).not.toBeNull();
  });

  it("racing create / rotate / revoke never yields two active rows", async () => {
    for (let i = 0; i < 5; i++) {
      const u = await t.user();
      const first = await createCredential(t.prisma, u.id, KEY);
      await Promise.allSettled([
        rotateCredential(t.prisma, u.id, first.credential.id, KEY),
        createCredential(t.prisma, u.id, KEY),
        revokeCredential(t.prisma, u.id, first.credential.id),
        rotateCredential(t.prisma, u.id, first.credential.id, KEY),
      ]);
      expect(await activeCount(u.id)).toBeLessThanOrEqual(1);
    }
  });

  it("the index rejects a second active row even for raw SQL; different users are independent", async () => {
    const a = await t.user(), b = await t.user();
    const ins = (uid: string, cid: string) =>
      t.sql("INSERT INTO api_credentials (user_id, client_id, client_secret_hash, client_secret_hint, webhook_secret_enc) VALUES ($1,$2,'h','x','e')", [uid, cid]);
    await ins(a.id, `c-${randomUUID()}`);
    await expect(ins(a.id, `c-${randomUUID()}`)).rejects.toThrow(/api_credentials_one_active_per_user/);
    await expect(ins(b.id, `c-${randomUUID()}`)).resolves.toBeTruthy();
  });

  it("stores only a hash and ciphertext; read paths never expose secret columns", async () => {
    const u = await t.user();
    const issued = await createCredential(t.prisma, u.id, KEY);
    const row = await t.prisma.apiCredential.findUniqueOrThrow({ where: { id: issued.credential.id } });
    expect(JSON.stringify(row)).not.toContain(issued.clientSecret);
    expect(JSON.stringify(row)).not.toContain(issued.webhookSecret);
    expect(verifySecret(issued.clientSecret, row.clientSecretHash)).toBe(true);
    expect(decryptSecret(row.webhookSecretEnc, KEY)).toBe(issued.webhookSecret);
    expect(() => decryptSecret(row.webhookSecretEnc, randomBytes(32).toString("base64"))).toThrow();
    const listed = JSON.stringify(await listCredentials(t.prisma, u.id));
    expect(listed).not.toContain(issued.clientSecret);
    expect(listed).not.toContain(row.clientSecretHash);
    expect(listed).not.toContain(row.webhookSecretEnc);
    expect(JSON.stringify(issued.credential)).not.toContain(issued.clientSecret);
  });

  it("audit rows are written without secrets; UPDATE, DELETE and TRUNCATE are rejected; INSERT works", async () => {
    const u = await t.user();
    const c = await createCredential(t.prisma, u.id, KEY);
    await rotateCredential(t.prisma, u.id, c.credential.id, KEY);
    const logs = await t.prisma.auditLog.findMany({ where: { userId: u.id } });
    expect(logs.map((l) => l.action).sort()).toEqual(["credential.created", "credential.rotated"]);
    expect(JSON.stringify(logs)).not.toMatch(/sbx_sk_|whsec_/);
    await expect(t.sql("UPDATE audit_logs SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(t.sql("DELETE FROM audit_logs")).rejects.toThrow(/append-only/);
    await expect(t.sql("TRUNCATE audit_logs")).rejects.toThrow(/append-only/);
    await expect(t.prisma.auditLog.deleteMany({ where: { userId: u.id } })).rejects.toThrow();
    expect(await t.prisma.auditLog.count({ where: { userId: u.id } })).toBe(2);
  });

  it("account deletion cascades to credentials and keeps audit rows with their user_id", async () => {
    const gone = await t.user(), kept = await t.user();
    await createCredential(t.prisma, gone.id, KEY);
    await createCredential(t.prisma, kept.id, KEY);
    await t.deleteAuthUser(gone.id);
    expect(await t.prisma.apiCredential.count({ where: { userId: gone.id } })).toBe(0);
    expect(await t.prisma.auditLog.count({ where: { userId: gone.id } })).toBe(1);
    expect(await t.prisma.apiCredential.count({ where: { userId: kept.id } })).toBe(1);
  });

  it("schema assertions: partial index, cascading FK only on api_credentials, RLS, guard hardening", async () => {
    const idx = await t.sql("select indexdef from pg_indexes where schemaname = current_schema() and indexname = 'api_credentials_one_active_per_user'");
    expect(idx.rows[0].indexdef).toMatch(/UNIQUE.*\(user_id\).*WHERE.*revoked_at IS NULL/s);
    const fks = await t.sql("select conrelid::regclass::text as tbl, confdeltype from pg_constraint where contype = 'f' and connamespace = current_schema()::regnamespace");
    expect(fks.rows).toEqual([{ tbl: "api_credentials", confdeltype: "c" }]);
    const rls = await t.sql("select relname, relrowsecurity from pg_class where relnamespace = current_schema()::regnamespace and relkind = 'r' order by 1");
    expect(rls.rows.every((r) => r.relrowsecurity === true)).toBe(true);
    const fn = await t.sql("select proconfig from pg_proc where proname = 'sandbox_audit_logs_guard' and pronamespace = current_schema()::regnamespace");
    expect(fn.rows[0].proconfig).toEqual(['search_path=""']);
  });
});
