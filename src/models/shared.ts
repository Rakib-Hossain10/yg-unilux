// Small helpers shared by the model files: compiling a model once, and the
// field rules several collections repeat (slugs, Cloudinary ids, file names).
// Schemas, types and validation only; no business logic lives in src/models.

import type { Model, Schema } from "mongoose";

import { mongoose } from "@/lib/db";
import { MAX_SLUG_LENGTH, SLUG_PATTERN } from "@/lib/slug";

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

/**
 * A slug field: required, trimmed, lowercased, URL-safe. The pattern and cap
 * live in src/lib/slug.ts so `slugify` and the schema can never disagree.
 */
export const slugField = {
  type: String,
  required: true,
  trim: true,
  lowercase: true,
  maxlength: MAX_SLUG_LENGTH,
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
