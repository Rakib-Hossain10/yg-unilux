// Zod schemas for the admin areas module: the create/edit form, an area id and
// a move up/down request. Pure (no server-only), shared by the form resolver
// and re-parsed by src/lib/admin/areas.ts.

import { z } from "zod";

import { MAX_PUBLIC_ID_LENGTH } from "@/lib/constants";

import {
  objectIdSchema,
  optionalPublicIdSchema,
  optionalSlugSchema,
} from "./common";

/** Longest area name; matches the model's `shortText` cap. */
export const MAX_AREA_NAME_LENGTH = 200;

/** Longest Cloudinary public id; matches the model's `publicIdField` cap. */
export const MAX_AREA_BW_IMAGE_LENGTH = MAX_PUBLIC_ID_LENGTH;

/**
 * The area form, used for both create and edit. `order` is not part of the
 * form (new areas go last, the admin reorders with move up/down) and `icon`
 * is left out until its format is decided in Phase 4.
 */
export const areaInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name")
    .max(MAX_AREA_NAME_LENGTH, `At most ${MAX_AREA_NAME_LENGTH} characters`),
  /** "" = generate from the name (create) or keep the current slug (edit). */
  slug: optionalSlugSchema,
  /**
   * Cloudinary public id of the black-and-white image; null = none. Only our
   * id shape is accepted (gate A L-2). The service lets this field keep or
   * clear the stored image; a NEW image is set only through setAreaImage(),
   * which verifies the upload.
   */
  bwImage: optionalPublicIdSchema,
});

/** What the form holds (strings, possibly empty). */
export type AreaFormValues = z.input<typeof areaInputSchema>;
/** What the service works with after parsing. */
export type AreaInput = z.output<typeof areaInputSchema>;

/** One area id, e.g. from a delete button. */
export const areaIdSchema = objectIdSchema;

export const AREA_MOVE_DIRECTIONS = ["up", "down"] as const;
export type AreaMoveDirection = (typeof AREA_MOVE_DIRECTIONS)[number];

/** Move an area one place up or down in the display order. */
export const moveAreaSchema = z.strictObject({
  id: objectIdSchema,
  direction: z.enum(AREA_MOVE_DIRECTIONS),
});
export type MoveAreaInput = z.output<typeof moveAreaSchema>;
