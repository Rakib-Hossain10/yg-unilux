// Zod schemas for the admin categories module: the create/edit form, a
// category id, a move up/down request and the icon/cover image uploads. Pure (no server-only), shared by
// the React Hook Form resolver and re-parsed by src/lib/admin/categories.ts.

import { z } from "zod";

import { CATEGORY_COVER_FORMATS, CATEGORY_ICON_FORMATS } from "@/lib/constants";

import {
  objectIdSchema,
  optionalPublicIdSchema,
  optionalSlugSchema,
  optionalTextSchema,
} from "./common";

/** Longest category name; matches the model's `shortText` cap. */
export const MAX_CATEGORY_NAME_LENGTH = 200;

/** Longest category description; matches the model's cap. */
export const MAX_CATEGORY_DESCRIPTION_LENGTH = 2000;

/*
 * The parent picker sends "" for "none (main category)". Both "" and null
 * become null, which the model stores for a main category.
 */
const parentSchema = z
  .union([objectIdSchema, z.literal(""), z.null()])
  .optional()
  .transform((parent) =>
    parent === undefined || parent === "" ? null : parent,
  );

/**
 * The category form, used for both create and edit. Tree rules that need the
 * database (depth, slug free under the parent, no cycles) are checked by the
 * service, not here. `order` is not part of the form: new categories go last
 * and the admin reorders with move up/down.
 */
export const categoryInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name")
    .max(
      MAX_CATEGORY_NAME_LENGTH,
      `At most ${MAX_CATEGORY_NAME_LENGTH} characters`,
    ),
  /** "" = generate from the name (create) or keep the current slug (edit). */
  slug: optionalSlugSchema,
  /** null = a main category. */
  parent: parentSchema,
  /** null = no description. */
  description: optionalTextSchema(MAX_CATEGORY_DESCRIPTION_LENGTH),
});

/** What the form holds (strings, possibly empty). */
export type CategoryFormValues = z.input<typeof categoryInputSchema>;
/** What the service works with after parsing. */
export type CategoryInput = z.output<typeof categoryInputSchema>;

/** One category id, e.g. from a delete button. */
export const categoryIdSchema = objectIdSchema;

export const MOVE_DIRECTIONS = ["up", "down"] as const;
export type MoveDirection = (typeof MOVE_DIRECTIONS)[number];

/** Move a category one place up or down among its siblings. */
export const moveCategorySchema = z.strictObject({
  id: objectIdSchema,
  direction: z.enum(MOVE_DIRECTIONS),
});
export type MoveCategoryInput = z.output<typeof moveCategorySchema>;

/**
 * The two images a category can have: the mega-menu `icon` and the `cover`
 * (stored in the model's `icon` / `coverImage`).
 */
export const CATEGORY_IMAGE_SLOTS = ["icon", "cover"] as const;
export type CategoryImageSlot = (typeof CATEGORY_IMAGE_SLOTS)[number];

/** The Cloudinary formats each slot accepts (signed and re-checked). */
export const CATEGORY_IMAGE_FORMATS: Record<
  CategoryImageSlot,
  readonly string[]
> = {
  icon: CATEGORY_ICON_FORMATS,
  cover: CATEGORY_COVER_FORMATS,
};

/** Sign one direct upload for a category's icon or cover. */
export const signCategoryImageSchema = z.strictObject({
  categoryId: objectIdSchema,
  slot: z.enum(CATEGORY_IMAGE_SLOTS),
});

/** Set (a verified new upload) or clear (null / "") a category image. */
export const setCategoryImageSchema = z.strictObject({
  categoryId: objectIdSchema,
  slot: z.enum(CATEGORY_IMAGE_SLOTS),
  publicId: optionalPublicIdSchema.nullable().transform((id) => id ?? null),
});
export type SetCategoryImageInput = z.output<typeof setCategoryImageSchema>;
