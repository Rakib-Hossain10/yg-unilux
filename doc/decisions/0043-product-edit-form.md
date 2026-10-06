# 0043 — Product edit form (T10a): status outside saves, optimistic concurrency, real 404
- Status: Accepted
- Date: 2026-10-06

## Context
T10a builds `/admin/products/[id]` section (a): basics, categories, areas, track size, filters, status card, delete. T10b adds specs, variants, extra specs and public files later. Two per-file review findings shaped the design:
- Saves after the first did nothing, because the redirect left the in-flight flag set.
- A save from a stale tab sent the page's old `status`, plus every field the form doesn't edit yet, and overwrote newer data. For example, it re-published a product that had been unpublished in another tab.

## Decision
1. **Round-trip of fields the form doesn't edit yet.** `specs`, `variants`, `extraSpecs`, `publicFiles` and `datasheetId` sit in form state and are sent back unchanged. `toProductInput` passes unparseable text through raw, so the strict `productInputSchema` rejects it on the server instead of silently dropping it.
2. **Status never travels through a save.** The form sends no `status`, and `updateProduct` ignores it and always audits `product.update`. Status changes only through `publishProduct` / `unpublishProduct`.
3. **Published products stay publishable.** A save that would break `publishCheck` on a published product, for example removing the last variant, is refused. This replaces the publish check that used to run on save.
4. **Optimistic concurrency.** Save, publish and unpublish send the `updatedAt` the page loaded (`expectedUpdatedAt`, validated as an ISO date-time). The service refuses with `PRODUCT_CHANGED` ("This product changed since you opened it. Reload to see the latest version.") in two cases: the stored value differs at read time, or the conditional `updateOne({_id, updatedAt})` matches nothing while the product still exists. Leaving the option out skips the check, so older callers keep working. The admin actions always pass it.
5. **Error mapping** (`product-form/field-errors.ts`). Server keys and Zod paths map onto form fields, including `variants.N.modelNo`. An error on a field without an input on screen goes to a labelled form-level alert, which takes focus.
6. **Actions.**
   - Save redirects to the same page with `updated` / `unchanged`.
   - Publish and unpublish stay on the page and `refresh()`.
   - Delete has a confirm dialog and redirects to the list with `deleted`.
   - Every in-flight guard is released in `finally`.
   - Publish is `aria-disabled` while the form has unsaved changes.
7. **Real 404 for an unknown product.** A `loading.tsx` anywhere above `[id]` turns `notFound()` into a 200. So `admin/{page,loading}` moved to `admin/(dashboard)/` and `products/{page,loading}` to `products/(list)/`, and URLs are unchanged. `products/[id]` has no `loading.tsx`. Categories and areas `[id]` keep theirs, so gate A's L-1 still applies to them.
8. Track size shows when the main category or any extra category is Magnetic Track or one of its subcategories, which matches the ADR 0041 service rule.

## Consequences
- T10b adds each new section's fields to `isRenderedField` (`sections.ts`) and replaces `variants-summary.tsx` with a `useFieldArray` editor. It must not add a `loading.tsx` above `products/[id]`.
- Later writers to products (bulk import in Phase 3, the datasheet picker in T13) are protected from stale form saves. The import itself does not pass a version.
- Backend follow-ups (not blocking):
  - `invalidInput` flattens nested Zod paths to top-level keys, so nested server errors land on the alert, not the row.
  - The Magnetic Track rule is duplicated in `product-category-options.ts`; a shared helper would remove it.
  - Export the createDraft schema.
- The resolver re-parses the whole schema on each change after the first submit. Measure this with large variant lists in T10b.
