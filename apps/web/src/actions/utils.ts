import "server-only";
import { z } from "zod";
import { ApiError, AppError } from "@/server/errors";
import type { ActionResult } from "@/lib/types/common";

export function fail(error: unknown): ActionResult<never> {
  if (error instanceof AppError || error instanceof ApiError) return { ok: false, error: error.message }; // both carry client-safe messages
  console.error("action failed", error instanceof Error ? error.name : "unknown"); // no payloads: they may contain secrets
  return { ok: false, error: "Something went wrong" };
}

export function invalid(err: z.ZodError): ActionResult<never> {
  const fieldErrors: Record<string, string> = {};
  for (const i of err.issues) fieldErrors[String(i.path[0] ?? "form")] ??= i.message;
  return { ok: false, error: "Please fix the highlighted fields", fieldErrors };
}
