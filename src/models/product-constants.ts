// Plain product constants (statuses, track sizes, image kinds, the model no.
// rule) with no imports, so client form schemas and the importer can use them
// without pulling in the database layer.

export const PRODUCT_STATUSES = ["draft", "published"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/** Magnetic Track sizes in mm; a listing filter for that category only. */
export const TRACK_SIZES = [5, 10, 20] as const;
export type TrackSize = (typeof TRACK_SIZES)[number];

/** What a product image shows; the product page groups images by kind. */
export const PRODUCT_IMAGE_KINDS = [
  "gallery",
  "dimension",
  "installation",
] as const;
export type ProductImageKind = (typeof PRODUCT_IMAGE_KINDS)[number];

/*
 * Model numbers (ADR 0055). Text is stored exactly as typed, but two model
 * nos. that differ only by case ("AR-013A1" / "ar-013a1") are the SAME model
 * no., inside one product and across products. MongoDB enforces this with
 * this collation on the unique `variants.modelNo` index; every query that
 * looks up model nos. must pass the same collation so it matches the index
 * (and can use it). The Phase 3 importer reuses these two helpers.
 */
export const MODEL_NO_COLLATION = { locale: "en", strength: 2 } as const;

/* Code points ICU collation ignores entirely (soft hyphen, zero-width space). */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * The comparison key for a model no., matching MODEL_NO_COLLATION in practice:
 * trimmed (like the schema), NFKC (full-width letters, ligatures), lowercased,
 * ignorable code points removed. Accents stay significant, as at strength 2,
 * and so does "ß" vs "ss" (a secondary difference in ICU; checked against
 * MongoDB in model-no.test.ts). ICU can still differ on exotic scripts; model
 * nos. are ASCII codes, and the unique index has the final word.
 */
export function modelNoKey(modelNo: string): string {
  return modelNo
    .trim()
    .normalize("NFKC")
    .replace(IGNORABLE, "")
    .toLocaleLowerCase("en");
}

/** True when two model nos. count as the same one (see modelNoKey). */
export function sameModelNo(a: string, b: string): boolean {
  return modelNoKey(a) === modelNoKey(b);
}
