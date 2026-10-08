// Zod schemas for the bulk import inputs (Phase 3, T6; T7-T9 extend them).
// Pure Zod, no server-only import, so the import page can run the same checks
// the server re-runs. The staged key is the one the server handed out.

import { z } from "zod";

import {
  IMPORT_BATCH_SIZE,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_PLAN_ENTRIES,
  R2_IMPORTS_PREFIX,
  XLSX_MIME_TYPE,
} from "@/lib/constants";

import { objectIdSchema } from "./common";
import { datasheetFileNameSchema } from "./datasheet";

const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/**
 * `imports/<uuid v4>.xlsx`: where the browser's presigned import PUT lands.
 * The dot is written `\\.` because in a template literal `\.` is just `.`
 * (Phase 2 gate C L-1). The uuid is captured: it is the import's id in the
 * audit log (target type `import`).
 */
export const IMPORT_KEY_PATTERN = new RegExp(
  `^${R2_IMPORTS_PREFIX}(${UUID_V4})\\.xlsx$`,
);

export const importKeySchema = z
  .string()
  .regex(IMPORT_KEY_PATTERN, "Not an upload made through this site");

/** The uuid of a staged import key, or null when the key is not one of ours. */
export function importIdFromKey(key: string): string | null {
  return IMPORT_KEY_PATTERN.exec(key)?.[1] ?? null;
}

/*
 * The type the browser reports for the chosen file. Some browsers report ""
 * or "application/octet-stream" for an .xlsx (no spreadsheet app installed),
 * so those are accepted; anything that names another type (.xlsm, .csv, .xls)
 * is refused. It is only a hint: the PUT is always signed as XLSX_MIME_TYPE
 * and the file signature and zip are checked on the server before any read.
 */
const ACCEPTED_BROWSER_TYPES = [
  XLSX_MIME_TYPE,
  "",
  "application/octet-stream",
] as const;

/** Step 1: ask for a presigned upload of the import file. */
export const presignImportInputSchema = z.strictObject({
  /** Display only (shown back to the admin); the object key never uses it. */
  fileName: datasheetFileNameSchema,
  size: z
    .number()
    .int("The size must be whole bytes")
    .min(1, "The file is empty")
    .max(
      MAX_IMPORT_BYTES,
      `The file is larger than ${MAX_IMPORT_BYTES / (1024 * 1024)} MB`,
    ),
  contentType: z.enum(ACCEPTED_BROWSER_TYPES, {
    error: "The file must be an Excel .xlsx file",
  }),
});
export type PresignImportInput = z.infer<typeof presignImportInputSchema>;

/**
 * The category a product goes to when its Category cell is empty or unknown.
 * Only the id shape is checked here; the service confirms it exists.
 */
export const defaultCategoryIdSchema = objectIdSchema;

/**
 * Preview (and, with more fields, commit): which staged file, and the
 * default category. T7 extends this object; it stays strict so an unknown
 * field is refused rather than ignored.
 */
export const importFileInputSchema = z.strictObject({
  key: importKeySchema,
  defaultCategoryId: defaultCategoryIdSchema,
});
export type ImportFileInput = z.infer<typeof importFileInputSchema>;

/** A sha256 in lowercase hex, as the plan reports its hashes. */
const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Preview the file again");

/**
 * One commit batch (ADR 0061): the staged file, the default category and
 * what the preview returned (the file's ETag, `plan.planHash` and every
 * entry's `hash`, in plan order), which batch of IMPORT_BATCH_SIZE entries
 * to save, and whether the admin confirmed the variant removals.
 */
export const commitImportInputSchema = z
  .strictObject({
    key: importKeySchema,
    defaultCategoryId: defaultCategoryIdSchema,
    /** The preview's `etag`; null when storage reported none. */
    etag: z.string().min(1).max(200).nullable(),
    planHash: sha256HexSchema,
    entryHashes: z
      .array(sha256HexSchema)
      .min(1, "Preview the file again")
      .max(MAX_IMPORT_PLAN_ENTRIES, "This file has too many products"),
    batch: z
      .number()
      .int()
      .min(0)
      .max(Math.ceil(MAX_IMPORT_PLAN_ENTRIES / IMPORT_BATCH_SIZE) - 1),
    acknowledgeRemovals: z.boolean(),
  })
  // The batch must exist in the previewed plan (the service re-checks it
  // against the plan it rebuilds).
  .refine(
    (input) => input.batch * IMPORT_BATCH_SIZE < input.entryHashes.length,
    {
      path: ["batch"],
      message: "Preview the file again",
    },
  );
export type CommitImportInput = z.infer<typeof commitImportInputSchema>;

/** The last step: delete the staged file. */
export const finishImportInputSchema = z.strictObject({ key: importKeySchema });
