"use server";

// Server Actions for the categories module: create, edit, move up/down and
// delete. Each one: requireAdmin() first → the T4 service with the admin's id
// → revalidate the returned tags on every branch → redirect last (ADR 0035).

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import type { ActionResult } from "@/components/admin/action-result";
import { CATEGORIES_PATH } from "@/components/admin/category-paths";
import { withNotice } from "@/components/admin/save-notice";
import {
  createCategory,
  deleteCategory,
  moveCategory,
  updateCategory,
} from "@/lib/admin/categories";
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

/** Creates a category, then goes back to the tree with a "created" notice. */
export async function createCategoryAction(
  values: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await createCategory(viewer.user.id, values);
  // Both branches: on an audit failure the category is already saved.
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  redirect(withNotice(CATEGORIES_PATH, "created"));
}

/** Saves the edit form, then goes back to the tree. */
export async function updateCategoryAction(
  id: unknown,
  values: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await updateCategory(viewer.user.id, id, values);
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  // An edit that changed nothing returns no tags: say so instead of "saved".
  redirect(
    withNotice(
      CATEGORIES_PATH,
      result.tags.length === 0 ? "unchanged" : "updated",
    ),
  );
}

/**
 * Moves a category one place up or down. Stays on the tree (no redirect, so
 * keyboard focus stays on the button); refresh() re-renders it because the
 * admin tree is read uncached, outside any cache tag.
 */
export async function moveCategoryAction(
  id: unknown,
  direction: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await moveCategory(viewer.user.id, { id, direction });
  revalidateCatalogInAction(result.tags);
  // Tags mean something was written, even when the audit step then failed.
  if (result.tags.length > 0) refresh();
  if (!result.ok) return failure(result);
  return { ok: true };
}

/**
 * Deletes a category. When it still has subcategories or products, nothing
 * is deleted and the reasons come back for the tree to show.
 */
export async function deleteCategoryAction(id: unknown): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await deleteCategory(viewer.user.id, id);
  revalidateCatalogInAction(result.tags);
  if (!result.ok) {
    // Deleted but not audited: the tree must drop the row anyway.
    if (result.tags.length > 0) refresh();
    return failure(result);
  }
  redirect(withNotice(CATEGORIES_PATH, "deleted"));
}
