// Small Zod building blocks shared by the admin form schemas (categories,
// areas, products ...). Pure Zod with no server-only import, so React Hook
// Form on the client and the services on the server parse with the same rules.

import { z } from "zod";

import { PUBLIC_ID_PATTERN } from "@/lib/cloudinary-ids";
import { MAX_PUBLIC_ID_LENGTH } from "@/lib/constants";
import { MAX_SLUG_LENGTH, SLUG_PATTERN } from "@/lib/slug";

/** A MongoDB ObjectId as 24 hex characters, normalised to lowercase. */
export const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/*
 * Ids arrive as strings from forms and action arguments. The strict pattern
 * matters: Mongoose would also cast any 12-character string to an ObjectId.
 */
export const objectIdSchema = z
  .string()
  .trim()
  .regex(OBJECT_ID_PATTERN, "Invalid id")
  .transform((id) => id.toLowerCase());

/**
 * An optional slug typed by the admin. Trimmed and lowercased; "" (or a
 * missing value) means "make one from the name". Anything else must already
 * be a valid slug, so the admin sees exactly the URL that will be saved.
 */
export const optionalSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(MAX_SLUG_LENGTH, `At most ${MAX_SLUG_LENGTH} characters`)
  .refine((slug) => slug === "" || SLUG_PATTERN.test(slug), {
    message: "Use lowercase letters and digits separated by single hyphens",
  })
  .optional()
  .transform((slug) => slug ?? "");

const PUBLIC_ID_MESSAGE = "Not an image uploaded through this site";

/**
 * A Cloudinary public id in our server-chosen shape
 * (`yg/<folder>/<ownerId>/<uuid>`, see src/lib/cloudinary-ids.ts). Only the
 * shape is checked here; which owner it belongs to and whether the upload
 * passed verification are service checks.
 */
export const publicIdSchema = z
  .string()
  .trim()
  .max(MAX_PUBLIC_ID_LENGTH, PUBLIC_ID_MESSAGE)
  .regex(PUBLIC_ID_PATTERN, PUBLIC_ID_MESSAGE);

/** An optional public id: "" (or missing) means "no image" and becomes null. */
export const optionalPublicIdSchema = z
  .string()
  .trim()
  .max(MAX_PUBLIC_ID_LENGTH, PUBLIC_ID_MESSAGE)
  .refine((id) => id === "" || PUBLIC_ID_PATTERN.test(id), {
    message: PUBLIC_ID_MESSAGE,
  })
  .optional()
  .transform((id) => (id === undefined || id === "" ? null : id));

/**
 * Optional free text such as a description. Trimmed; "" (or missing) means
 * "no value", which the services store by removing the field.
 */
export function optionalTextSchema(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength, `At most ${maxLength} characters`)
    .optional()
    .transform((text) => (text === undefined || text === "" ? null : text));
}
