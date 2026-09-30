# 0002 — Restricted specs never reach a cache
- Status: Accepted
- Date: 2026-09-30

## Context
Product pages should be cached for speed across 500+ products, but restricted columns (default: Batch No., Chip Type, Holder, Chip Efficiency, Driver) must be visible to active customers and the admin only.

## Decision
- The public product page is cached. It is built from queries whose projection **excludes restricted fields** — they are never loaded, not just hidden.
- Restricted specs and the datasheet button render in a separate dynamic block (`<Suspense>` with a session check) or a small session-checked endpoint returning `Cache-Control: private, no-store`.
- One uncached function (`getRestrictedSpecs`) is the only code that reads restricted fields for the site.
- Column visibility is read from settings; changing it invalidates the catalog cache.

## Hard rule
Restricted values must never appear in any cached HTML, cached data entry, shared/CDN cache, search result, related/family strip, JSON-LD or sitemap.

## Consequences
- A Playwright test fetches public pages as a visitor and asserts no restricted value is present in the HTML.
- Code review checks every `lib/catalog` projection.
