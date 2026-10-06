// Plain product constants (statuses, track sizes) with no imports, so client
// form schemas can use them without pulling in the database layer.

export const PRODUCT_STATUSES = ["draft", "published"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/** Magnetic Track sizes in mm; a listing filter for that category only. */
export const TRACK_SIZES = [5, 10, 20] as const;
export type TrackSize = (typeof TRACK_SIZES)[number];
