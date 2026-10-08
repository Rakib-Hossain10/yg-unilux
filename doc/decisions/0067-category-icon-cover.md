# 0067 — Category icon, cover and description
- Status: Accepted
- Date: 2026-10-08
- Phase 4b, task L3 (`e2ba3a1`). Plan Q7. Adds to ADR 0045/0046/0051.

## Decision
1. **Icon = a Cloudinary image** (PNG, SVG or WebP) stored as a public id in `Category.icon` (now `publicIdField`, like `coverImage`). SVG lives only on Cloudinary and is always delivered with an explicit raster format (`f_png`/`f_webp`), never `f_auto` (it could serve the SVG original) and never inlined. Raw SVG, data URIs and URLs are refused by Zod and the model.
2. **Cover** (optional): JPG, PNG or WebP. **Description:** plain text, trimmed, ≤ 2000, blank removes it; rendered as text (`whitespace-pre-line`), never HTML.
3. **Uploads** reuse the direct-upload pattern (ADR 0045): upload target `category`, folder `yg/categories/<categoryId>/<uuid>`, slot (`icon` | `cover`) in the sign and save input, `overwrite=false`, server verification with per-call format lists (`signImageUpload`, `inspectImage`, `signCloudinaryUpload`, `verifyUploadedImage`; defaults unchanged for products/areas). 10 MB cap (`MAX_IMAGE_BYTES`). The owner check is exhaustive per target.
4. **Tags and audit:** an image write expires `categories` only; audit `category.update` with meta `{fields:[field], cleared}`.
5. **Sweep:** `SWEPT_CLOUDINARY_FOLDERS` is derived from `IMAGE_UPLOAD_FOLDERS`, so a new upload target is always swept; category icon/cover ids count as referenced.
6. **UI:** `SingleImageUploader` is the shared one-image uploader for areas and categories (adds to ADR 0046 §9). Category edit page: form, icon (square preview), cover (16:9 preview).
7. **Public view:** `PublicCategoryView` gains `icon`, `coverImage`, `description` (null when unset); `CATALOG_CACHE_VERSION` is now **v3** (supersedes the "v2" in ADR 0063 §10).

## Consequences
- Mega-menu without an icon shows the name only. Icon render: e.g. `w_96,h_96,c_fit,f_png,q_auto` for a 48 px slot; check whether `src/components/site/cloudinary-image.ts` forces `f_auto` and add a format option if so.
- Cover render: `c_fill,g_auto,f_auto,q_auto`, responsive widths, layout must work without a cover.
- The client still has to supply the icons.
