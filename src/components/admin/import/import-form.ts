// Step 1 of the import (T9): the form's Zod schema, built from the same
// schemas the server re-runs (`presignImportInputSchema` for the file,
// `defaultCategoryIdSchema` for the category; src/lib/schemas/import.ts is
// pure Zod), and the PUT of the file to the presigned URL. Client-safe.

import { z } from "zod";

import {
  defaultCategoryIdSchema,
  presignImportInputSchema,
} from "@/lib/schemas/import";
import { MAX_IMPORT_BYTES } from "@/lib/constants";

import { putDatasheet } from "../datasheet-upload";
import { formatBytes, type UploadOutcome } from "../image-upload";
import type { ImportUploadTicket } from "./import-view";

export const IMPORT_ACCEPT =
  ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const IMPORT_RULES_TEXT = `An Excel .xlsx file filled from the template, up to ${formatBytes(MAX_IMPORT_BYTES)}.`;

/** The presign request for a chosen file (what the server re-validates). */
export function presignInputFor(file: {
  name: string;
  size: number;
  type: string;
}) {
  return { fileName: file.name, size: file.size, contentType: file.type };
}

/*
 * The file must pass the server's presign schema. Only a courtesy here: the
 * server re-parses it, signs the exact size and type, and checks the file's
 * signature and zip structure before reading anything.
 */
const fileSchema = z
  .custom<File | null>((value) => value === null || value instanceof Blob, {
    message: "Choose an Excel file",
  })
  .superRefine((file, ctx) => {
    if (file === null) {
      ctx.addIssue({ code: "custom", message: "Choose an Excel file" });
      return;
    }
    const parsed = presignImportInputSchema.safeParse(presignInputFor(file));
    if (!parsed.success) {
      ctx.addIssue({
        code: "custom",
        message:
          parsed.error.issues[0]?.message ?? "This file can't be imported",
      });
    }
  });

export const importFormSchema = z.object({
  file: fileSchema,
  defaultCategoryId: z
    .string()
    .min(1, "Choose a default category")
    .pipe(defaultCategoryIdSchema),
});
export type ImportFormValues = z.input<typeof importFormSchema>;

/**
 * PUTs the file to the presigned URL with exactly the signed Content-Type,
 * reporting whole percents (XMLHttpRequest: fetch has no upload progress).
 * Never logs: the URL is signed.
 */
export function putImportFile(
  ticket: ImportUploadTicket,
  file: Blob,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  return putDatasheet(ticket, file, onProgress, signal);
}
