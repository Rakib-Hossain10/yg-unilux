# Phase 4b — Listings, mega-menu, area pages, search: implementation plan

Status: **DRAFT, awaiting user approval** (2026-10-08). Branch `phase-4b` (from `main` after Phase 4a, PR #15).

## Scope
Everything left in the `tasks.md` Phase 4 list after 4a: the **mega-menu** (category icon strip + subcategories), **listing pages** with URL filters, sort and pagination, **area pages**, the **search overlay** (Atlas Search + regex fallback, ADR 0006), and the Phase 4 exit (Playwright filters + search by variant model no., Lighthouse ≥ 90 on listing and product page). It also closes the 4a hand-offs: listing cards reuse `ProductImageTransition` + `STRIP_CARD_FRAME` (ADR 0064 §23), `prefetch={false}` is removed from `/products` and `/search` once built, the breadcrumb and applications links point at real routes.

Not in scope: home page sections (Phase 6), content pages (Phase 7), the 4a open polish list (ADR 0064 §25) unless Q8 says otherwise, `cacheComponents` (ADR 0062 stands).

## Context: what exists today
- `src/lib/catalog/`: `listPublicCategories()` (whole tree, tag `categories`), `getBreadcrumb`, `getPublicProduct`, `listPublishedSlugs`, `getFamilyProducts`, `getRelatedProducts`, `ProductCardView` (`id, slug, name, family, modelCode, image`: no specs), `PRODUCT_CARD_PROJECTION`, `CATALOG_CACHE_VERSION`. All `unstable_cache` + tags (ADR 0062/0063).
- Products carry `filters: {cctK, cri, beamDeg, ugr, wattage, ip}` (numbers parsed from public display strings; restricted columns' filters are already removed by the settings save and the import). `trackSize` only under Magnetic Track. Indexes: `status+mainCategory`, `extraCategories`, `areas`, `family`, `variants.modelNo` (collated). **No filter indexes, no Atlas Search index definition** anywhere yet.
- Categories: `name, slug, parent, order, icon?, coverImage?, description?`, depth ≤ 2 (`MAX_CATEGORY_DEPTH`). **Sub-category slugs are unique only among siblings** ("Recessed" can exist under two parents). The admin category editor does **not** edit `icon`, `coverImage` or `description` yet.
- Areas: `name, slug, icon?, bwImage, order`; admin has the bw image uploader.
- Header: `MAIN_NAV` with `prefetch={false}` for unbuilt routes; search icon links to `/search`; mobile menu is a native `<details>` disclosure. Breadcrumb links to `/products?category=<slug>` (must change, see Q1).
- Product page: `ProductImageTransition` (`product-image-{id}`) around the stage frame; strip cards 4:5.

## Decisions to take (defaults in bold; answer or accept)
- **Q1. Listing URLs.** **Path for the category, query for the filters:** `/products` (all), `/products/<main>`, `/products/<main>/<sub>`; filters/sort/page as `?cct=3000,4000&ip=65&sort=name&page=2`. A path is needed because sub-category slugs repeat across parents; it also gives clean canonical URLs per category. The breadcrumb switches to these paths. Alternative: `?category=<id>` (ugly, not shareable by name).
- **Q2. Rendering of listings.** **Server-rendered on request (reads `searchParams`), data from `unstable_cache` keyed by the normalised filter set**, so a filter change is a real URL, works without JS, is crawlable, and the database is hit once per distinct query until a tag expires. The page itself is not CDN-cached (it is cheap: cached data, no session read). Alternative: a static page per category that ships every card and filters in the browser (fast, but `/products` would ship 500+ cards and no-JS filtering is lost).
- **Q3. Filter behaviour.** **Facets = CCT, CRI, beam angle, UGR, wattage, IP (+ track size under Magnetic Track), values offered = only those present in the current scope (with counts), multi-select OR within a facet, AND across facets.** Wattage as ranges (≤ 10 W, 11–20, 21–40, > 40, buckets tuned on the real data) instead of every distinct value; the others as discrete values. A facet whose column is restricted is never shown and its parameter is ignored. Desktop: left filter rail; mobile: "Filters (n)" button opening a sheet (native `<dialog>`). Applying = GET form submit (no JS) enhanced to `router.replace` with `scroll: false`.
- **Q4. Scope rule.** **A category page lists products whose `mainCategory` OR `extraCategories` is that category or any of its sub-categories** (CLAUDE.md: the same product shows under Spot Lights → Recessed AND Recessed Lights → Spot). Area pages list products whose `areas` contains the area, with a category facet on top of the spec facets.
- **Q5. Sort and pagination.** **Sort: catalog order (default: `productNo`, name), name A–Z, newest. 24 per page, numbered page links** (crawlable; `?page=` beyond the last page → 404). Alternative: "Load more" button.
- **Q6. Listing card content.** **Image (4:5, `STRIP_CARD_FRAME`), family eyebrow, name, base model code, "n models" when 2+ variants. No spec values on cards** (keeps every card free of restricted risk and identical to the strip card). Alternative: show public CCT/wattage chips (more scanning value, more weight and leak surface).
- **Q7. Category icons (mega-menu strip, KC Lighting).** **The admin uploads an icon (Cloudinary, PNG or SVG converted by Cloudinary to PNG/WebP, never inline SVG markup in our HTML) plus an optional cover image and description per main category, through the existing direct-upload pattern (ADR 0045/0046).** Until an icon exists the strip shows the category name only. Raw SVG stored in the DB and inlined is rejected (XSS surface). The client supplies the icons; we do not draw them.
- **Q8. 4a open polish (ADR 0064 §25).** **Fold the cheap ones into the 4b motion/polish task** (Models table stacked on mobile, mobile menu scrim, 44 px footer links, footer `prefetch={false}`, favicon once supplied). Alternative: separate Phase 9 batch.
- **Q9. Search.** **Header icon opens an overlay (native `<dialog>`, type-ahead after 2 chars, debounced 200 ms) backed by `GET /api/catalog/search?q=`; Enter or no JS goes to a full `/search?q=` results page.** Results: products (card + the matched model no.; a variant hit links to `/product/<slug>?model=<modelNo>`) and matching categories (name match on the cached tree). Atlas `$search` on name, family, type, `variants.modelNo` (autocomplete + exact token), public fields only; regex fallback (escaped, anchored on model no.) only when `$search` throws, with a warning log (ADR 0006). The index definition is created by a script (`npm run db:search-index`), not on startup.

## Caching and safety (ADR 0002 / 0062 / 0063, rule 9)
- New readers in `src/lib/catalog/` (`listing.ts`, `facets.ts`, `areas.ts`, `search.ts`) use `PRODUCT_CARD_PROJECTION` (no specs) plus `filters.<k>` **only for public filter columns** (visibility read outside the cache and passed as a cache argument, the gate-A M-1 pattern). Facet values come from `filters` numbers, never from restricted display strings.
- Cache keys: normalised params only (sorted, deduped, bounded lists, Zod-parsed); unknown or restricted params are dropped before the key is built, so a crawler cannot fill the cache with junk keys beyond a small bounded set. Tags: `products`, `categories`, `areas`, `settings:columns`. `CATALOG_CACHE_VERSION` bumps on any projection change.
- Search route: Zod on `q` (trimmed, 2–64 chars); answers come from `unstable_cache` keyed by the normalised query and are sent `private, max-age=30`. No CDN (`s-maxage`) caching, so a CDN copy can never outlive a tag expiry. No session read. Vercel Firewall rate limit on `/api/catalog/search` (added to the launch list).
- No reader in 4b imports `permissions`; the static guard from gate A extends to the new files.
- Drafts never appear in listings, facets, counts, search or the sitemap.

## Design references (CLAUDE.md)
- **KC Lighting:** mega-menu = one row of main-category icons with names, the hovered/focused one's sub-categories listed beside it, plus "All products" and an "Applications" column (7 areas). Opens on click/Enter (a disclosure button, not hover-only), closes on Esc, outside click and navigation.
- **Viabizzuno:** `/areas` index uses the black-and-white area images as large tiles (the horizontal-scroll version is the home page, Phase 6). Area page header = its bw image, full width.
- **HBA:** calm transitions; listing card → product page shared-element morph (the 4a `ProductImageTransition`).
- **Delta Light:** quiet filter rail, generous white space, grey-100 card frames.
- Palette black/white/warm greys; real photos only; empty image = the 4a neutral placeholder.

## Accessibility and motion rules (as 4a, plus)
- Filter rail: `<form method="get">` of `<fieldset>`s with checkboxes, a visible "Apply" button without JS (hidden when JS auto-applies), result count in a polite live region after a change, "Clear all" link. Active filters shown as removable chips.
- Mega-menu: `aria-expanded` button, focus moves into the panel, Tab order follows reading order, Esc returns focus to the button. Mobile: categories as nested disclosures inside the existing menu.
- Search overlay: `role="combobox"` input + listbox of results (arrow keys, Enter opens), results announced by count; the full page works without JS.
- Reduced motion: every transition has a no-motion path; the card morph is skipped.
- 360 px: no horizontal scroll, 2-column card grid from 360 px, 3 from `md`, 4 from `xl`.

## Subagents
Existing roster, all Opus (user rule): `backend-architect` (readers, search, index script, route), `admin-panel-builder` (category icon/cover/description), `site-frontend` (pages, header, overlay), `motion-engineer` (enhancements), `qa-security-reviewer` (gates), `ui-reviewer` (gate C polish), `code-reviewer` (hook). No new agents, no new skills (4a skill check still holds; `seo`, `next-best-practices`, `playwright-best-practices` cover the new work).

## Tasks
Each task: one commit, typecheck + lint + tests green, Resume section rewritten.

| # | Task | Owner | Key files | Tests |
|---|---|---|---|---|
| L0 | Plan approved, answers recorded; `ui-reviewer` roster line in ADR 0013 + CLAUDE.md | main | this file, `doc/decisions/0013-subagents.md`, `CLAUDE.md` | — |
| L1 | **Listing data layer:** `src/lib/catalog/listing-params.ts` (pure Zod parser/normaliser + serialiser for `?cct=&cri=&beam=&ugr=&w=&ip=&track=&cat=&sort=&page=`), `category-path.ts` (`resolveCategoryPath(["main","sub"])` on the cached tree, subtree ids), `listing.ts` (`listProducts(scope, params)` → `{cards, total, page, pageCount}`), `facets.ts` (`getFacets(scope)` via one `$facet` aggregation), `areas.ts` (`listPublicAreas`, `getAreaBySlug`); `ListingCardView` = `ProductCardView` + `variantCount`; filter indexes (`status`+`filters.*` where the plan step shows them useful) | backend-architect | `src/lib/catalog/*`, `src/models/product.ts` (indexes) | memory DB: scope rule (main/extra/subtree), AND/OR semantics, wattage buckets, restricted facet absent + its param ignored, drafts excluded, page bounds, stable sort, param normaliser property test (any junk → bounded canonical form), card has no spec key. **ADR 0065** |
| L2 | **Search:** `src/lib/catalog/search.ts` (`searchCatalog(q)`: `$search` compound on public fields, regex fallback on failure with a warning; category name matches from the cached tree), `scripts/search-index.ts` + `npm run db:search-index` (idempotent create/update of the index definition), `GET /api/catalog/search` (Zod, bounded, `private, max-age=30`) | backend-architect | `src/lib/catalog/search.ts`, `scripts/search-index.ts`, `src/app/api/catalog/search/route.ts` | memory DB exercises the fallback: model-no. case-insensitive hit returns the variant, family/name hits, regex metacharacters escaped, 64-char cap, no spec value in results, drafts absent; unit test of the `$search` pipeline shape. **ADR 0066** |
| L3 | **Category icon, cover, description in the admin** (Q7): uploaders reuse the area uploader pattern; service + action + Zod; expires `categories` | admin-panel-builder (+ backend-architect for the service) | `src/lib/admin/categories.ts`, `src/components/admin/category-*` | action guard (customer/visitor/banned refused), Zod, tag expiry, upload verified server-side (ADR 0045) |
| **Gate A** | QA after L1–L3: leak matrix over listing cards, facets, search results and route answers for each visibility set; cache-key bounding; drafts; regex-injection; guard tests | qa-security-reviewer | `test/listing-gate-a.qa.test.ts` | as listed |
| L4 | **Listing pages:** `src/app/(site)/products/[[...category]]/page.tsx` (Q1/Q2), `not-found`, metadata + canonical (filters → `noindex, follow` when any filter is set; page 2+ canonical to itself), card grid (`ListingCard` sharing `STRIP_CARD_FRAME` + `ProductImageTransition`), filter rail + mobile sheet, active chips, sort, pagination, empty state ("No products match these filters" + clear), category header (cover, description), sub-category links. Breadcrumb links switch to paths | site-frontend | `src/app/(site)/products/*`, `src/components/site/listing/*`, `breadcrumb.tsx` | render tests; e2e: filters without JS (form GET) and with JS (URL updates, count announced), unknown category → 404, page past the end → 404, 360 px grid, axe |
| L5 | **Area pages:** `/areas` (bw tiles) and `/areas/[slug]` (header image, category facet + spec facets, same grid/pagination); applications row links become live; footer "Applications" | site-frontend | `src/app/(site)/areas/*` | e2e: area listing + category facet, unknown area 404, axe |
| L6 | **Mega-menu + search UI:** header "Product" becomes the mega-menu button (categories passed from the cached tree in the layout), mobile menu nested categories; search overlay (lazy chunk, combobox) + `/search?q=` page; remove `prefetch={false}` for `/products` and `/search`; sitemap adds `/products`, category paths and area pages | site-frontend | `src/components/site/{site-header,mega-menu,mobile-menu,search-*}.tsx`, `src/app/(site)/search/page.tsx`, `src/app/sitemap.ts`, `nav-links.ts` | e2e: keyboard open/close/Esc focus return, search by variant model no. → product page with `?model=` selecting that variant, no-JS search page, axe |
| **Gate B** | QA after L4–L6: real-HTML leak test on listing, area, search page and overlay answers (every restricted column filled), facet toggles when a column flips restricted ↔ public, cache expiry after product/category/area writes, junk-param flood stays bounded | qa-security-reviewer | `e2e/listing-gate-b.qa.spec.ts`, `test/listing-gate-b.qa.test.ts` | as listed |
| L7 | **Motion + polish:** card → product morph (shared `ProductImageTransition`), mega-menu reveal, filter result crossfade (View Transition on the grid), search overlay open/close; Q8 polish items. Reduced-motion paths | motion-engineer (+ site-frontend for polish) | `src/components/motion/listing/*`, `src/components/motion/menu/*` | e2e with `reducedMotion: "reduce"`; no leaked listeners after navigation |
| L8 | **Exit e2e + Lighthouse:** browse → filter → open product → back keeps filters/scroll; search by model no.; keyboard-only run; 360/1280 axe; Lighthouse mobile ≥ 90 perf/a11y/SEO on `/products`, a category page and the product page. **Gate C:** `qa-security-reviewer` (whole branch), then `ui-reviewer` | qa-security-reviewer, ui-reviewer | `e2e/listing.spec.ts` | never `networkidle`; fakes for Cloudinary/R2 |

After gate C: ADR notes, tick `tasks.md` (Phase 4 complete), Resume → Phase 5 planning, push, PR with `gh`, wait for CI, **ask before merging into `main`**.

## Things the user must do
- Answer or accept Q1–Q9.
- Before L2 runs against the dev DB: run `npm run db:search-index` once on the Atlas dev cluster (we write the script; it needs the Atlas connection in `.env.local`). Same for preview/production at launch.
- Supply category icons (Q7) and, still open, real client photos, logo and favicon. Without icons the mega-menu shows names only.

## Risks
- **Atlas Search not testable locally:** memory DB runs only the regex fallback. Mitigation: pipeline-shape unit test + a manual check on the dev cluster after `db:search-index` (logged in tasks.md), and the fallback is functional on its own.
- **Dynamic listing pages and cost/latency:** every request renders on the server. Mitigation: cached data, no session read, Lighthouse gate; if needed later, static `/products/<category>` without filters via a separate route segment.
- **Cache-key explosion by crawlers:** bounded by the normaliser (known keys, known values from facets, capped list length, page ≤ pageCount); filtered pages are `noindex`.
- **Facets from restricted columns:** filter numbers of restricted columns are removed at save/import, and the readers also drop them by visibility (second guard), tested at gate A.
- **Header now reads data:** the layout reads the cached category tree; a DB outage must not break every page (empty menu fallback, tested).

## ADRs to write (main session)
- **0065:** listing URLs, rendering mode, scope rule, filter semantics, cache-key normalisation, card content.
- **0066:** search: Atlas index definition + script, fallback rules, route caching, overlay vs page.
- **0067:** category icon/cover format and the mega-menu structure (may fold into 0065 if small).

## Verification
- Per task: `npm run typecheck`, `npm run lint`, `npm test`.
- Exit: `npm run build`, `npm run test:e2e`, `npm run audit`, gitleaks; leak tests green; Lighthouse ≥ 90 on listing + product page.
- QA gates: A after L3, B after L6, C at exit (`qa-security-reviewer`, then `ui-reviewer`).
