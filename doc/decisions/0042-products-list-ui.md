# 0042 — Products list UI and move guard
- Status: Accepted
- Date: 2026-10-06

## Context
T9 adds `/admin/products` (list) and `/admin/products/new` (draft), and fixes QA gate A's L-4 and L-5.

## Decision
1. The list filters are a plain GET form, so every view is a URL. Status or category values the UI cannot show fall back to "all"; the service still re-validates. A category filter also matches its subcategories. 25 rows a page, Previous/Next keep the filters.
2. New product = name + main category (shown as "Main › Sub"), then redirect to `/admin/products/<id>?notice=created`. That page 404s until T10, which must read the `created` notice.
3. After a failure that may have saved, the form's in-flight guard stays locked, so Enter cannot create a second draft.
4. Category and area moves share `useSerialAction` (`useRef` in-flight guard): two fast clicks send one move (L-5).
5. A stale `?notice=` is cleared with `router.replace(pathname)` only after the on-page write settles. Clearing before it makes Next discard the running Server Action's result (L-4).
6. E2e specs that reorder categories or areas belong in the serial `e2e/admin-catalog.qa.spec.ts`; separate parallel specs shift the edge buttons.

## Consequences
- Follow-up: export the createDraft schema from `schemas/product.ts` (the form copies it) and `MAX_PRODUCT_SEARCH_LENGTH` from `constants.ts`.
- Table dates show UTC; thumbnails wait for T11b.
