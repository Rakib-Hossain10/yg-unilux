"use server";

// Server Actions for Settings (T15): the column visibility switches, the
// WhatsApp number and the company email. Each one: requireAdmin() first → the
// T14 service with the admin's id (it validates with Zod and audits) →
// revalidate the returned tags on both branches → refresh() so the uncached
// settings page re-renders (ADR 0049, 0050).
//
// The audit entries hold no number and no address, only whether one is set.

import { refresh } from "next/cache";

import type {
  ActionFailure,
  ActionResult,
} from "@/components/admin/action-result";
import {
  saveColumnVisibility,
  saveCompanyEmail,
  saveWhatsappNumber,
} from "@/lib/admin/settings";
import type { ServiceResult } from "@/lib/admin/write-result";
import { requireAdmin } from "@/lib/permissions";
import { revalidateCatalogInAction } from "@/lib/revalidate";

/*
 * Every argument is `unknown`: an action is a public POST endpoint, so the
 * browser can send anything. The services re-parse it with the same Zod
 * schemas the forms use. The actor id always comes from the session.
 *
 * No try/catch and no redirect: requireAdmin() works by throwing, and catching
 * it would let a non-admin call through (ADR 0024).
 */

/* The client's view of a failed call; tags stay on the server. */
function failure(
  result: ServiceResult<unknown> & { ok: false },
): ActionFailure {
  return { ok: false, errors: result.errors, saved: result.tags.length > 0 };
}

/* Shared tail of the write actions (both branches revalidate). */
function writeResult(result: ServiceResult<unknown>): ActionResult {
  revalidateCatalogInAction(result.tags);
  // Tags mean something was written (or the cleanup changed products).
  if (result.tags.length > 0) refresh();
  if (!result.ok) return failure(result);
  return { ok: true };
}

/**
 * Saves which of the 28 spec columns are restricted. Columns newly made
 * restricted also lose their filter numbers on every product (ADR 0049).
 */
export async function saveColumnVisibilityAction(
  input: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  return writeResult(await saveColumnVisibility(viewer.user.id, input));
}

/** Saves the WhatsApp number ("" clears it). */
export async function saveWhatsappNumberAction(
  input: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  return writeResult(await saveWhatsappNumber(viewer.user.id, input));
}

/** Saves the company email ("" clears it; the env value is used then). */
export async function saveCompanyEmailAction(
  input: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  return writeResult(await saveCompanyEmail(viewer.user.id, input));
}
