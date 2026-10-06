# 0008 — Caching and query performance
- Status: Accepted (API confirmed from the installed Next.js 16.3.7 docs; the storage choice for Vercel is still open for Phase 4). The `revalidateCatalog(...)` helper is refined by [0035](0035-admin-write-path.md): `revalidateCatalogInAction` / `revalidateCatalogFromRoute`, with `settings:columns` always expired at once.
- Date: 2026-09-30

## Context
500+ products, read-heavy public catalog, rare admin writes.

## Decision
- **No cache inside MongoDB.** Use the Next.js data/page cache for public catalog data.
- Invalidate by tag whenever the admin saves a product, category, area, datasheet, column visibility, or finishes a bulk import.
- Tags (initial): `products`, `product:<id>`, `categories`, `areas`, `settings:columns`, `datasheets`.
- Restricted data is never cached (ADR 0002).
- Database: indexes on product `slug` (unique), `mainCategory`, `extraCategories`, `areas`, `family`, `variants.modelNo`, `status`; cached global Mongoose connection; `lean()` queries with field projection; Atlas Search index for the search box.

## Installed API (Next.js 16.3.7, read from `node_modules/next/dist/docs/01-app/` in Phase 0)
- **Enable:** `cacheComponents: true` in `next.config.ts` (it is opt-in and needs the Node.js runtime). This turns on `"use cache"`, `cacheLife` and `cacheTag`, and makes Partial Prerendering the default. It is not enabled yet; that happens in Phase 4.
- **Directive:** `"use cache"` on a file, component or async function. The key is build ID + function ID + serialisable args + closure variables. Cached code **cannot** call `cookies()`, `headers()` or `searchParams`, and the restriction follows the call stack.
- **Tagging:** `cacheTag(...tags: string[])`. Tags are at most 256 chars and case-sensitive. Lifetime is set with `cacheLife(profile)`, where `max` means stale 5 min, revalidate 30 days, never expire.
- **Invalidation:** `revalidateTag(tag, profile)`. The two-argument form is required; the single-argument form is deprecated. Use `"max"` for stale-while-revalidate, or `{ expire: 0 }` for immediate expiry outside Server Actions.
  - `updateTag(tag)` works only inside Server Actions: the next request waits for fresh data (read-your-writes).
- **Per-request (dynamic) blocks:** don't use `"use cache"`. Wrap the component in `<Suspense>` and read a runtime API (`cookies()`/`headers()`), or call `await connection()` from `next/server`. `<Suspense>` alone does not make anything dynamic.
- **Vercel caveat:** the default `"use cache"` store is in memory and usually does not persist across serverless requests; build-time output does. The durable shared option is `"use cache: remote"`. Phase 4 decides between build-time shells + `revalidateTag(tag, "max")` and `"use cache: remote"`.

## Rules added from these findings
- The shared helper `revalidateCatalog(...)` uses `updateTag` inside admin Server Actions, so the admin sees the change on the next request, and `revalidateTag(tag, "max")` everywhere else (bulk import jobs, route handlers).
- **Never** use `"use cache: private"` for restricted specs: its results are kept in the browser. Restricted data stays fully dynamic (ADR 0002).

## Consequences
- Every admin mutation calls one shared `revalidateCatalog(...)` helper so no save path forgets invalidation.
