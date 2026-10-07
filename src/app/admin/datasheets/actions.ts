"use server";

// Server Actions for the datasheets module (T13): presign an upload, finalize
// it (new or replace), rename and delete. Each one: requireAdmin() first → the
// T12 service with the admin's id → revalidate the returned tags on every
// branch → refresh() so the uncached admin list re-renders (ADR 0047).
// Nothing here ever returns a storage key or a public URL: the only URL is the
// short-lived presigned PUT to `incoming/`, handed to the browser once.

import { refresh } from "next/cache";

import type {
  ActionData,
  ActionFailure,
  ActionResult,
} from "@/components/admin/action-result";
import type { DatasheetUploadTicket } from "@/components/admin/datasheet-upload";
import {
  deleteDatasheet,
  finalizeDatasheet,
  presignDatasheetUpload,
  renameDatasheet,
} from "@/lib/admin/datasheets";
import type { ServiceResult } from "@/lib/admin/write-result";
import { requireAdmin } from "@/lib/permissions";
import { revalidateCatalogInAction } from "@/lib/revalidate";

/*
 * Every argument is `unknown`: an action is a public POST endpoint, so the
 * browser can send anything. The services re-parse it with the same strict
 * Zod schemas the forms use. The actor id always comes from the session.
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
  // Tags mean something was written, even when the audit step then failed.
  if (result.tags.length > 0) refresh();
  if (!result.ok) return failure(result);
  return { ok: true };
}

/**
 * Step 1 of an upload: validates `{fileName, size}` and returns a presigned
 * PUT to a server-chosen `incoming/` key. Nothing is written (no tags).
 */
export async function presignDatasheetUploadAction(
  input: unknown,
): Promise<ActionData<DatasheetUploadTicket>> {
  const viewer = await requireAdmin();
  const result = await presignDatasheetUpload(viewer.user.id, input);
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  return { ok: true, data: result.data };
}

/**
 * Step 3: `{mode: "new"|"replace", incomingKey, fileName, datasheetId?}`. The
 * service verifies the file's content and always removes the incoming object.
 */
export async function finalizeDatasheetAction(
  input: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  return writeResult(await finalizeDatasheet(viewer.user.id, input));
}

/** Renames a datasheet (the label only; the stored file is untouched). */
export async function renameDatasheetAction(
  input: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  return writeResult(await renameDatasheet(viewer.user.id, input));
}

/**
 * Deletes a datasheet. While products use it nothing is deleted and the
 * refusal ("3 products use this datasheet...") comes back as formErrors[0].
 */
export async function deleteDatasheetAction(
  id: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  return writeResult(await deleteDatasheet(viewer.user.id, id));
}
