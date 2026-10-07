// App-wide limits and storage locations used by the admin panel, the upload
// checks and the models. Pure values with no server-only import, so client
// forms can run the same size and format checks the server re-runs.

/**
 * Category tree depth: main categories (depth 1) and their subcategories
 * (depth 2). A subcategory may not have children of its own (Phase 2 plan).
 */
export const MAX_CATEGORY_DEPTH = 2;

/** Largest datasheet upload: 10 MB (CLAUDE.md, ADR 0001). */
export const MAX_DATASHEET_BYTES = 10 * 1024 * 1024;

/** The only MIME type accepted for datasheets (.xlsx); the file signature is checked too. */
export const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Largest product/area image upload: 10 MB (Phase 2 plan). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Image formats accepted for Cloudinary uploads, as Cloudinary reports them
 * in `format` (it says "jpg" for JPEG files). Sent as `allowed_formats` in the
 * signed upload and re-checked after upload.
 */
export const ALLOWED_IMAGE_FORMATS = ["jpg", "png", "webp", "avif"] as const;
export type AllowedImageFormat = (typeof ALLOWED_IMAGE_FORMATS)[number];

/** Cloudinary folder for product images: `yg/products/<productId>/<uuid>`. */
export const CLOUDINARY_PRODUCT_FOLDER = "yg/products";

/** Cloudinary folder for area images: `yg/areas/<areaId>/<uuid>`. */
export const CLOUDINARY_AREA_FOLDER = "yg/areas";

/** Most images one product may have (gallery, dimension and installation). */
export const MAX_PRODUCT_IMAGES = 30;

/** Longest image alt text; matches the model's `shortText` cap. */
export const MAX_IMAGE_ALT_LENGTH = 200;

/*
 * R2 key prefixes in the private bucket (ADR 0009). The browser uploads a
 * datasheet to `incoming/` with a presigned PUT; the server verifies it and
 * copies it to `datasheets/`. Anything left in `incoming/` is an abandoned
 * upload and is swept after a day.
 */
export const R2_INCOMING_PREFIX = "incoming/";
export const R2_DATASHEETS_PREFIX = "datasheets/";

/*
 * Product form caps. String lengths mirror the maxlength values in
 * src/models/product.ts (a longer value would be rejected by Mongoose anyway);
 * the array caps are ours, so one request cannot carry an unbounded document.
 */
export const MAX_PRODUCT_NAME_LENGTH = 200;
export const MAX_PRODUCT_FAMILY_LENGTH = 100;
export const MAX_PRODUCT_TYPE_LENGTH = 100;
export const MAX_PRODUCT_MODEL_CODE_LENGTH = 64;
export const MAX_PRODUCT_DESCRIPTION_LENGTH = 5000;
export const MAX_MODEL_NO_LENGTH = 64;
export const MAX_VARIANT_LABEL_LENGTH = 100;
export const MAX_PUBLIC_ID_LENGTH = 255;
export const MAX_SPEC_VALUE_LENGTH = 500;
export const MAX_SPEC_OPTIONS = 20;
export const MAX_FILTER_VALUES = 50;
export const MAX_FILTER_NUMBER = 1_000_000;
export const MAX_EXTRA_CATEGORIES = 20;
export const MAX_PRODUCT_AREAS = 20;
export const MAX_VARIANTS = 200;
export const MAX_EXTRA_SPECS = 100;
export const MAX_EXTRA_SPEC_GROUP_LENGTH = 100;
export const MAX_EXTRA_SPEC_LABEL_LENGTH = 100;
export const MAX_EXTRA_SPEC_VALUE_LENGTH = 1000;
export const MAX_PUBLIC_FILES = 20;
export const MAX_PUBLIC_FILE_LABEL_LENGTH = 200;
export const MAX_PUBLIC_FILE_URL_LENGTH = 2048;

/*
 * Datasheet (.xlsx) checks. A real workbook has a few dozen zip entries; the
 * cap stops a crafted archive with a huge central directory. The two XML
 * parts we read are tiny, so their declared size is capped too.
 */
export const MAX_XLSX_ENTRIES = 2000;
export const MAX_XLSX_PART_BYTES = 1024 * 1024;

/*
 * Bulk import (Phase 3). The client's sheet is uploaded as-is, so the import
 * file has its own, larger caps than a datasheet. src/lib/import/safety.ts
 * checks all of them on the zip directory (and a counting inflate) before
 * exceljs inflates anything, so a zip bomb never reaches the parser.
 */
/** Largest import file: 30 MB (Phase 3 decision 5). */
export const MAX_IMPORT_BYTES = 30 * 1024 * 1024;
/** Most zip entries an import file may have (the client's sheet has 28). */
export const MAX_IMPORT_ENTRIES = 5000;
/** Most bytes all entries of an import file may inflate to, in total. */
export const MAX_IMPORT_UNCOMPRESSED_BYTES = 300 * 1024 * 1024;
/** Highest uncompressed:compressed ratio one entry may have. */
export const MAX_IMPORT_COMPRESSION_RATIO = 100;
/*
 * The ratio cap applies only to entries that inflate past this size: a tiny
 * XML part can compress 200:1 and is harmless; a bomb needs volume.
 */
export const IMPORT_RATIO_MIN_BYTES = 1024 * 1024;
/** The header row is searched for in the first rows of each sheet. */
export const IMPORT_HEADER_SCAN_ROWS = 15;
/*
 * Embedded pictures (src/lib/import/images.ts). The drawing and relationship
 * parts are read with this output cap (a drawing is ~1 KB per picture, so
 * 16 MB is thousands of pictures). A picture larger than MAX_IMAGE_BYTES is
 * never inflated; one above this many pixels is flagged before upload
 * (Cloudinary's free plan refuses images above 25 megapixels).
 */
export const MAX_IMPORT_XML_PART_BYTES = 16 * 1024 * 1024;
export const MAX_IMPORT_IMAGE_PIXELS = 25_000_000;
