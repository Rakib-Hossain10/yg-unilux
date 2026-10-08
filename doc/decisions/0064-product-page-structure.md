# 0064 — Product page: structure, variant switcher URL, gallery, restricted block
- Status: Accepted
- Date: 2026-10-08
- Builds on: [0002](0002-restricted-specs-and-caching.md), [0027](0027-security-headers-csp.md), [0054](0054-product-page-spec-placement.md), [0062](0062-catalog-caching-mode.md), [0063](0063-catalog-data-layer.md).

## Context
Phase 4a (tasks P4–P7, `doc/phase-4-plan.md`) builds `/product/[slug]` as an ISR page from the cached public view (ADR 0062/0063). Restricted values must never be in the static HTML, RSC payload, JSON-LD, metadata, sitemap or strips (CLAUDE.md rule 9). This records the choices made while building it.

## Decision
### Page shell (P4)
1. **No `loading.tsx`** on the product route: with it, an unknown slug answered 200 instead of 404. Drafts and unknown slugs are 404 for everyone.
2. **Sitemap** is `force-dynamic` and answers 500 without `SITE_URL` (e2e servers must set it). Only published products.
3. **JSON-LD**: `ProductGroup` + `hasVariant` for 2+ variants, else `Product`; brand, sku per variant, no price, no spec values. Written as the script's text child (no `dangerouslySetInnerHTML`, banned by a QA test); `serializeJsonLd` escapes `<`.
4. The first gallery image uses `preload` (Next 16 deprecates `priority`). Labels are sentence case. The Models table shows only for 2+ variants (lumen, efficacy and the public columns that differ).
5. Stable hooks for tests and motion: `data-slot` (product-gallery, quick-spec-panel, variant-switcher, datasheet, restricted-specs, gallery-track/-thumbnails/-counter, lightbox, lightbox-frame), `data-field`, `data-readout`, `data-variant-index`, `data-section`, `data-gallery-slide`, `data-current`, `data-zoom`, `data-restricted`, `data-datasheet-state`.

### Variant switcher (P5)
6. One client provider (`ProductDetailClient`) holds the selected variant; the panel, table and Models rows stay Server Components with small client leaves. Client props are copied field by field from the public view.
7. **`?model=`** is read on the client after hydration (`useSyncExternalStore`, null server snapshot), so the ISR HTML always shows variant 1 and hydrates without a mismatch. Switching uses `history.replaceState` (no navigation, no scroll, no request). An unknown `?model=` falls back to variant 1 and is removed from the URL. Matching is case-insensitive (ADR 0055).
8. A native radio group with a polite live region ("AR-013A2 selected, 1200 lumens, 100 lm/W"). Changed values get a short highlight (`.variant-value[data-changed]`), a tint under reduced motion.
9. **Rows show if any variant fills them** ("–" with "Not applicable for this model" for the selected one when empty), so a switch never adds or removes a row. This differs from the plan's "empty hidden", which still applies to columns no variant fills.

### Gallery (P6)
10. Clicking the stage slide or "View larger" opens the native `<dialog>` lightbox; thumbnails only select. Focus goes back to the opener. Zoom 1x/2x (`ZOOM_LEVELS`): arrows pan when zoomed and change image at 1x. The lightbox stays empty until it opens, uses `sizes="200vw"` when zoomed, on a white sheet.
11. The gallery jumps to a variant's picture only when the variant changes: instantly for a deep link or reduced motion, not at all when the variant has no picture. Slides are named "View larger: {alt}", thumbnails have `alt=""` plus "Show image n of N", and only the shown slide is in the tab order. Alt numbering counts only images that can be served; drawings get a label per kind (dimension, installation).

### Restricted block (P7)
12. **Route** `GET /api/catalog/restricted/[productId]` (backend), `private, no-store` on every answer. Id checked with Zod (`objectIdSchema`): malformed → 400 `{message}`; unknown or draft → **404** `{message}` (also when the product is unpublished between the two reads). 200 refused `{allowed:false,state}`; 200 allowed `{allowed:true,state,keys,specs,variants:[{modelNo,specs}]}`. It never returns a datasheet id, URL, key or file name.
13. **Button state** (`src/lib/datasheet-state.ts`), in this order:
    - `coming-soon` first: no `datasheetId` → "Datasheet coming soon" for every viewer, also an allowed one (the restricted rows still show for them);
    - `download` for an active customer or admin;
    - **`banned` → `expired`** ("Access expired — contact us"): a blocked customer is told to contact us, not that the account is blocked;
    - **temporary password → `signin`**, and also signed out or another role.
14. **Temporary password, checked:** `/login` does **not** redirect a `mustChangePassword` user to `/change-password` today. The login form sends a customer to `/` (admin to `/admin`, where `requireAdmin` redirects to `/change-password`), and `/change-password` does not exist yet (Phase 5). So a signed-in customer on a temporary password who clicks "Sign in to download" gets the sign-in form again. **Phase 5 must** add `/change-password` and make `/login` (or the login form's destination) send a `mustChangePassword` user there.
15. **Session read twice:** the route reads the viewer for the button state, and `getRestrictedSpecs` reads it again before any restricted read (ADR 0063 decision 6). This is deliberate: the reader never trusts its caller. `getViewer` is React `cache()`d, which may dedupe within a request, but correctness does not depend on it. If the two reads disagree (access revoked in between), the reader returns null and the route answers 404 with no restricted data.
16. **Client block** (`restricted-block.tsx`, `datasheet-button.tsx`, `restricted-data.ts`): one `RestrictedDataProvider` inside `ProductDetailClient` fetches once after hydration (`cache: "no-store"`, same-origin cookies, aborted on unmount) and feeds both slots. Only the product id crosses into it. The server render and the first client render show only the slot's fallback (visitor text), so no restricted value is in static HTML or the RSC payload. Any failure (offline, non-200, unknown shape) keeps the fallback. The answer is parsed defensively: unknown keys and non-string values are dropped.
17. Restricted rows follow the selected variant: by index when the model no. matches, else by model no., else product-level values. The route already merges product values into each variant. Rows are every restricted column the product or any variant fills, in sheet order, in their own "For approved customers" table under the spec table (`<caption>` names the shown model, `<th scope="row">`). The public quick panel never shows a restricted column, even a "quick" one.
18. **Reserved height.** The datasheet slot is `min-h-31` (7.75 rem), which fits every state at 360–1920 px, so the swap never moves the panel (e2e checks this at 1280 and 360). The restricted-specs slot keeps `min-h-24`. For an allowed viewer it grows by the rows: the page cannot know how many rows without reading restricted data. The slot sits below the fold, after the public table.
19. Links are plain `<a>` (full page loads, ADR 0027 note): download → `/api/datasheet/{productId}` (built in Phase 5, 404 until then), expired → `/contact` (page not built yet), sign in → `/login`. Page modules keep their own copy of the state union (importing `datasheet-state.ts` would reach `permissions`/auth through the static guard); a compile-time test keeps the two equal.

## Consequences
- The page stays fully static. Every viewer makes one small uncached request per product view.
- An expired customer whose product has no datasheet gets "coming soon", and the specs slot still says "Sign in" (the refused answer carries only the state, not the reason).
- Gate B checks the leak on real HTML/RSC with every restricted column filled.
- Phase 5: build `/api/datasheet/[productId]` and `/change-password`, send temporary-password users there from `/login`, and build `/contact`.

## Addendum (Phase 4a exit, gate C)
20. **Performance:** the first gallery image is `fetchPriority="high"` + `loading="eager"` (not `preload`). The lightbox is a lazy chunk mounted on first open behind an error boundary (a failed chunk renders nothing and the next click retries); no `<dialog>` in the server HTML. Display italic is declared but not preloaded (ADR 0028 note). Header links to routes not built yet use `prefetch={false}` (remove per route when built). No `content-visibility` on sections (made specs flaky). Lighthouse mobile perf 90-93, a11y/SEO 100.
21. **Slugs:** `proxy.ts` answers a plain uncached 404 for `/product/<slug>` that cannot be a slug (`SLUG_PATTERN`, `MAX_SLUG_LENGTH`). Well-formed unknown slugs still reach the page and their 404 is stored in the page cache (bounded by the `products` tag; closing it needs a DB lookup). Add a Vercel Firewall rate limit on `/product/*` and `/api/catalog/restricted/*`.
22. **Refused restricted answer** carries `access: "expired" | "signin"` (banned = expired), separate from the button `state`.
23. **Images:** photos `object-cover`, drawings `object-contain` + multiply on the frame grey, lightbox always contain on an ink background. Strip cards 4:5 (`STRIP_CARD_FRAME`, reused by 4b listing cards). Per-image focal point may be needed for off-centre client photos.
24. **Panel:** datasheet is a 56 px row from `lg` (stacked `min-h-31` card below); description (clamped at 240 chars with "Read more") sits below the datasheet so the datasheet is in the first screen at 1280x800; title steps down by name length; readout in lining numerals; chips flat grey-100; Models table numbers right-aligned, "Select"/"Selected"; desktop nav from `lg`.
25. **Open polish (not blocking):** Models table stacked layout on mobile (M-4), "–" union rows (M-6), empty application tiles (L-1), lone expand icon on single-image products, duplicate mobile gallery controls, mobile menu scrim, 44 px footer links, long name + family eyebrow puts the datasheet 28 px below the fold, footer links lack `prefetch={false}`, `favicon.ico` is the create-next-app default, admin CSS utilities ship globally.
