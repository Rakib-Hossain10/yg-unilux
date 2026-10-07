// Service entry points of the bulk import (Phase 3, ADR 0057 + 0061): the
// preview (reads the staged file, plans it, writes NOTHING), the commit of
// one batch (re-plans the same file, checks the preview's hashes, writes,
// audits, returns tags) and finishImport (deletes the staged file).

import "server-only";

import { tagsFor } from "@/lib/admin/products";
import {
  assertActorId,
  auditAndFinish,
  fieldError,
  formError,
  invalidInput,
  unchanged,
  type ServiceResult,
} from "@/lib/admin/write-result";
import { uniqueTags } from "@/lib/revalidate";
import {
  commitImportInputSchema,
  finishImportInputSchema,
  importFileInputSchema,
  importIdFromKey,
} from "@/lib/schemas/import";
import {
  deleteImportUpload,
  getImportBytes,
  StorageConditionError,
  type ImportBytes,
} from "@/lib/storage";

import { commitPlanBatch, type CommitBatchResult } from "./commit";
import { loadPlanLookups, planFromBytes } from "./plan";
import type { ImportPlan, ImportWarning } from "./types";

export type { ImportPlan, PlanEntry, PlanStatus } from "./types";
export type {
  CommitBatchResult,
  CommitBatchSummary,
  CommittedProduct,
  CommittedStatus,
} from "./commit";
export { COMMIT_ERRORS, batchCount } from "./commit";

/**
 * The preview: either the plan, or the file was refused as a whole (fatal
 * warnings; nothing to preview). `etag` identifies the staged version read;
 * the commit pins its read to it (`getImportBytes(key, {ifMatch})`).
 */
export type ImportPreview =
  | { kind: "plan"; etag: string | null; plan: ImportPlan }
  | { kind: "refused"; warnings: ImportWarning[] };

/** Shown when the default category was deleted after the page loaded. */
export const DEFAULT_CATEGORY_GONE =
  "This category no longer exists. Choose another one.";

const STAGED_FILE_MESSAGES: Record<
  Extract<ImportBytes, { ok: false }>["reason"],
  string
> = {
  not_found:
    "The uploaded file is no longer available (it expires after 24 hours). Upload it again.",
  too_large: "The uploaded file is too large. Upload a smaller file.",
  empty: "The uploaded file is empty. Upload it again.",
};

/**
 * Plans the staged import file `input.key` with `input.defaultCategoryId`
 * as the default main category. The caller (the Server Action) has already
 * run `requireAdmin()`. Returns `unchanged(...)`: no tags, nothing to
 * revalidate, because nothing was written.
 */
export async function previewImport(
  input: unknown,
): Promise<ServiceResult<ImportPreview>> {
  const parsed = importFileInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { key, defaultCategoryId } = parsed.data;

  const lookups = await loadPlanLookups();
  if (!lookups.categories.some((c) => c.id === defaultCategoryId)) {
    return fieldError("defaultCategoryId", DEFAULT_CATEGORY_GONE);
  }

  const staged = await getImportBytes(key);
  if (!staged.ok) return formError(STAGED_FILE_MESSAGES[staged.reason]);

  const result = await planFromBytes(staged.bytes, {
    ...lookups,
    defaultCategoryId,
  });
  if (result.kind === "refused") {
    return unchanged({ kind: "refused", warnings: result.warnings });
  }
  // `result.files` (the picture bytes) is dropped here: the commit re-plans.
  return unchanged({
    kind: "plan",
    etag: staged.etag ?? null,
    plan: result.plan,
  });
}

/** The file, the database or a setting changed since the preview. */
export const PREVIEW_AGAIN =
  "The file, the products or the settings changed since the preview. Preview the file again.";

/** The staged file was replaced after the preview (ETag mismatch). */
export const FILE_CHANGED =
  "The uploaded file changed after the preview. Preview the file again.";

/** A batch removes variants and the admin did not confirm it. */
export const REMOVALS_NOT_CONFIRMED =
  "Confirm that the listed variants may be removed, then save again.";

const NO_SUCH_BATCH = "There is no such batch. Preview the file again.";

/**
 * Saves batch `input.batch` (IMPORT_BATCH_SIZE products) of the previewed
 * import (ADR 0061). The caller (the Server Action) has already run
 * `requireAdmin()`; `actorId` is the admin's user id from the session.
 *
 * Re-reads exactly the previewed file (`ifMatch` = the preview's ETag),
 * re-plans it, proves the preview's entry hashes with its planHash, and
 * saves the batch's create/update entries that still plan as previewed.
 * One `import.commit` audit entry per batch that wrote something (counts and
 * ids only); the tags of every written product come back for the ONE
 * revalidation helper (`revalidateCatalogInAction`). Safe to re-run: done
 * products plan as unchanged and are skipped.
 */
export async function commitImportBatch(
  actorId: string,
  input: unknown,
): Promise<ServiceResult<CommitBatchResult>> {
  assertActorId(actorId);
  const parsed = commitImportInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { key, defaultCategoryId, etag, ...commit } = parsed.data;

  const lookups = await loadPlanLookups();
  if (!lookups.categories.some((c) => c.id === defaultCategoryId)) {
    return fieldError("defaultCategoryId", DEFAULT_CATEGORY_GONE);
  }

  let staged: ImportBytes;
  try {
    staged = await getImportBytes(key, etag === null ? {} : { ifMatch: etag });
  } catch (error) {
    if (error instanceof StorageConditionError) return formError(FILE_CHANGED);
    throw error;
  }
  if (!staged.ok) return formError(STAGED_FILE_MESSAGES[staged.reason]);

  const planned = await planFromBytes(staged.bytes, {
    ...lookups,
    defaultCategoryId,
  });
  // The previewed file was not refused; a refusal now means it is not it.
  if (planned.kind === "refused") return formError(PREVIEW_AGAIN);

  const outcome = await commitPlanBatch({
    plan: planned.plan,
    sheetHash: planned.sheetHash,
    files: planned.files,
    input: commit,
  });
  switch (outcome.kind) {
    case "stale":
      return formError(PREVIEW_AGAIN);
    case "needs_ack":
      return fieldError("acknowledgeRemovals", REMOVALS_NOT_CONFIRMED);
    case "bad_batch":
      return fieldError("batch", NO_SUCH_BATCH);
  }

  const { result, written } = outcome;
  // Nothing written (a re-run, or only failures): no audit, no tags.
  if (written.length === 0) return unchanged(result);
  const tags = uniqueTags(
    written.flatMap((product) => tagsFor(product.id, product.published)),
  );
  const { summary } = result;
  return auditAndFinish(
    {
      actorId,
      action: "import.commit",
      // The key passed importKeySchema, so it has an id.
      target: { type: "import", id: importIdFromKey(key) as string },
      // Counts and ids only, never values or warning text (ADR 0057).
      meta: {
        batch: result.batch,
        created: summary.created,
        updated: summary.updated,
        unchanged: summary.unchanged,
        blocked: summary.blocked,
        failed: summary.failed,
        imagesAdded: summary.imagesAdded,
        variantsRemoved: summary.variantsRemoved,
        productIds: written.map((product) => product.id),
      },
    },
    result,
    tags,
  );
}

/**
 * The last step: deletes the staged file. The caller has already run
 * `requireAdmin()`. A failed delete is not an error for the admin (the 24 h
 * sweep removes it anyway), so it reports `deleted: false` instead.
 */
export async function finishImport(
  input: unknown,
): Promise<ServiceResult<{ deleted: boolean }>> {
  const parsed = finishImportInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    await deleteImportUpload(parsed.data.key);
  } catch (error) {
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[import] staged file delete failed: ${kind}`);
    return unchanged({ deleted: false });
  }
  return unchanged({ deleted: true });
}
