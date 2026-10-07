# 0041 — Product service
- Status: Accepted
- Date: 2026-10-06

## Context
T8 adds `src/lib/admin/products.ts` (list, edit read, draft, update, publish/unpublish, delete) on the ADR 0035 write path.

## Decision
1. **trackSize rule:** allowed only when the main or an extra category is Magnetic Track or one of its children. Magnetic Track = a root category with slug `magnetic-track` or that name (case-insensitive). Anything else gives a `trackSize` field error.
2. **Publish gate:** `status: "published"` and `publishProduct` run `publishCheck` on the new mainCategory/variants plus the stored images; refusal returns field errors. Setting the status a product already has is `unchanged`.
3. **Duplicate `modelNo`:** an explicit pre-check against other products plus the Mongo 11000 fallback both give `variants.N.modelNo`; a slug 11000 gives `slug`. The main category may not also appear in `extraCategories`.
4. **List:** input comes from the URL, so bad values fall back to defaults instead of erroring. `q` is trimmed, cut to 80 characters and regex-escaped; it matches name, slug, family, modelCode and `variants.modelNo`. The projection has list fields only, never specs. 25 per page.
5. **Tags:** a draft returns only `products` and `product:<id>`. Anything that is or was published also expires `categories` and `areas`. `datasheets` is not expired on a `datasheetId` change because admin datasheet counts are uncached (revisit if cached).
6. **Audit:** a status-only update is `product.publish`/`product.unpublish`; other changes are `product.update`. Meta holds ids, field names and counts only. Updates write only changed fields and never touch images (T11b).

## Consequences
- T9/T10 forms must map both Zod errors (nested under `variants`) and the service's `variants.N.modelNo`.
- The cross-product `modelNo` check is exact-match, like the index.
