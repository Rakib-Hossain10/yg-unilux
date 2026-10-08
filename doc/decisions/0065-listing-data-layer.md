# 0065 — Listing data layer: URL params, scope, filters, cache keys
- Status: Accepted
- Date: 2026-10-08
- Phase 4b, task L1 (`c09ae39`). Plan: `doc/phase-4b-plan.md` Q1–Q6.

## Context
Listing pages (`/products`, `/products/<main>/<sub>`, `/areas/<slug>`) render on request (they read `searchParams`) with data from `unstable_cache` (ADR 0062). Filters are crawlable URLs, so the cache key must be bounded and restricted columns must never surface as facets (rule 9, ADR 0002/0063).

## Decision
1. **URL params** (`src/lib/catalog/listing-params.ts`, pure, client-safe): `cct, cri, beam, ugr, w, ip, track, cat, sort, page`. Lists accept commas or repeated keys (GET forms), are deduped, sorted, capped at 12. Numbers are plain decimals (≤ 2 places) within bounds (cct 1000–20000, cri 0–100, beam 0–360, ugr 0–40, ip 0–99). Wattage buckets `0-10`, `11-20`, `21-40`, `41+` as (gt, lte] ranges. `cat` = main-category slugs (area pages only). `sort` = `catalog | name | newest`; `page` 1–1000, invalid → 1. Junk is dropped, the parser never throws, inherited keys are never read. Canonical order: cat, track, cct, cri, beam, ugr, w, ip, sort, page; defaults omitted.
2. **Category path:** `/products/<main>/<sub>` resolved on the cached tree (`category-path.ts`), because sub-category slugs are unique only among siblings. Depth-bounded and cycle-safe.
3. **Scope rule:** published products whose `mainCategory` OR `extraCategories` is in the category's subtree. Area scope = `areas` contains the area; `cat` narrows it to the chosen main categories' subtrees with the same rule.
4. **Filter semantics:** OR within a facet, AND across. Wattage uses `$elemMatch` per bucket. `track` → `trackSize`, only when every scope id is under a Magnetic Track main category. Facet counts cover the whole scope (other active filters not applied). Options = values with count ≥ 1, ≤ 50 per facet, only values the parser accepts back.
5. **Restricted columns, three guards:** the page's parse, a re-parse inside `listProducts`/`getFacets` with the passed visibility, and inside the cache the facet set is derived only from the restricted keys in the key argument. Visibility is read once per request with `getCatalogVisibility()` (uncached) and passed as a cache argument (gate-A M-1 pattern).
6. **Cache keys:** normalised scope (known ids only, sorted, lowercased), restricted keys in sheet order, canonical filter string, chosen subtree ids; sort and page for the card reader. Count and page are cached separately, so a page past the end never creates an entry (the page answers 404 when `page > pageCount`). Unknown scope ids → empty result, no query. Tags: `products`, `categories`, `areas`, `settings:columns`; the area list on `areas`.
7. **Sort:** catalog = products with a NO. first, then `productNo`, lowercased name, `_id`; name = lowercased name, `_id`; newest = `createdAt` desc, `_id` desc. (Strips in `family.ts`/`related.ts` put products without NO. first; listings put them last.)
8. **Cards:** `ListingCardView` = `ProductCardView` + `variantCount` (`$size` in the aggregation); no spec data is ever loaded. Page size 24; `pageCount` ≥ 1.
9. **Indexes:** none added; `{status, mainCategory}`, `{extraCategories}`, `{areas}` cover the scope clauses. Revisit if query plans on real data show collection scans.

## Consequences
- Filtered URLs are shareable and work without JS; a crawler can create only a bounded set of cache entries.
- Category headers need `description`/`coverImage` in the cached tree (L3/L4; bump `CATALOG_CACHE_VERSION`).
- Facet labels (`facetValueLabel`, `FACET_LABELS`) are defaults the frontend may restyle.
- Known nit: a facet with > 50 values could lose valid options to over-precise ones before the cut; unlikely with real data.
