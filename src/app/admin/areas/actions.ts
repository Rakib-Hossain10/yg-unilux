"use server";

// Server Actions for the areas module: create, edit, move up/down and delete.
// Each one: requireAdmin() first → the T6a service with the admin's id →
// revalidate the returned tags on every branch → redirect last (ADR 0035).

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import type { ActionResult } from "@/components/admin/action-result";
import { AREAS_PATH } from "@/components/admin/area-paths";
import { withNotice } from "@/components/admin/save-notice";
import {
  createArea,
  deleteArea,
  moveArea,
  updateArea,
} from "@/lib/admin/areas";
import type { ServiceResult } from "@/lib/admin/write-result";
import { requireAdmin } from "@/lib/permissions";
import { revalidateCatalogInAction } from "@/lib/revalidate";

/*
 * Every argument is `unknown`: an action is a public POST endpoint, so the
 * browser can send anything. The services re-parse it with the same strict
 * Zod schemas the forms use. The actor id always comes from the session.
 *
 * None of these use try/catch: requireAdmin() and redirect() work by
 * throwing, and catching them would let a non-admin call through (ADR 0024).
 */

/*
 * The client's view of a failed service call. Tags stay on the server;
 * `saved` tells the form the write happened (audit failure) so it does not
 * offer to submit the same values again.
 */
function failure(result: ServiceResult<unknown> & { ok: false }): ActionResult {
  return { ok: false, errors: result.errors, saved: result.tags.length > 0 };
}

/** Creates an area, then goes back to the list with a "created" notice. */
export async function createAreaAction(values: unknown): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await createArea(viewer.user.id, values);
  // Both branches: on an audit failure the area is already saved.
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  redirect(withNotice(AREAS_PATH, "created"));
}

/** Saves the edit form, then goes back to the list. */
export async function updateAreaAction(
  id: unknown,
  values: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await updateArea(viewer.user.id, id, values);
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  // An edit that changed nothing returns no tags: say so instead of "saved".
  redirect(
    withNotice(AREAS_PATH, result.tags.length === 0 ? "unchanged" : "updated"),
  );
}

/**
 * Moves an area one place up or down. Stays on the list (no redirect, so
 * keyboard focus stays on the button); refresh() re-renders it because the
 * admin list is read uncached, outside any cache tag.
 */
export async function moveAreaAction(
  id: unknown,
  direction: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await moveArea(viewer.user.id, { id, direction });
  revalidateCatalogInAction(result.tags);
  // Tags mean something was written, even when the audit step then failed.
  if (result.tags.length > 0) refresh();
  if (!result.ok) return failure(result);
  return { ok: true };
}

/**
 * Deletes an area. While products still use it, nothing is deleted and the
 * reason comes back for the list to show.
 */
export async function deleteAreaAction(id: unknown): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await deleteArea(viewer.user.id, id);
  revalidateCatalogInAction(result.tags);
  if (!result.ok) {
    // Deleted but not audited: the list must drop the row anyway.
    if (result.tags.length > 0) refresh();
    return failure(result);
  }
  redirect(withNotice(AREAS_PATH, "deleted"));
}
