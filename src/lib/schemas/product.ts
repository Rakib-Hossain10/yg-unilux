// Zod schemas for the admin product form (identity, categories, specs, filter
// numbers, variants, extra specs, public files) plus publishCheck(). Pure (no
// server-only): the form resolver and src/lib/admin/products.ts parse alike.

import { z } from "zod";

import {
  MAX_EXTRA_CATEGORIES,
  MAX_EXTRA_SPEC_GROUP_LENGTH,
  MAX_EXTRA_SPEC_LABEL_LENGTH,
  MAX_EXTRA_SPEC_VALUE_LENGTH,
  MAX_EXTRA_SPECS,
  MAX_FILTER_NUMBER,
  MAX_FILTER_VALUES,
  MAX_IMAGE_ALT_LENGTH,
  MAX_MODEL_NO_LENGTH,
  MAX_PRODUCT_AREAS,
  MAX_PRODUCT_DESCRIPTION_LENGTH,
  MAX_PRODUCT_FAMILY_LENGTH,
  MAX_PRODUCT_IMAGES,
  MAX_PRODUCT_MODEL_CODE_LENGTH,
  MAX_PRODUCT_NAME_LENGTH,
  MAX_PRODUCT_TYPE_LENGTH,
  MAX_PUBLIC_FILE_LABEL_LENGTH,
  MAX_PUBLIC_FILE_URL_LENGTH,
  MAX_PUBLIC_FILES,
  MAX_SPEC_OPTIONS,
  MAX_SPEC_VALUE_LENGTH,
  MAX_VARIANT_LABEL_LENGTH,
  MAX_VARIANTS,
} from "@/lib/constants";
import {
  PRODUCT_IMAGE_KINDS,
  PRODUCT_STATUSES,
  TRACK_SIZES,
} from "@/models/product-constants";
import { SPEC_KEYS, type SpecKey } from "@/models/spec-columns";

import {
  objectIdSchema,
  optionalPublicIdSchema,
  optionalSlugSchema,
  optionalTextSchema,
  publicIdSchema,
} from "./common";

/** A required, trimmed single-line text with a cap. */
function requiredText(label: string, maxLength: number) {
  return z
    .string()
    .trim()
    .min(1, `Enter ${label}`)
    .max(maxLength, `At most ${maxLength} characters`);
}

/*
 * One spec cell: a list of English display strings (several = options shown
 * as chips). Blank entries are dropped, so a cleared input behaves like an
 * absent one; an emptied list is removed from `specs` below.
 */
const specValuesSchema = z
  .array(
    z
      .string()
      .trim()
      .max(
        MAX_SPEC_VALUE_LENGTH,
        `At most ${MAX_SPEC_VALUE_LENGTH} characters`,
      ),
  )
  .max(MAX_SPEC_OPTIONS, `At most ${MAX_SPEC_OPTIONS} options`)
  .transform((values) => values.filter((value) => value !== ""));

/*
 * The spec object: exactly the 28 fixed keys, all optional, unknown keys
 * refused (a restricted column is projected away by key, so keys must stay
 * fixed). Keys left empty are stripped from the output, matching the model's
 * "missing key = not applicable".
 */
const specsShape = Object.fromEntries(
  SPEC_KEYS.map((key) => [key, specValuesSchema.optional()]),
) as Record<SpecKey, z.ZodOptional<typeof specValuesSchema>>;

/** Spec values for the product (shared) or one variant (differences only). */
export const specsInputSchema = z
  .strictObject(specsShape)
  .transform((specs) => {
    const kept: Partial<Record<SpecKey, string[]>> = {};
    for (const key of SPEC_KEYS) {
      const values = specs[key];
      if (values !== undefined && values.length > 0) kept[key] = values;
    }
    return kept;
  });

/** The numbers behind the listing filters, parsed from the display strings. */
const filterNumbersSchema = z
  .array(
    z
      .number()
      .finite("Enter a number")
      .min(0, "Must not be negative")
      .max(MAX_FILTER_NUMBER, `At most ${MAX_FILTER_NUMBER}`),
  )
  .max(MAX_FILTER_VALUES, `At most ${MAX_FILTER_VALUES} values`)
  .optional();

const FILTER_KEYS = ["cctK", "cri", "beamDeg", "ugr", "wattage", "ip"] as const;

/** Filter numbers per filter; empty or missing lists are left out. */
export const filtersInputSchema = z
  .strictObject({
    cctK: filterNumbersSchema,
    cri: filterNumbersSchema,
    beamDeg: filterNumbersSchema,
    ugr: filterNumbersSchema,
    wattage: filterNumbersSchema,
    ip: filterNumbersSchema,
  })
  .transform((filters) => {
    const kept: Partial<Record<(typeof FILTER_KEYS)[number], number[]>> = {};
    for (const key of FILTER_KEYS) {
      const numbers = filters[key];
      if (numbers !== undefined && numbers.length > 0) kept[key] = numbers;
    }
    return kept;
  });

/** One variant (sheet row). `modelNo` is only trimmed (ADR 0019). */
export const variantInputSchema = z.strictObject({
  modelNo: requiredText("a model no.", MAX_MODEL_NO_LENGTH),
  /** Shown on the optic switch, e.g. "Regular lens". */
  label: optionalTextSchema(MAX_VARIANT_LABEL_LENGTH),
  /** Only the values that differ from the product-level specs. */
  specs: specsInputSchema.optional().transform((specs) => specs ?? {}),
  /**
   * Cloudinary public id of this variant's own image; null = none. Must be in
   * our id shape here; the service also requires it to be one of the
   * product's own saved `images` (gate B L-C).
   */
  imagePublicId: optionalPublicIdSchema,
});

/** Extra info outside the sheet. Always public. */
export const extraSpecInputSchema = z.strictObject({
  group: optionalTextSchema(MAX_EXTRA_SPEC_GROUP_LENGTH),
  label: requiredText("a label", MAX_EXTRA_SPEC_LABEL_LENGTH),
  value: requiredText("a value", MAX_EXTRA_SPEC_VALUE_LENGTH),
});

/*
 * A public download link. These render on public pages, so only https is
 * accepted, and links with embedded credentials are refused.
 */
const httpsUrlSchema = z
  .string()
  .trim()
  .max(
    MAX_PUBLIC_FILE_URL_LENGTH,
    `At most ${MAX_PUBLIC_FILE_URL_LENGTH} characters`,
  )
  .refine(
    (value) => {
      if (!/^https:\/\/\S+$/.test(value)) return false;
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.username === "" &&
          url.password === ""
        );
      } catch {
        // Not a parseable URL: refused below by returning false.
        return false;
      }
    },
    { message: "Enter a full https:// link" },
  );

export const publicFileInputSchema = z.strictObject({
  label: requiredText("a label", MAX_PUBLIC_FILE_LABEL_LENGTH),
  url: httpsUrlSchema,
});

/** A list of ids (categories, areas) with a cap and no repeats. */
function idList(maxItems: number) {
  return z
    .array(objectIdSchema)
    .max(maxItems, `At most ${maxItems} entries`)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Remove the duplicate entries",
    })
    .default([]);
}

/*
 * The product form. Left out on purpose because the server controls them:
 * `images` (own save action with verified Cloudinary ids and order), `featured`
 * (not in the Phase 2 form), `_id` and timestamps. Strict objects refuse any
 * other key, so a crafted request cannot mass-assign them.
 */
export const productInputSchema = z
  .strictObject({
    name: requiredText("a name", MAX_PRODUCT_NAME_LENGTH),
    /** "" = generate from family + model code / name (create) or keep (edit). */
    slug: optionalSlugSchema,
    modelCode: optionalTextSchema(MAX_PRODUCT_MODEL_CODE_LENGTH),
    /** The sheet's Model Name, for the "More from ..." strip. */
    family: optionalTextSchema(MAX_PRODUCT_FAMILY_LENGTH),
    /** The sheet's NO.; null = none. */
    productNo: z
      .number()
      .int("Must be a whole number")
      .min(1, "Must be at least 1")
      .max(MAX_FILTER_NUMBER)
      .nullish()
      .transform((no) => no ?? null),
    /** The sheet's Model Type. */
    type: optionalTextSchema(MAX_PRODUCT_TYPE_LENGTH),
    description: optionalTextSchema(MAX_PRODUCT_DESCRIPTION_LENGTH),
    mainCategory: objectIdSchema,
    extraCategories: idList(MAX_EXTRA_CATEGORIES),
    areas: idList(MAX_PRODUCT_AREAS),
    /** Magnetic Track only; whether the category allows it is a service check. */
    trackSize: z
      .union(TRACK_SIZES.map((size) => z.literal(size)))
      .nullish()
      .transform((size) => size ?? null),
    specs: specsInputSchema.optional().transform((specs) => specs ?? {}),
    filters: filtersInputSchema
      .optional()
      .transform((filters) => filters ?? {}),
    variants: z
      .array(variantInputSchema)
      .max(MAX_VARIANTS, `At most ${MAX_VARIANTS} variants`)
      .default([]),
    extraSpecs: z
      .array(extraSpecInputSchema)
      .max(MAX_EXTRA_SPECS, `At most ${MAX_EXTRA_SPECS} entries`)
      .default([]),
    publicFiles: z
      .array(publicFileInputSchema)
      .max(MAX_PUBLIC_FILES, `At most ${MAX_PUBLIC_FILES} files`)
      .default([]),
    /** The attached restricted datasheet; null = "Datasheet coming soon". */
    datasheetId: objectIdSchema.nullish().transform((id) => id ?? null),
    status: z.enum(PRODUCT_STATUSES).default("draft"),
  })
  .superRefine((product, ctx) => {
    // The model also rejects this, but the admin should see which row repeats.
    // Case-insensitive so "ar-013a1" and "AR-013A1" cannot both be saved.
    const seen = new Set<string>();
    product.variants.forEach((variant, index) => {
      const key = variant.modelNo.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["variants", index, "modelNo"],
          message: "This model no. is already used by another variant",
        });
      }
      seen.add(key);
    });
  });

/** What the form holds. */
export type ProductFormValues = z.input<typeof productInputSchema>;
/** What the service works with after parsing. */
export type ProductInput = z.output<typeof productInputSchema>;
export type VariantInput = z.output<typeof variantInputSchema>;
export type ExtraSpecInput = z.output<typeof extraSpecInputSchema>;
export type PublicFileInput = z.output<typeof publicFileInputSchema>;

/** One product id, e.g. from a delete or publish button. */
export const productIdSchema = objectIdSchema;

/** One image in the images editor: which upload, its alt text and its kind. */
export const productImageInputSchema = z.strictObject({
  publicId: publicIdSchema,
  alt: requiredText("alt text", MAX_IMAGE_ALT_LENGTH),
  kind: z.enum(PRODUCT_IMAGE_KINDS),
});

/**
 * The images editor's save: the FULL ordered list (position = display
 * order). Sending the whole list makes add, remove and reorder one idempotent
 * call. Which ids are allowed and whether new uploads pass verification are
 * checked by saveProductImages().
 */
export const productImagesInputSchema = z.strictObject({
  productId: objectIdSchema,
  images: z
    .array(productImageInputSchema)
    .max(MAX_PRODUCT_IMAGES, `At most ${MAX_PRODUCT_IMAGES} images`)
    .refine(
      (images) => new Set(images.map((i) => i.publicId)).size === images.length,
      { message: "The same image is in the list twice" },
    ),
});
export type ProductImageInput = z.output<typeof productImageInputSchema>;
export type ProductImagesInput = z.output<typeof productImagesInputSchema>;

/** One reason a product cannot be published yet. */
export interface PublishProblem {
  field: "variants" | "mainCategory" | "images";
  message: string;
}

/**
 * The stored facts publishing depends on. Images are not in the form, so the
 * service passes the saved product (or counts), never client input.
 */
export interface PublishCheckInput {
  mainCategory?: unknown;
  variants: readonly unknown[];
  images: readonly unknown[];
}

/**
 * Lists everything blocking a publish (ADR 0019): at least one variant, a main
 * category and at least one image. A draft may be incomplete, so this is not
 * part of productInputSchema. Empty list = ready to publish.
 */
export function publishCheck(product: PublishCheckInput): PublishProblem[] {
  const problems: PublishProblem[] = [];
  if (product.variants.length === 0) {
    problems.push({
      field: "variants",
      message: "Add at least one variant (model no.)",
    });
  }
  const category = product.mainCategory;
  if (category === undefined || category === null || category === "") {
    problems.push({ field: "mainCategory", message: "Choose a main category" });
  }
  if (product.images.length === 0) {
    problems.push({ field: "images", message: "Add at least one image" });
  }
  return problems;
}
