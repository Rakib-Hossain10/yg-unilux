"use server";

// Server Actions of the bulk import (T9, ADR 0058): presign the upload,
// preview the staged file, save one batch, finish. Each one: requireAdmin()
// first → the import service (which re-parses the input with its strict Zod
// schema) → the shared revalidation helper with the returned tags, on BOTH
// branches → a shaped answer. The preview and commit answers hold sheet
// values (also restricted ones) for the admin's screen only: nothing here
// logs, audits or stores warning text (ADR 0057). The page sets maxDuration.

import { z } from "zod";

import type {
  ActionData,
  ActionFailure,
} from "@/components/admin/action-result";
import {
  toPreviewView,
  type CommitNext,
  type ImportCommitResult,
  type ImportPreviewView,
  type ImportUploadTicket,
} from "@/components/admin/import/import-view";
import type { ServiceErrors, ServiceResult } from "@/lib/admin/write-result";
import { XLSX_MIME_TYPE } from "@/lib/constants";
import {
  commitImportBatch,
  FILE_CHANGED,
  finishImport,
  PREVIEW_AGAIN,
  STAGED_FILE_MESSAGES,
  previewImport,
} from "@/lib/import";
import { requireAdmin } from "@/lib/permissions";
import { revalidateCatalogInAction } from "@/lib/revalidate";
import { presignImportInputSchema } from "@/lib/schemas/import";
import { presignImportUpload } from "@/lib/storage";

/*
 * Every argument is `unknown`: an action is a public POST endpoint. The actor
 * id always comes from the session. No try/catch: requireAdmin() works by
 * throwing, and catching it would let a non-admin call through (ADR 0024).
 */

/* The client's view of a failed call; tags stay on the server. */
function failure(
  result: ServiceResult<unknown> & { ok: false },
): ActionFailure {
  return { ok: false, errors: result.errors, saved: result.tags.length > 0 };
}

/*
 * Where the screen goes after a failed batch. Matched on the service's own
 * exported messages and field names (the service has no error codes yet).
 */
function commitNext(errors: ServiceErrors): CommitNext {
  const fields = Object.keys(errors.fieldErrors);
  if (fields.includes("acknowledgeRemovals")) return "confirm";
  if (fields.includes("defaultCategoryId")) return "upload";
  // The staged file is gone or unusable: only a new upload helps.
  if (
    errors.formErrors.some((m) =>
      Object.values(STAGED_FILE_MESSAGES).includes(m),
    )
  ) {
    return "upload";
  }
  if (
    errors.formErrors.some((m) => m === PREVIEW_AGAIN || m === FILE_CHANGED) ||
    // Hash, batch or plan-shape errors: the preview no longer fits.
    fields.length > 0
  ) {
    return "preview";
  }
  return "retry";
}

/**
 * Step 1: `{fileName, size, contentType}` → a presigned PUT to a
 * server-chosen `imports/<uuid>.xlsx`, always signed as the .xlsx type and
 * the exact size. Nothing is written.
 */
export async function presignImportUploadAction(
  input: unknown,
): Promise<ActionData<ImportUploadTicket>> {
  await requireAdmin();
  const parsed = presignImportInputSchema.safeParse(input);
  if (!parsed.success) {
    // Nothing was signed or written: no tags (the same shape as the
    // services' invalidInput).
    revalidateCatalogInAction([]);
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      errors: { formErrors: flat.formErrors, fieldErrors: flat.fieldErrors },
      saved: false,
    };
  }
  const ticket = await presignImportUpload({
    contentType: XLSX_MIME_TYPE,
    contentLength: parsed.data.size,
  });
  revalidateCatalogInAction([]);
  return {
    ok: true,
    data: {
      uploadUrl: ticket.url,
      headers: ticket.headers,
      key: ticket.key,
      expiresIn: ticket.expiresIn,
    },
  };
}

/**
 * Step 2: `{key, defaultCategoryId}` → the plan of the staged file (or why
 * the whole file was refused). Writes nothing, so there are no tags.
 */
export async function previewImportAction(
  input: unknown,
): Promise<ActionData<ImportPreviewView>> {
  await requireAdmin();
  const result = await previewImport(input);
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  return { ok: true, data: toPreviewView(result.data) };
}

/**
 * Step 3, once per batch: `{key, defaultCategoryId, etag, planHash,
 * entryHashes, batch, acknowledgeRemovals}`. Safe to repeat (done products
 * plan as unchanged). A failure says where the screen goes next.
 */
export async function commitImportBatchAction(
  input: unknown,
): Promise<ImportCommitResult> {
  const viewer = await requireAdmin();
  const result = await commitImportBatch(viewer.user.id, input);
  revalidateCatalogInAction(result.tags);
  if (!result.ok)
    return { ...failure(result), next: commitNext(result.errors) };
  return { ok: true, data: result.data };
}

/** Last step: `{key}` → deletes the staged file (the 24 h sweep is the backstop). */
export async function finishImportAction(
  input: unknown,
): Promise<ActionData<{ deleted: boolean }>> {
  await requireAdmin();
  const result = await finishImport(input);
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  return { ok: true, data: result.data };
}
