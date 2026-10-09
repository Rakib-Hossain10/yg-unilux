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

## Addendum (2026-10-08, QA gate A fixes)
- **Unknown filter values never reach a cache key (gate-A M-1).** `narrowToKnownValues` in `listProducts` checks each value against the scope's cached facet values (`knownFilterValues`, same cache entry as `getFacets`, no new keys). Unknown values next to a known one in the same facet are dropped from `params` and the key (OR within a facet, so the result is the same). If every selected value of a facet is unknown, the answer is an uncached empty result (`total: 0`, `pageCount: 1`, no count query) that **keeps** the requested values in `params`, so the chips show which filter emptied the listing. `cat` is not narrowed (bounded by the main categories). L4 should `noindex` these empty filtered listings.
- **Facet counts keep up to `MAX_KNOWN_FACET_VALUES` (1000) values per facet** with a `truncated` flag; `getFacets` still shows 50. For a cut list, values above the last known one count as possibly real (`above`). The 2-decimal/range check now runs in the pipeline before `$sort`/`$limit` (closes the "Known nit" above).
- `CATALOG_CACHE_VERSION` is **v4** (facet entry shape changed).

## Addendum (2026-10-08, L4 listing pages)
- **Routes:** `src/app/(site)/products/[[...category]]/page.tsx` serves `/products`, `/products/<main>`, `/products/<main>/<sub>`; more than 2 segments, an unknown path, a sub slug at main level and `page > pageCount` → 404. Page 1 with zero results is the empty state. No `loading.tsx` (a filter change never swaps the page for a fallback). No session read.
- **One load per request:** a React `cache` loader keyed by the path + the listing keys of the query, shared by `generateMetadata` and the page.
- **Metadata:** title "Sub – Main" (+ "– page n" from page 2); description only from the public category description; canonical = path (+ `?page=n` from page 2); `noindex, follow` whenever any filter or a non-default sort is set, including the uncached empty answer that keeps unknown values.
- **Filter UI:** the GET form is rendered twice (desktop rail, id prefix `rail`; mobile `<dialog>` sheet, prefix `sheet`) instead of moving one form. Without JS the rail shows inline at every width (`@media (scripting: none)`) with visible Apply/Sort buttons; those buttons are hidden after hydration (`useSyncExternalStore`), not by CSS, so they still work if JS fails. Sort is its own GET form carrying the filters as hidden fields; filter forms carry `sort`. With JS a change runs `router.replace(url, {scroll: false})`, a polite live region announces the count, focus stays on the checkbox.
- **Browser query builder** `form-query.ts` has no Zod (bundle size); a unit test pins it to `serialiseListingParams`; its token cap is `MAX_SLUG_LENGTH` so long `cat` slugs survive. The server always parses again.
- **Cards** (`ListingCard`): `STRIP_CARD_FRAME` + `ProductImageTransition` (`product-image-{id}`) in a `next/link`; family, name, base model code, "n models" from 2 variants; no spec values. First two cards eager.
- **Category cover** transform `c_fill,g_auto,ar_3:2,w_2400,q_auto` **without `f_auto`** (the gate-A static guard forbids `f_auto` in `cloudinary-image.ts`; next/image already negotiates AVIF/WebP). Transforms come only from the fixed `CLOUDINARY_TRANSFORMS` list.
- **Breadcrumb** links to `/products/<main>/<sub>`; header `/products` link is prefetched again (`/search` keeps `prefetch={false}` until L6).
- **E2E:** listing fixtures (`e2e/fixtures/listing-pages.ts`, 29 products, 3 main categories) seeded by `test-server.ts`; `admin-catalog.qa.spec.ts` now moves its category up until it reaches the top (bounded to 10), because seeded main categories sort above it.

## Addendum (2026-10-08, L5 area pages)
- `/areas` renders on request (`connection()`): the CI build has no database. The area list stays cached on the `areas` tag. Tiles are black-and-white and turn to colour on hover/focus (CSS filter, off under reduced motion). With no photo, a tile shows the area name in grey-500 on grey-100. No product counts (a cached `countProductsByArea` would be needed).
- `/areas/[slug]` reuses the L4 listing. One shared loader for both routes: `listingLoader` + `readListing` in `src/components/site/listing/listing-load.ts`. Visibility is read once per request. The parse uses `cat: true, track: false`.
- Header: area name, breadcrumb Applications › area (`Breadcrumb` `root` prop), the other areas as a link row (no "All"), a fixed intro line (areas have no description), and the cover as a 3:2 smart crop in greyscale (`cover.monochrome`).
- Meta title "Area – Applications" (+ "– page n"). Robots and canonical follow L4: any `cat`, filter or sort → `noindex, follow`; canonical `/areas/<slug>` (+ `?page=n`).
- Deviation: the footer keeps a single "Applications → /areas" link with no per-area column. Reading areas in `SiteShell` would put a database read in the layout and break the database-less static build. Decide this together with the L6 mega-menu (cached layout read with a build-safe fallback, or render those parts on request).

## Addendum (2026-10-09, L6 mega-menu, search UI, sitemap)
- **Header data:** the `(site)` and `(account)` layouts call `loadSiteMenu()` (cached `listPublicCategories`, `listPublishedCategoryCounts`, `listPublicAreas`) and pass `menu` to `SiteShell`/`SiteHeader`. On failure the menu is `null` and the header shows plain links; `EnvError` (CI build without a database) is silent, other errors log one warning. A `revalidate: 60` `unstable_cache` marker in the fallback path caps how long a page prerendered without a database keeps the plain header. Root 404/403/`/blocked` keep the plain header (no database read).
- **Empty categories are hidden** in the mega-menu, small-screen menu and sitemap (same rule as search, `categoriesWithPublished`). Areas always show.
- **Mega-menu:** without JS "Product" is a link to `/products`; after hydration an `aria-expanded` button (click/Enter/Space). Category strip + active block (description clamped to 3 lines, "View all", sub-categories) + Applications column. A category activates on focus or after 90 ms mouse hover; on touch the first tap shows sub-categories, the second opens the link. Closes on Escape (document listener), scrim press, outside press, focus leaving, link click, route change. Icons via `categoryIconUrl` (`w_96,h_96,c_fit,f_png|f_webp,q_auto`, plain lazy `<img>`).
- **Small-screen menu:** nested native `<details>` (works without JS).
- **Search overlay:** link to `/search` without JS; after hydration a button that loads a lazy native `<dialog>` combobox (`maxLength` 64, 200 ms debounce, aborted requests, per-query answers kept, `parseSearchAnswer` keeps only shown fields). Options are `<a role="option">`; modified clicks keep the overlay open. Links `/product/<slug>?model=<matchedModelNo>` and `categoryListingPath`.
- **`/search?q=`:** calls `searchCatalog()` directly, `q` cut to 64 code points, GET form, `noindex, follow`, no canonical, reuses `ListingGrid`.
- **Sitemap:** adds `/`, `/products`, category paths with a published product (never query strings), `/areas`, every area page.
- **Client-safe constants** (`search-links.ts`) repeat the search limits and path format so Zod stays out of the header bundle; unit tests pin the copies.
- **Footer** keeps the single Applications link (no database read in the footer).
- **Open:** page scrolls behind the overlay (L7); real Atlas `$search` through the overlay untested; overlay leak check with all restricted columns filled is a gate B job; mega-menu with real icons unseen (gate C); `countProductsByArea` would let areas hide when empty.
