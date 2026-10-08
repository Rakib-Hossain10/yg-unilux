# 0063 — Catalog data layer: view model, projection from visibility, isolated restricted reader
- Status: Accepted
- Date: 2026-10-08
- Builds on: [0002](0002-restricted-specs-and-caching.md), [0008](0008-caching.md), [0062](0062-catalog-caching-mode.md), [0054](0054-product-page-spec-placement.md).

## Context
Phase 4a needs cached public reads for the product page (ADR 0062: `unstable_cache` + tags, `cacheComponents` off) and one uncached reader of restricted values for the dynamic block. The installed Next 16.3.8 docs (`04-functions/unstable_cache.md`, `02-guides/caching-without-cache-components.md`) say: the result is stored as JSON; the key is the function source + `keyParts` + the JSON of the arguments; `tags` are fixed when the wrapper is created; no `revalidate` = cached until a tag is expired; `headers()`/`cookies()` are not supported inside.

## Decision
1. **Modules** (`src/lib/catalog/`, all `server-only` except `view.ts`):
   - `view.ts` (pure): `PublicProductView`, `PublicVariantView`, `PublicImageView`, `PublicAreaView`, `ProductCardView`, `BreadcrumbItem`; `publicSpecKeys`, `pickSpecs`, `mergeVariantSpecs`, `publicProductProjection`, `PRODUCT_CARD_PROJECTION`, `toPublicProductView`, `toProductCardView`.
   - `product.ts`: `getPublicProduct(slug)`, `listPublishedSlugs()`. `family.ts`: `getFamilyProducts(family, excludeId)`. `related.ts`: `getRelatedProducts(product)`. `categories.ts`: `listPublicCategories()`, `getBreadcrumb(product)`.
   - `restricted.ts`: `getRestrictedSpecs(productId)`, the only site reader of restricted values. No barrel `index.ts` (it could re-export the restricted reader).
2. **Projection from visibility, inclusion only.** The cached product reader reads the column visibility inside its cache entry, then loads only listed paths: identity, images (without `sourceSha256`), variant model no./label/image, extras, `datasheetId`, and `specs.<k>` / `variants.specs.<k>` for public keys. A field nobody listed (filters, status, admin fields, a future column) is never loaded. `pickSpecs` applies the same key list again when building the view (two independent guards). Cards (family, related) project no spec, variant or datasheet path at all.
3. **Plain DTOs.** String ids, ISO dates, `null` for missing optionals, `hasDatasheet: boolean` (the id never reaches cached HTML), images sorted by `order`, areas resolved to `{id, name, slug, bwImage}` in display order. Variant `specs` are already merged (`mergeVariantSpecs`: the variant's non-empty value wins, else the product's; keys absent from both stay absent).
4. **Tags.** `getPublicProduct`: `products`, `areas`, `settings:columns`. Slugs, family and related: `products`. Category index/breadcrumb: `categories`. A slug-keyed entry cannot carry `product:<id>` (tags are fixed before the id is known); every product write already expires `products` (ADR 0041 `tagsFor`, import, settings, category and area edits), so nothing is missed. Invalidation stays in `src/lib/revalidate.ts`; no new tags.
5. **Drafts and unknown slugs** are `null` / left out everywhere; malformed slugs and ids return `null`/`[]` before any query.
6. **Restricted reader.** `getRestrictedSpecs(productId)` checks the id shape, then `getViewer()` + `canSeeRestricted` (null for visitor, banned, expired, temporary password, other roles) **before** any product read, then reads the visibility fresh and projects only restricted keys of a published product. Returns `{productId, keys, specs, variants[{modelNo, specs}]}` (variant values merged, same order as the public view) or `null`. A session read failure is thrown, never turned into "allowed".
7. **Related rule.** Same main category, shares at least one area (main category alone when the product has none), excluding the product itself, its own family (it has its own strip) and drafts; max 8, by sheet NO. then name. Family strip: max 12, same order.
8. **Static guard** (`test/catalog-guards.test.ts`): no catalog module except `restricted.ts` imports permissions/auth/`next/headers`/Better Auth; `restricted.ts` never uses `next/cache`; only `src/app/api/catalog/restricted/[productId]/route.ts` (P7) may import it; no barrel.

## Consequences
- A visibility change expires `settings:columns` at once and so every product entry; the next read re-projects.
- Any product edit expires every product entry (coarse, fine for ~500 products).
- `getColumnVisibility` is imported from `src/lib/admin/settings.ts` by the catalog; moving it to a small shared read module is optional cleanup.
- Migration to `"use cache"` (ADR 0062 "Revisit when") touches only this folder: replace each `unstable_cache` wrapper with `cacheTag` + `cacheLife("max")`, and `product:<id>` could then be added with `cacheTag` after the read.
