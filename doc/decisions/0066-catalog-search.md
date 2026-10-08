# 0066 — Catalog search: Atlas index, fallback, route
- Status: Accepted
- Date: 2026-10-08
- Phase 4b, task L2 (`6ed3966`). Plan Q9; refines ADR 0006.

## Decision
1. **Index `products_search`** (`src/lib/catalog/search-index.ts`): `dynamic: false`; `name`, `family`, `type` as `string` + `autocomplete` (edgeGram 2–15, foldDiacritics); `variants` as `document` (`dynamic: false`) with `modelNo` as `string` + `autocomplete` on a custom `lowercaseKeyword` analyzer (edgeGram 2–20, whole-code prefixes); `status` as `token`. Public fields only; a test asserts no spec key is indexed. Category names are not indexed: categories are matched in memory on the cached tree.
2. **`npm run db:search-index`** creates the index if missing, updates it when our definition is not contained in Atlas's `latestDefinition` (Atlas default keys ignored, so reruns never rebuild), never drops. Non-Atlas server → exit 1 with a clear message, driver text withheld.
3. **`$search`:** compound `filter` equals status published (drafts never use up the limit) + `should` boosts: model no. exact 10, model no. autocomplete 5, name 3, family 2, type 1; `minimumShouldMatch: 1`; then a fail-closed `$match` published, `$limit 12`, `$project` card fields + `variants.modelNo` (used server-side only for `matchedModelNo`, then dropped).
4. **Fallback only when `$search` throws** (ADR 0006): one `console.warn` with codeName/code only (never the query). Escaped `i` regexes: model-no. anchored prefix, name/family/type contains. Ranking exact model no. > model-no. prefix > name prefix > contains, ties by lowercased name then `_id`. Collection scan is accepted (~500 products, degraded mode). **Fallback results are not cached**, so a degraded answer never outlives an outage.
5. **Caching:** Atlas results in `unstable_cache` keyed by the lowercased normalised query + `CATALOG_CACHE_VERSION`, tags `products`, `categories`. Categories: name-prefix first, then tree order, max 6, each with `path` (names) and `slugPath` (sub slugs repeat across parents, ADR 0065).
6. **Normalisation:** NFKC, control/default-ignorable characters removed, whitespace collapsed; 2–64 code points or an empty result; raw > 256 rejected.
7. **Route `GET /api/catalog/search?q=`:** Zod; repeated `q`, raw > 256 or trimmed > 64 → 400 (the input uses `maxLength=64`); < 2 chars or missing → 200 empty. 200 `private, max-age=30` (no `s-maxage`); errors `private, no-store`, generic 500. No session, no IP, no query text in logs. Static guard: the route reaches no session module and no `restricted.ts`.
8. **`matchedModelNo`:** the stored model no. the query equals (preferred) or prefixes, compared with `modelNoKey` (ADR 0055); results link to `/product/<slug>?model=<modelNo>`.

## Consequences
- On Atlas, a missing index name returns **no results** rather than an error, so search is empty until `db:search-index` has run and the index is READY. Follow-up option: also fall back on zero Atlas hits.
- Not yet checked on a real Atlas cluster (analyzer in autocomplete, maxGrams 20, document mapping): manual check after the user runs the script.
- Category hits may include categories with no published products (decide in L6 / gate A).
- Add a Vercel Firewall rate limit on `/api/catalog/search` at launch.

## Addendum (2026-10-08, QA gate A fixes)
- **Zero-hit Atlas answers are never cached (gate-A L-2):** an empty answer is asked again on the next request, so search becomes live as soon as the index is READY, and junk queries add no cache entry. Cost: one uncached `$search` (limit 12) per zero-hit request; the Firewall rate limit stays on the launch list.
- **Categories with no published product in their subtree are hidden from search (gate-A I-2):** a draft-only category name would reveal an unreleased line. `listPublishedCategoryCounts` (`category-counts.ts`, one cache entry, tags `products` + `categories`, visibility-independent) feeds `categoriesWithPublished` (a category counts through any descendant; main and extra categories count). Resolves the Consequences note above. The mega-menu decides separately (L6).
- **`db:search-index` reports health (gate-A L-3):** READY exit 0; FAILED / DOES_NOT_EXIST / DELETING exit 1; PENDING / BUILDING / not listed yet warn (exit 0), STALE or any queryable rebuild warns as "serving". `--wait [--timeout=<1..3600 s>, default 600]` polls until READY and exits 1 on FAILED or timeout (building or serving). Run as `npm run db:search-index -- --wait`.
