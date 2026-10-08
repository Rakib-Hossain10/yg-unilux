# 0062 — Catalog caching mode: tag-cached reads without `cacheComponents` (P1 spike result)
- Status: Accepted (the user's condition, 2026-10-08: no app-wide `cacheComponents` unless proven safe for the admin pages and the footer)
- Date: 2026-10-08
- Refines: [0008](0008-caching.md). Keeps: [0002](0002-restricted-specs-and-caching.md), [0024](0024-permissions-and-auth-interrupts.md), [0036](0036-admin-shell.md).

## Context
ADR 0008 planned `cacheComponents: true`. The P1 spike on Next 16.3.8 enabled it on a scratch tree (nothing committed, tree restored).
- **Build:** went green after three fixes. (1) Delete `export const runtime = "nodejs"` from the two route handlers that have it. (2) Compute the footer year in a `"use cache"` + `cacheLife("days")` helper. (3) `export const instant = false` on `src/app/admin/layout.tsx`. `experimental.authInterrupts` is compatible.
- **Tag pattern proven:** `"use cache"` + `cacheTag(CATALOG_TAGS.*)` reading MongoDB through the existing db layer; a real admin save (`updateTag` via `revalidateCatalogInAction`) changed the cached output. A `"use cache"` function that calls `viewerCanSeeRestricted()` fails at request time (500), as documented, so cached code can never see the session.
- **Streamed restricted block proven:** the prerendered shell and the static prefetch payloads hold only the fallback; pages with a dynamic hole answer `private, no-cache, no-store` to every viewer.
- **Blocker:** with the flag on, every admin route streams the static root shell before `requireAdmin()` throws. A signed-in customer then gets **HTTP 200** with the forbidden UI instead of 403 (e2e `a customer gets a real 403 on /admin` fails; 28 of 29 pass, 29 of 29 with the flag off), and a forged cookie gets 200 with an in-stream redirect. The installed docs say the status must then come from `proxy.ts`, which would need a DB-backed role check on every `/admin` request (a second guard; `requireAdmin()` stays everywhere).

## Decision
1. **`cacheComponents` stays off.** The real 403/307 behaviour of ADR 0024/0036 is unchanged, with no change to `proxy.ts`.
2. **Catalog reads** (`src/lib/catalog/*`) use `unstable_cache(fn, keyParts, { tags })` with the `CATALOG_TAGS` / `productTag` tags, invalidated only through `src/lib/revalidate.ts` (`updateTag` works without `cacheComponents`). The P3 task re-checks the exact `unstable_cache` API in the installed 16.3.8 docs before writing it.
3. **Product pages are static (ISR)** through `generateStaticParams` over published slugs (an empty list is allowed without the flag, so CI builds with no database).
4. **The restricted block is a client component** that fetches `/api/catalog/restricted/[productId]`: `getViewer` → `canSeeRestricted` → `getRestrictedSpecs`, Zod on the id, `Cache-Control: private, no-store`. The page response never contains a restricted value (ADR 0002's "small session-checked endpoint" form, the strongest reading of rule 9). The same call returns the datasheet button state. The block reserves its final height, so there is no layout shift. The page must not read `headers()`/`cookies()`, or it becomes dynamic and loses its static HTML.
5. Cached functions return **plain DTOs** (string ids, ISO dates) from explicit projections. They never call `getViewer` or `viewerCanSeeRestricted`.

## Consequences
- No PPR shell with a streamed block; the restricted block costs one client request and a skeleton.
- `unstable_cache` is marked "replaced by `use cache`" in 16.3.8: migration debt.
- **Revisit when** the team accepts a DB-backed admin role check in `proxy.ts`, or Next gives a real status for auth interrupts under PPR. Then apply the three spike fixes, move to `"use cache"` + `cacheLife("max")`, use a sentinel `generateStaticParams` entry for CI (an empty list is a build error under the flag), and keep `revalidateTag(tag, "max")` with build-time shells rather than `use cache: remote`.
- The Vercel default `use cache` store is per instance; `unstable_cache` persists across instances and deploys, which suits ~500 products.
- Not run in the spike: the `revalidateTag(tag, "max")` route path, Vercel's CDN behaviour, the full admin e2e suite under the flag.
- A cached `null` (unknown or draft slug) lives until the tag is invalidated: publish and create actions must expire `products` (they already do).
- Tests: the restricted route needs Zod on the id, the `canSeeRestricted` matrix and the visitor-HTML leak test (gates A and B).
