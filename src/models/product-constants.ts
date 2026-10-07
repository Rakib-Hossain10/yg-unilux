// Plain product constants (statuses, track sizes, image kinds) with no
// imports, so client form schemas can use them without pulling in the
// database layer.

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
