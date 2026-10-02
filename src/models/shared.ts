// Small helpers shared by the model files: compiling a model once, and the
// field rules several collections repeat (slugs, Cloudinary ids, file names).
// Schemas, types and validation only; no business logic lives in src/models.

import type { Model, Schema } from "mongoose";

import { mongoose } from "@/lib/db";

/**
 * Compiles a model, or returns the one already compiled under that name.
 * Next.js dev hot reload re-runs model files; compiling the same name twice
 * would throw OverwriteModelError.
 */
export function defineModel<TRaw>(
  name: string,
  schema: Schema<TRaw>,
): Model<TRaw> {
  const existing = mongoose.models[name] as Model<TRaw> | undefined;
  return existing ?? mongoose.model<TRaw>(name, schema);
}

/** URL slugs: lowercase letters and digits in dash-separated words, e.g. "arc-ar-013a". */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A slug field: required, trimmed, lowercased, URL-safe. */
export const slugField = {
  type: String,
  required: true,
  trim: true,
  lowercase: true,
  maxlength: 120,
  match: SLUG_PATTERN,
} as const;

/** A Cloudinary public id (public product, area, leader images only). */
export const publicIdField = {
  type: String,
  trim: true,
  maxlength: 255,
} as const;

/** A short single-line text such as a name, title or label. */
export const shortText = { type: String, trim: true, maxlength: 200 } as const;

/** The only MIME type accepted for datasheets (.xlsx). */
export const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Largest datasheet upload: 10 MB (CLAUDE.md, ADR 0001). */
export const MAX_DATASHEET_BYTES = 10 * 1024 * 1024;
