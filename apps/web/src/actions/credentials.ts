"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db";
import { requireUser } from "@/server/session";
import { createCredential, listCredentials, revokeCredential, rotateCredential } from "@/server/services/credentials";
import { serverEnv } from "@/lib/env";
import type { ActionResult } from "@/lib/types/common";
import type { CredentialView, IssuedCredential } from "@/lib/types/credential";
import { credentialIdInput } from "./schemas";
import { fail, invalid } from "./utils";

export async function getCredentials(): Promise<ActionResult<CredentialView[]>> {
  try {
    const user = await requireUser();
    return { ok: true, data: await listCredentials(db(), user.id) };
  } catch (e) {
    return fail(e);
  }
}

export async function createCredentialAction(): Promise<ActionResult<IssuedCredential>> {
  try {
    const user = await requireUser({ verified: true });
    const data = await createCredential(db(), user.id, serverEnv().SECRETS_ENCRYPTION_KEY);
    revalidatePath("/credentials");
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}

export async function rotateCredentialAction(input: unknown): Promise<ActionResult<IssuedCredential>> {
  const p = credentialIdInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    const data = await rotateCredential(db(), user.id, p.data.credentialId, serverEnv().SECRETS_ENCRYPTION_KEY);
    revalidatePath("/credentials");
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}

export async function revokeCredentialAction(input: unknown): Promise<ActionResult> {
  const p = credentialIdInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  try {
    const user = await requireUser({ verified: true });
    await revokeCredential(db(), user.id, p.data.credentialId);
    revalidatePath("/credentials");
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e);
  }
}
