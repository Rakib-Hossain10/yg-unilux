"use server";

// Server Actions for the areas module: create, edit, move up/down, delete,
// and the b/w image uploader (sign an upload, set or clear the image).
// Each one: requireAdmin() first → the T6a service with the admin's id →
// revalidate the returned tags on every branch → redirect last (ADR 0035).

import { refresh } from "next/cache";
import { forbidden, redirect } from "next/navigation";

import type {
  ActionData,
  ActionFailure,
  ActionResult,
} from "@/components/admin/action-result";
import { AREAS_PATH } from "@/components/admin/area-paths";
import type { SignedImageUpload } from "@/components/admin/image-upload";
import { withNotice } from "@/components/admin/save-notice";
import {
  createArea,
  deleteArea,
  moveArea,
  setAreaImage,
  updateArea,
} from "@/lib/admin/areas";
import { signCloudinaryUpload } from "@/lib/admin/uploads";
import type { ServiceResult } from "@/lib/admin/write-result";
import { requireAdmin } from "@/lib/permissions";
import { revalidateCatalogInAction } from "@/lib/revalidate";

import { pageActor } from "../admin-reads";

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
function failure(
  result: ServiceResult<unknown> & { ok: false },
): ActionFailure {
  // A refused actor is a 403, never a form message (ADR 0073).
  if (result.denied) forbidden();
  return { ok: false, errors: result.errors, saved: result.tags.length > 0 };
}

/** Creates an area, then goes back to the list with a "created" notice. */
export async function createAreaAction(values: unknown): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await createArea(await pageActor(viewer), values);
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
  const result = await updateArea(await pageActor(viewer), id, values);
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
  const result = await moveArea(await pageActor(viewer), { id, direction });
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
  const result = await deleteArea(await pageActor(viewer), id);
  revalidateCatalogInAction(result.tags);
  if (!result.ok) {
    // Deleted but not audited: the list must drop the row anyway.
    if (result.tags.length > 0) refresh();
    return failure(result);
  }
  redirect(withNotice(AREAS_PATH, "deleted"));
}

/**
 * Signs one direct browser upload of an area's b/w image (ADR 0045), under
 * this area's own folder. Nothing is written (no tags).
 */
export async function signAreaImageUpload(
  areaId: unknown,
): Promise<ActionData<SignedImageUpload>> {
  const viewer = await requireAdmin();
  const result = await signCloudinaryUpload(await pageActor(viewer), {
    target: "area",
    id: areaId,
  });
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  return { ok: true, data: result.data };
}

/**
 * Sets (`{areaId, publicId}`, a verified new upload) or clears
 * (`{areaId, publicId: null}`) an area's b/w image. Stays on the edit page;
 * refresh() re-renders it with the stored image.
 */
export async function setAreaImageAction(
  input: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await setAreaImage(await pageActor(viewer), input);
  revalidateCatalogInAction(result.tags);
  if (result.tags.length > 0) refresh();
  if (!result.ok) return failure(result);
  return { ok: true };
}
