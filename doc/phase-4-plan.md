# Phase 4 — Public product page: implementation plan

Status: **APPROVED with the answers below** (user, 2026-10-08). Branch `phase-4` (from `main` after Phase 3 PR #12). P0 and P1 done. **P1 verdict: `cacheComponents` stays OFF (ADR 0062)**; the caching sections below are amended accordingly.

## User answers (2026-10-08)
- **Q1** split into 4a/4b: agreed.
- **Agent edits:** approved and done (P0): `web-design-guidelines` added to `motion-engineer`, product-page rules added to `site-frontend`.
- **UI reviewer:** yes, as a **read-only reviewer, not a builder**: new `.claude/agents/ui-reviewer.md` (skills `frontend-design`, `web-design-guidelines`, `playwright-best-practices`). It runs as a final visual/polish pass at the exit gate (gate C), **alongside** `qa-security-reviewer`, answering "does this look premium and distinctive?" separately from "does it work correctly?".
- **Q2:** do the spike first; **do not commit `cacheComponents` app-wide until it is proven safe for the admin pages and the footer.**
- **Q3:** accept `?model=`, but state the SEO cost first (see Q3 below). Result: small, and mitigated by a server-rendered variants table (P4).
- **Q4:** lumen/efficacy shown twice: agreed.
- Q5–Q7: defaults stand (not contradicted).
- **Real photography:** the user added 2 real product photos to a product in the dev DB; the gallery task (P6) and the ui-reviewer use that product, not placeholders.

## Scope of this plan
The user asked to plan **the public product page**: family / product / variant display, the optic (variant) switcher and the image gallery. The `tasks.md` Phase 4 list also holds the mega-menu, listing pages with URL filters, area pages and the search overlay. This plan covers the product page **and the catalog data layer it needs** (cached, tagged, restricted fields projected away). Listings, mega-menu, search and area pages are **Phase 4b** and get their own plan after this part is merged (Q1). The product page links to `/products` and the family strip links to product pages only, so 4a is shippable alone.

**Decided, not re-derived:** ADR 0054. Pink columns go in a right-side quick-spec panel, green columns in a full spec table below the product. `placement: "quick" | "table"` lives in `SPEC_COLUMNS`. Visibility still wins (restricted values never appear in either place for a non-allowed viewer).

## Context: what exists today
- `ProductModel` (`src/models/product.ts`): `name, slug, modelCode, family, productNo, type, description, mainCategory, extraCategories, areas, trackSize, images[{publicId, alt, order, kind}], specs, filters, variants[{modelNo, label, specs, imagePublicId}], extraSpecs, publicFiles, datasheetId, status, featured`. Variant `specs` hold only the values that differ from the product-level `specs`.
- `SPEC_COLUMNS` (28 keys, English headers, `defaultVisibility`) has **no `placement` and no `group`** yet. The groups live in `src/components/admin/product-form/spec-groups.ts` (a proposed backend change, noted there).
- Column visibility: `getColumnVisibility()` in `src/lib/admin/settings.ts`; tag `settings:columns`. Restricted filters are already dropped from products by the admin save and the import.
- Access: `viewerCanSeeRestricted()` / `getViewer()` in `src/lib/permissions.ts` ("for the uncached restricted-specs block only").
- Revalidation: `src/lib/revalidate.ts` with typed tags `products`, `product:<id>`, `categories`, `areas`, `settings:columns`, `datasheets`.
- **Not yet existing:** `src/lib/catalog/`, `src/components/motion/`, any `(site)` page except the home placeholder and the error page, the `/product/[slug]` route, `cacheComponents` (ADR 0008: "enabled in Phase 4"; `next.config.ts` does not set it).
- Installed: `next/image` with AVIF/WebP and our Cloudinary `remotePatterns`; `gsap`, `lenis`, `motion` (npm packages, unused so far).
- Tokens: `ink`, `paper`, `grey-50…900`, `danger`; `font-display` (Cormorant Garamond) and `font-sans` (Inter).

## Skill check (`/find-skills`, 2026-10-08)
Searched `accessibility`, `image gallery carousel`, `motion design` with `npx skills find`, and compared with the 21 skills already in `.claude/skills/`.

| Need | Already installed (use these) | Found, not installing | Why |
|---|---|---|---|
| Visual design | `frontend-design` | `pbakaus/impeccable` (317K installs), `nextlevelbuilder/ui-ux-pro-max` (386K), `leonxlnx/taste-skill@high-end-visual-design` (417K) | They overlap `frontend-design` + `web-design-guidelines`, and their aesthetic defaults are generic. Our direction is fixed by CLAUDE.md "Design". Only install counts were checked in the search listing, not repository stars or source: not enough to trust them with code that ships. |
| Accessibility | `web-design-guidelines` (708K, Vercel), `playwright-best-practices` (axe-core section) | `pbakaus/impeccable@audit` (82K) | Same overlap. Accessibility is enforced by rules in this plan, axe in e2e and the QA gate. |
| Motion | `gsap-core`, `gsap-scrolltrigger`, `gsap-react`, `gsap-timeline`, `gsap-performance`, `vercel-react-view-transitions` | `heygen-com/hyperframes@hyperframes-animation` (702K) | It targets video/frame compositions, not web UI. |
| Gallery / PDP | — | `saleor/storefront@pdp` (3 installs), `kylefox/flowbite-skills@flowbite-carousel` (6), `phazurlabs/sumi@image-media-patterns` (20) | Under 100 installs, tied to other stacks. The gallery is small and specified below. |
| Next.js caching, SEO, React perf | `next-cache-components`, `next-best-practices`, `seo`, `vercel-react-best-practices`, `vercel-composition-patterns` | — | Already cover the data layer, metadata and component patterns. |
| Tests | `playwright-best-practices`, `webapp-testing`, `tdd`, `security-and-hardening` | — | Cover the leak test, axe and the keyboard tests. |

**Result: install nothing.** There is no `Motion` (Framer Motion) skill in the ecosystem results worth trusting; the `motion-engineer` reads the package types and docs before using it (same rule as for Next and Better Auth).

## Subagents: reuse, plus one read-only reviewer
The two existing builders cover the page, so **no new builder** is created (a third would split ownership of the same files). The user asked for one new agent, a **reviewer**, so that taste is checked separately from correctness.

| Agent | Phase 4a role |
|---|---|
| `site-frontend` (exists, Opus, `frontend-design`, `web-design-guidelines`, `next-best-practices`, `next-cache-components`, `vercel-react-best-practices`, `vercel-composition-patterns`, `seo`) | **Owner of the product page**: route, quick-spec panel, spec table, variant switcher, gallery, family/related strips, restricted block, metadata, JSON-LD. Its prompt already names "product page with variant switch and the dynamic restricted-specs block". |
| `motion-engineer` (exists, Opus, all GSAP skills, `vercel-react-view-transitions`, `frontend-design`) | **Enhancement only**: gallery slide + lightbox transitions, optic-switch readout crossfade, listing-to-gallery view transition, scroll reveal of the spec table. Owns `src/components/motion/`. The page is complete without it. |
| `backend-architect` | Catalog data layer, `cacheComponents` spike, `placement`/`group` on `SPEC_COLUMNS`, restricted-specs function, sitemap data. |
| `qa-security-reviewer` | Leak test, access matrix, axe, keyboard, reduced-motion, Lighthouse; gates A, B and C (correctness and safety). |
| `ui-reviewer` (**new, read-only**, Opus, `frontend-design` + `web-design-guidelines` + `playwright-best-practices`) | Final visual/polish pass at gate C, after the exit e2e: real screenshots at 360/768/1280/1920 px, normal and reduced motion, with the real product photos. Reports "premium and distinctive?" findings; cannot edit source. |
| `code-reviewer` | Automatic per-file review (hook). |

All on **Opus** (user rule: UI work always goes to Opus frontend subagents).

**Agent-file edits (done in P0):** `site-frontend.md` has a "Product page" section (layout from ADR 0054, restricted block, switcher, gallery, references); `motion-engineer.md` has `web-design-guidelines` and a "Product page" section; `ui-reviewer.md` is new.

## Design references applied to this page (from CLAUDE.md)
- **HBA:** page transitions and the calm, slow easing; the family strip uses the same card rhythm as the leadership carousel.
- **Arelux:** hero-scale first image: full-bleed gallery stage on mobile, large stage on desktop.
- **Delta Light:** restrained spec presentation and generous white space; capabilities collage is not used here.
- **KC Lighting:** the category line-icon style is reused for the small spec icons only if the client supplies icons; otherwise none.
- **Viabizzuno:** the 7-area horizontal scroll is **not** on this page; the "Applications" row (areas this product belongs to) reuses its black-and-white area images as small linked tiles. Mobile = swipe row.
- Palette: black, white, warm greys; photography carries colour. Product photos are always real client photos; empty gallery = neutral grey placeholder with the product name (never generated art).

## Page structure (`/product/[slug]`, English only)
1. **Breadcrumb:** Products › main category › (sub category) › product. From the category tree (cached, `categories` tag).
2. **Product block** (two columns ≥ 1024 px, stacked below):
   - **Left, gallery.** Stage with the selected image, thumbnails (vertical rail on desktop, horizontal strip on mobile), previous/next, "n / N" counter, click opens a zoom lightbox. The variant's own image (`imagePublicId`) is selected when that variant is chosen.
   - **Right, quick-spec panel (ADR 0054, pink):** family `name` as eyebrow, product title, `type` (Model Type, no colour) as subtitle, then **Model No.** (follows the optic switch), **Housing Material, Housing Color/Finish, Reflector Color, Cut-out Size, CCT** (chips when several). Under them: the **optic switcher**, a compact readout of the selected variant's **Lumen Output and Lumen Efficiency** (CLAUDE.md: the switch "updates model no., lumen, efficacy"; the same two values also stay in the table, Q4), and the datasheet block (dynamic, see below). Sticky on desktop (CSS `position: sticky`, no JS).
3. **Full spec table (ADR 0054, green)** below, grouped with the existing group titles (Housing and optics, Size and mounting, Light source, Electrical and output, Lifetime and protection), sheet order, empty values hidden, shows the **selected variant's** values. Public `extraSpecs` appear as their own groups. `publicFiles` as a "Downloads" list.
3b. **Models table** (server-rendered, all variants, public values only): model no., label, lumen output, lumen efficiency and any other public value that differs between variants; each row selects that variant (a button, no navigation). This is the crawler-visible record of every variant (Q3) and a quick comparison for buyers.
4. **Restricted block** (dynamic, after the table): restricted spec rows and, in the panel, the datasheet button. See "Caching".
5. **More from {family}** strip (other products of the same family, cached, published only) and **Related** strip (same main category + shared area, capped at 8). Cards = image, name, base model code. Swipe carousel on mobile, native scroll-snap.
6. **Applications:** area tiles linking to `/areas/<slug>` (page arrives in 4b; links render as plain text until the route exists, Q6).

**Variant model:** a "variant" is one `Model No.` of the product. If a product has one variant, the switcher is hidden and its model no. is just shown. Labels come from `variant.label` ("Regular Lens"); a variant without a label shows its model no.

## Decisions to take (defaults in bold; answer or accept)
- **Q1. Split Phase 4.** **4a = data layer + product page (this plan); 4b = mega-menu, listings + filters, area pages, search overlay.** Alternative: one big plan.
- **Q2. (Answered: spike done, off, ADR 0062.) Enable `cacheComponents` for the whole app.** ADR 0008 planned it, but it changes how *every* route renders (any route reading `cookies()`/`headers()` outside `<Suspense>` fails the build). Admin pages and the footer's `new Date().getFullYear()` (QA L1, tasks.md) are affected. **Default: a time-boxed spike first (P1); if it needs invasive admin changes, fall back to tag-cached reads with `unstable_cache`-style functions or route-level static generation plus `revalidateTag`**, whichever the installed 16.3.8 docs support. The spike reports before any page code. ADR 0062.
- **Q3. Variant in the URL (accepted; SEO cost below).** **`?model=AR-013A2`, read on the client; the cached page always renders the first variant and the switch updates the URL with `history.replaceState`.** The search results and shared links use it; canonical stays the bare product URL. Reading `searchParams` on the server would make the page dynamic and break the cache. Trade-off: a deep link paints the first variant for one frame before the client switches; the readout area has fixed size so there is no layout shift.
  **SEO cost (asked by the user): small.** A crawler fetching `?model=AR-013A2` gets the cached HTML of variant 1 (the server never sees the parameter), and Google renders JavaScript but may snapshot before the client switch. Because the canonical is the bare product URL, search engines consolidate every `?model=` URL onto the one product page and would not index a per-variant page anyway, so nothing is lost on ranking. What could be lost is a search for a *specific* model no. or its lumen value matching text on the page. That is closed by making the **cached server HTML list every variant**: a "Models" table (model no., label, lumen output, lumen efficiency, plus any other value that differs) and JSON-LD `hasVariant` / one `sku` per variant. The size of the remaining cost is then: link previews and non-rendering crawlers show variant 1 as the page's lead variant. For a B2B catalog this is acceptable. Alternative if it ever matters: a path segment `/product/<slug>/<model>` (static, one page per variant, canonical to the product); it multiplies static pages by the variant count and is not needed now.
- **Q4. Lumen/efficacy in both places.** **Yes:** compact readout by the switcher *and* in the table (green columns). If you want them only in the table, the readout is dropped (a one-line change).
- **Q5. Draft products.** **404 for everyone, including the admin**, on this phase. A "View on site" admin preview of a draft is a follow-up (needs a dynamic, admin-only path).
- **Q6. Links to routes that arrive later** (`/areas/<slug>`, `/products?category=`): **render real links, and let 4b create the routes.** Because 4a is not meant to be live on the production domain before 4b, a dead link is acceptable on `phase-4` and gets an e2e in 4b. Alternative: hide until 4b.
- **Q7. Slug change redirect (tasks.md L-E).** **Out of scope for 4a**, stays in the backlog (needs a `slugHistory` field and an admin change).

## Caching and the restricted block (ADR 0002 / 0008 / **0062**, rule 9)
**P1 spike result (2026-10-08):** `cacheComponents` stays off. With it on, a signed-in customer opening `/admin` got HTTP 200 instead of the real 403, and the only docs-supported fix is a DB-backed role check in `proxy.ts` on every admin request. That is a separate decision, not part of the product page. The pattern below needs no flag.
- `src/lib/catalog/` (new, `server-only`, owner `backend-architect`) holds readers wrapped in `unstable_cache(fn, keyParts, { tags })` (P3 re-reads the installed 16.3.8 docs for the exact API first), tagged `products`, `product:<id>`, `categories`, `settings:columns` via `CATALOG_TAGS`/`productTag`. Invalidation is only through `src/lib/revalidate.ts`.
- **Projection is built from the current column visibility:** the reader loads the visibility (tagged `settings:columns`), then projects away `specs.<k>` and `variants.specs.<k>` for every restricted key, and `filters.*` for restricted columns. A restricted column is not in the cache entry at all. A visibility change expires `settings:columns` and so every product entry.
- Cached readers return a **plain-data view model** (`PublicProductView`: string ids, ISO dates, explicit projection, never a raw lean doc): identity, images, public specs merged per variant, `extraSpecs`, `publicFiles`, `hasDatasheet` as a boolean (the id never goes in cached HTML), published only. A type test and a runtime test assert it has no key from the restricted set. Cached code never calls `getViewer` / `viewerCanSeeRestricted`.
- **The page is static (ISR):** `generateStaticParams` over published slugs (an empty list is allowed, so CI builds with no database). The page reads no `headers()`/`cookies()`.
- **Restricted block = client component + route handler.** `GET /api/catalog/restricted/[productId]`: `getViewer` → `canSeeRestricted` → `getRestrictedSpecs(productId)` (the **only** reader of restricted fields, reads the visibility fresh, returns `null` for everyone not allowed), Zod on the id, `Cache-Control: private, no-store`. The same answer carries the datasheet button state. The client block shows a skeleton of the final height (no layout shift), then renders the rows. Restricted values are therefore never in the page response, the prerender, any prefetch payload, JSON-LD, metadata, sitemap or strips.
- **Datasheet button states** (CLAUDE.md): visitor = locked ("Sign in to download"); active customer/admin = download (link to `/api/datasheet/<productId>`, built in Phase 5); expired = "Access expired — contact us"; no datasheet = "Datasheet coming soon". Until Phase 5 only the admin can be in the "download" state. If JS fails, the skeleton is replaced by a plain server-rendered line "Sign in to see restricted specifications" next to the block.
- Restricted quick-spec columns (none by default): returned by the same route and rendered in the panel position, never in the cached panel (ADR 0054 §4).
- Mutations: no new write path. Existing tags cover product, category, datasheet, visibility and import changes; a test asserts a product write expires `product:<id>` and the page output changes. Create/publish actions must expire `products`, because a cached `null` for an unknown slug lives until the tag is invalidated.
- Known debt: `unstable_cache` is marked "replaced by `use cache`" in 16.3.8 (ADR 0062 says when to migrate).

## Gallery spec (site-frontend builds; motion-engineer enhances)
- **No gallery library.** Native CSS scroll-snap track (`overflow-x: auto; scroll-snap-type: x mandatory`), thumbnails and buttons set `scrollTo`. Works with no JS for swipe; enhanced with JS for the counter and the selected state (`IntersectionObserver`).
- Images through `next/image` with `sizes`, stage aspect ratio fixed (4:3 default, container query on the stage), the first image `priority` + `fetchPriority="high"`, others lazy. No CLS: size comes from the container, not the file (the model stores no dimensions).
- Cloudinary transformation: serve through `next/image` only (remotePatterns pinned to our cloud, ADR 0016); no raw Cloudinary URLs with arbitrary transforms.
- **Lightbox:** native `<dialog>` + `showModal()` (focus trap, Esc, inert background), zoom 1× / 2× by button, double-tap and `+`/`−`/arrow keys, pan by drag; pinch-zoom is the browser's own (`touch-action: pinch-zoom` on the dialog image). Close returns focus to the thumbnail that opened it.
- `kind` ("gallery" | drawing etc.): drawings are shown after photos, labelled in the alt text.
- Alt text: `image.alt` or "{product name}, image n of N".
- Selecting a variant with `imagePublicId` scrolls the track to that image (instant when reduced motion).

## Variant switcher spec
- A **native radio group** (`<fieldset><legend>Optic</legend>` with visually styled labels): free keyboard behaviour (arrows move + select, Tab leaves the group), screen-reader semantics, works as a form-less control. The legend text is the differing field's name when all variants differ in one spec (e.g. "Lens / Reflector"), otherwise "Option".
- Each choice shows `label`, with the model no. as secondary text.
- On change: update URL (`?model=`), the Model No. in the panel, the lumen/efficacy readout, the table values, and the gallery image. One client component holds the selected index; the table and panel receive the variant data as props (small: ≤ ~30 variants).
- **Announcement:** a polite `aria-live` region says "AR-013A2 selected, 1200 lumens, 100 lm/W". Focus stays on the radio.
- Only values that differ between variants are highlighted when the user switches (brief background change; no motion under `prefers-reduced-motion`).
- Per-variant values merge as: variant spec if present, else product spec.

## Accessibility and motion rules (apply to every task; checked by tests and gates)
- Semantic landmarks: one `<h1>` (product title), `<nav aria-label="Breadcrumb">`, sections with headings, `<table>` with `<caption class="sr-only">`, `<th scope="row">` for labels. Option values (CCT etc.) are a list or chips with a readable text join, not colour-coded.
- Keyboard: everything reachable, visible focus ring (AA contrast on both ink and paper), no keyboard trap except the modal `<dialog>`, touch targets ≥ 44 px, no hover-only information.
- Contrast AA for text on `paper` and `grey-50`; grey-500 is not used for body text.
- **`prefers-reduced-motion`:** every transition has a no-motion path (CSS media query for CSS, `gsap.matchMedia()` for GSAP, `useReducedMotion` for Motion). Sticky panel, scroll-snap and the lightbox are state changes only.
- **Mobile:** horizontal strips (gallery thumbnails, family, related, applications) are native swipe carousels with scroll-snap; no pinning, no scroll hijacking. 16 px gutters, no horizontal page scroll at 360 px.
- **No blocking of first paint:** the server renders the final content. Animation starts after hydration, from the final state (no `opacity: 0` hidden content without a CSS fallback). Only `transform`/`opacity` are animated. Client JS for the page is the switcher + gallery + lightbox only; the table, panel, strips are Server Components.
- If Lenis is mounted globally later (Phase 6), the lightbox needs `data-lenis-prevent`. 4a does not mount Lenis.
- Layout shift: images and the restricted skeleton reserve their space; target CLS ≤ 0.02, Lighthouse ≥ 90 for performance, accessibility, SEO.
- English only; no i18n; all text plain strings.

## SEO / metadata (skill `seo`)
- `generateMetadata` from the cached view: title "{name} {baseModelCode} | YG UniLUX", description from `description` or a templated sentence of **public** specs, canonical `/product/<slug>`, Open Graph image = first gallery image.
- **JSON-LD** `Product`: name, image(s), brand "YG UniLUX", `sku`/`mpn` = each variant's model no. (`ProductGroup` + `hasVariant` if it stays small), description. **No price, no restricted value** (rule 9; test that the JSON-LD, `<meta>` and sitemap output contain no restricted value).
- Sitemap (`app/sitemap.ts`) lists published product URLs from the cached list; no specs.
- Draft / unknown slug → `notFound()`; the not-found page exists.

## Tasks
Each task gets one commit with typecheck + lint + tests green and the "Resume here" section rewritten (CLAUDE.md). Every file starts with a 2–3 line header comment. Work on a new **`phase-4`** branch from `main` after the Phase 3 PR (#12) is merged.

| # | Task | Owner | Key files | Tests |
|---|---|---|---|---|
| P0 | **DONE (2026-10-08):** plan approved, answers recorded, agent files edited, `ui-reviewer` created. ADRs 0062–0064 are written when their task finishes | main | `doc/phase-4-plan.md`, `.claude/agents/{site-frontend,motion-engineer,ui-reviewer}.md` | — |
| P1 | **DONE (2026-10-08, ADR 0062): verdict B, `cacheComponents` stays off.** Spike notes: read the installed docs (`node_modules/next/dist/docs/`), enable on a scratch branch, run `next build` and list every route that breaks (admin layout, footer year, auth pages). Decide: enable for the app, or the fallback (Q2). Also confirm how a signed-in viewer's response avoids the shared cache. Output: ADR 0062 and a fix list | backend-architect | `next.config.ts` (maybe), `src/components/site/site-footer.tsx` (year) | `next build` green; one test that a page with a dynamic hole prerenders the shell |
| P2 | **Spec model additions (ADR 0054):** `placement` and `group` fields on `SPEC_COLUMNS`; `spec-groups.ts` derives from it (admin editor unchanged, same groups); helper `specColumnsFor(placement)`; export `restrictedSpecKeys(visibility)` as a pure function | backend-architect | `src/models/spec-columns.ts`, `src/components/admin/product-form/spec-groups.ts` | **pink = quick test** (exactly the 5 spec keys: housingMaterial, housingFinish, reflectorColor, cutOutSize, cct; Model Name / Model No. are identity); green keys = table; `batchNo` = table; groups still cover all 28 in order; admin form tests unchanged |
| P3 | **Catalog data layer:** `src/lib/catalog/{product,family,related,categories,restricted,view}.ts`: `getPublicProduct(slug)`, `listPublishedSlugs()`, `getFamilyProducts(family, excludeId)`, `getRelatedProducts(product)`, `getBreadcrumb(product)`, `getRestrictedSpecs(productId)`; `PublicProductView` types; variant merge helper (`mergeVariantSpecs`); `unstable_cache` + tags (ADR 0062; read the installed docs first); plain DTOs; `lean()` + projection from visibility | backend-architect | `src/lib/catalog/*` | memory DB: published only; **restricted keys absent from every returned object** for each restricted-key set (default, all-public, all-restricted); view of a product with 1 and N variants; merge rule; unknown/draft slug → null; family strip excludes self and drafts; `getRestrictedSpecs` returns null for visitor / customer-expired / banned and values for active customer and admin; static guard: nothing under `src/lib/catalog` except `restricted.ts` imports `permissions`, and `restricted.ts` is imported only from the dynamic block. **ADR 0063** (catalog layer, view model, projection rule) |
| **Gate A** | QA after P2–P3: leak matrix against the data layer (property test over the 28 keys), tag/expiry test, ADR 0002 compliance | qa-security-reviewer | `test/catalog-gate-a.qa.test.ts` | as listed |
| P4 | **Product page shell:** `src/app/(site)/product/[slug]/{page,loading,not-found}.tsx`, `generateStaticParams`, `generateMetadata`, JSON-LD, breadcrumb, quick-spec panel, spec table (groups, empty hidden, options as chips), `extraSpecs`, `publicFiles`, family + related strips (swipe), applications row, neutral placeholders. Static HTML shows variant 1 and the Models table lists all variants. Components in `src/components/site/product/` | site-frontend | `src/app/(site)/product/[slug]/*`, `src/components/site/product/*`, `src/app/sitemap.ts` | render tests for panel/table; metadata + JSON-LD snapshot has no restricted value; 404 for draft/unknown; axe on a seeded product |
| P5 | **Variant switcher (client):** radio group, selected-variant state, `?model=` sync, readout, live region, table + panel + gallery follow | site-frontend | `src/components/site/product/variant-switcher.tsx`, `product-detail-client.tsx` | unit: merge/selection; e2e: arrow keys, deep link `?model=`, aria-live text, URL change, single-variant product hides the switch |
| P6 | **Gallery (client):** scroll-snap stage, thumbnails, prev/next, counter, native `<dialog>` lightbox with zoom, variant image jump, placeholder | site-frontend | `src/components/site/product/gallery.tsx`, `lightbox.tsx` | e2e: swipe/scroll-snap at 375 px, keyboard, Esc returns focus, zoom keys, no CLS (screenshot compare of box sizes), alt text present |
| P7 | **Restricted block + datasheet button (ADR 0062):** route handler `src/app/api/catalog/restricted/[productId]/route.ts` (backend-architect: Zod, `getRestrictedSpecs`, `private, no-store`); client `<RestrictedBlock/>` with a sized skeleton and a server-rendered no-JS fallback line; four button states | backend-architect (route) + site-frontend (block) | `src/app/api/catalog/restricted/[productId]/route.ts`, `src/components/site/product/restricted-block.tsx`, `datasheet-button.tsx` | route answers by viewer (visitor, customer, expired, banned, admin, `!hasDatasheet`) with `no-store`; invalid id → 400/404; restricted values absent from the static HTML and every prefetch/RSC payload; skeleton height equals final; **ADR 0064** (product page structure, switcher URL, restricted block) |
| **Gate B** | QA after P4–P7: **leak test as a visitor on the real HTML** (page source, RSC payload, JSON-LD, `<meta>`, sitemap, family/related strips) with a product that has every restricted column filled; same page as an expired customer; columns toggled restricted ↔ public (cache expires) | qa-security-reviewer | `e2e/product-page-gate-b.qa.spec.ts`, `test/product-page-gate-b.qa.test.ts` | as listed |
| P8 | **Motion pass:** gallery slide/crossfade, lightbox open/close, optic-switch readout crossfade + changed-value highlight, listing→gallery shared-element view transition (wired but inert until listings exist in 4b), table-section reveal. All behind `prefers-reduced-motion`, only transform/opacity, nothing that delays first paint | motion-engineer | `src/components/motion/product/*` (thin wrappers around P5/P6 hooks) | e2e with `reducedMotion: "reduce"`: no animation, identical final DOM; no console errors; navigating away and back leaves no leaked listeners/triggers |
| P9 | **Exit e2e:** seeded product with two variants and 3 images: open page as visitor → quick panel + table + gallery; switch optic (model no., lumen, efficacy, URL, image change); keyboard-only run; restricted values absent (visitor) and present (admin); 375 px and 1280 px axe; Lighthouse run (perf/a11y/SEO ≥ 90) | qa-security-reviewer | `e2e/product-page.spec.ts` | never `networkidle`; uses the Cloudinary/R2 fakes. **Gate C** (Phase 4a exit, whole branch, Opus): `qa-security-reviewer` first (correctness, safety, accessibility), then **`ui-reviewer`** (visual/polish pass with the real photos) |

After gate C passes: ADR notes, tick `tasks.md`, rewrite Resume (next = Phase 4b planning), push `phase-4`, PR with `gh`, wait for CI, **ask the user before merging into `main`**.

## Things the user must do
- ~~Review the plan; answer Q1–Q7~~ (done 2026-10-08).
- ~~Merge Phase 3~~ (done: PR #12). The CSP fix commit (login/sign-out full page loads) was cherry-picked onto `phase-4` because it had not been pushed.
- ~~Real product photos~~ (done: 2 photos added to a product in the dev DB; the gallery task and the ui-reviewer use them). Add more if you want to judge a longer gallery. No AI-generated images.
- Still open from Phase 3 (not blocking Phase 4): real-credential smoke, `npm run db:indexes` on a scratch DB, client questions.

## Risks
- **`unstable_cache` is superseded** in 16.3.8 (ADR 0062). Mitigation: all use goes through `src/lib/catalog/*`, so migrating to `use cache` later touches one folder.
- **A restricted value leaking through a cache** is the one security-critical risk. Mitigations: projection from visibility (not hiding), a view model with a type-level and runtime key check, `getRestrictedSpecs` isolated and guarded by a static test, gates A and B with a real-HTML leak test.
- **Visibility changes and stale caches:** changing a column to restricted must expire every product entry. `settings:columns` is already expired at once by the shared helper; the test toggles a column and re-reads.
- **The variant URL** (Q3) can show variant 1 for a frame on deep links. Accepted; alternatives make every product page dynamic.
- **Layout shift** from the dynamic block and images: reserved sizes, checked in e2e and Lighthouse.
- **Motion budget:** the page is mostly static; motion work stays small. Anything heavier belongs to Phase 6.
- **Image data:** no stored dimensions, so aspect ratios come from the container; very different photo shapes use `object-contain` on a grey-100 stage.

## ADRs to write (main session)
- **0062:** catalog caching mode (`cacheComponents` or fallback) from the P1 spike.
- **0063:** `src/lib/catalog` layer: view model, projection from visibility, `getRestrictedSpecs` isolation, tags.
- **0064:** product page structure: panel/table placement, switcher URL and announcement, gallery and lightbox, restricted block and button states.

## Verification
- Per task: `npm run typecheck`, `npm run lint`, `npm test`.
- Exit: `npm run build`, `npm run test:e2e`, `npm run audit`, gitleaks; leak test green; Lighthouse ≥ 90 on the product page.
- QA gates: A after P3, B after P7, C at exit (`qa-security-reviewer`, then `ui-reviewer`).
