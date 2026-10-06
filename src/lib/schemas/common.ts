// Small Zod building blocks shared by the admin form schemas (categories,
// areas, products ...). Pure Zod with no server-only import, so React Hook
// Form on the client and the services on the server parse with the same rules.

import { z } from "zod";

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
