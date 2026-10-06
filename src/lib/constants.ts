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

/*
 * R2 key prefixes in the private bucket (ADR 0009). The browser uploads a
 * datasheet to `incoming/` with a presigned PUT; the server verifies it and
 * copies it to `datasheets/`. Anything left in `incoming/` is an abandoned
 * upload and is swept after a day.
 */
export const R2_INCOMING_PREFIX = "incoming/";
export const R2_DATASHEETS_PREFIX = "datasheets/";
