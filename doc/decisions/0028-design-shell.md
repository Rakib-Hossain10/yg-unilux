# 0028 — Design shell: typefaces, tokens, route groups, status pages
- Status: Accepted
- Date: 2026-10-04
- Implements: Phase 1 task 11

## Context
CLAUDE.md "Design" fixes the palette (black, white, warm greys from the logo), the header layout, reduced-motion support and mobile behaviour. The Phase 1 decision was "two Google Fonts, bundled with `next/font`". On 2026-10-04 the user picked the pairing.

## Decision
- **Typefaces** (`src/app/fonts.ts`):
  - **Cormorant Garamond** for headings and the wordmark: variable, wght 300–700, with italics;
  - **Inter** for body, navigation and spec tables: variable.
  - Latin subset only; `display: swap`.
  - `next/font` downloads them at build time and serves them from our origin, so `font-src 'self'` holds (ADR 0027) and no runtime request goes to Google. Verified in a browser.
- **Tokens** in `src/app/globals.css`, via Tailwind 4 `@theme`:
  - colours: `ink` (#111110), `paper` (#fff) and warm greys `grey-50…900`, which lean red-yellow and never blue;
  - fonts: `font-display` and `font-sans`;
  - motion: `ease-calm`, `duration-quick` (200 ms) and `duration-calm` (600 ms);
  - layout: `container-site` (90 rem).
  - The site is light-only (`color-scheme: light`). Photography carries the colour.
- **Contrast rules** (QA H2; ratios computed from the tokens):
  - on white, text uses grey-500 (4.53:1, small labels only) or darker;
  - on ink, text uses grey-400 (7.32:1) or lighter;
  - grey-400 is never used for text on white, and grey-500 is never used for text on ink (4.17:1);
  - a Vitest QA test reads `globals.css` and checks every grey class used in the shell.
- **Base styles:** one global `:focus-visible` outline in `currentColor`, so it is visible on dark sections such as the footer as well as on white (QA H1). Under `prefers-reduced-motion: reduce`, every transition and animation becomes instant site-wide. Motion work in Phase 6 must still check the setting itself.
- **Route groups:**
  - `(site)` wraps public pages in `SiteShell`: skip link, header, `<main id="content">`, footer. The home placeholder moved into it.
  - The root layout holds only the document, the fonts and the styles, so `/blocked`, `/admin` (Phase 2) and the error pages choose their own chrome.
  - `(account)` (task 12) will reuse `SiteShell`.
- **Header** (Server Component; only the mobile menu toggle is a client component):
  - wordmark left, a text placeholder until the logo SVG arrives;
  - Product, Services, OEM/ODM, R&D and About us centred;
  - search (`/search`, Phase 4) and account (`/login`) icons right;
  - no language control;
  - on small screens the menu is a native `<details>` disclosure, inside the only client component, `mobile-menu.tsx`. It closes the menu on route change (`usePathname`), on Escape (focus goes back to the toggle) and on a press outside (QA M1). Without JavaScript the native toggle still works.
  - Footer links use `prefetch={false}`, so a page view doesn't prefetch a dozen rarely used routes (QA L3).
  - The nav targets live once in `nav-links.ts`, shared with the footer.
- **Status pages** share `StatusPage`:
  - `not-found.tsx` (404) and `forbidden.tsx` (403 from `requireAdmin()`) are root files that render inside `SiteShell`, are `noindex`, and say only "No access", never which rule failed;
  - `(site)/error.tsx` keeps the chrome, offers Try again via `retry()` (stable in 16.3) and shows only `error.digest`, which Next makes generic in production;
  - `global-error.tsx` renders its own document with inline styles, because global styles don't load there and the CSP allows inline styles.
- **Titles:** the root template is `"%s | YG UniLUX"`. Pages set only their own part.

## Consequences
- Pages behind the nav links show the 404 until their phase lands.
- The footer copyright year is fixed at build time for static pages and updates with each deploy. **Phase 4:** `new Date()` during prerender breaks once `cacheComponents` is on (QA L1). Move the year into a `"use cache"` helper or a build-time constant then.
- Tests must not wait for Playwright's `networkidle`. Prefetches that end in a 404 never settle in Chromium (QA L3), so use web-first assertions.
- Changing a typeface means editing `fonts.ts` and re-checking the spec-table layout.
