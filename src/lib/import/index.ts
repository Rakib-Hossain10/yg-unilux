// Service entry points of the bulk import (Phase 3, ADR 0057). T7: the
// preview — read the staged file, plan it against the database, return the
// plan with its hash and the file's ETag. The preview writes NOTHING (no DB
// write, no audit entry, no upload, no revalidation). T8 adds the commit.

import "server-only";

import {
  fieldError,
  formError,
  invalidInput,
  unchanged,
  type ServiceResult,
} from "@/lib/admin/write-result";
import { importFileInputSchema } from "@/lib/schemas/import";
import { getImportBytes, type ImportBytes } from "@/lib/storage";

import { loadPlanLookups, planFromBytes } from "./plan";
import type { ImportPlan, ImportWarning } from "./types";

export type { ImportPlan, PlanEntry, PlanStatus } from "./types";

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
