# 0008 — Caching and query performance
- Status: Accepted (exact API pending Phase 0)
- Date: 2026-09-30

## Context
500+ products, read-heavy public catalog, rare admin writes.

## Decision
- **No cache inside MongoDB.** Use the Next.js data/page cache for public catalog data.
- Invalidate by tag whenever the admin saves a product, category, area, datasheet, column visibility, or finishes a bulk import.
- Tags (initial): `products`, `product:<id>`, `categories`, `areas`, `settings:columns`, `datasheets`.
- Restricted data is never cached (ADR 0002).
- Database: indexes on product `slug` (unique), `mainCategory`, `extraCategories`, `areas`, `family`, `variants.modelNo`, `status`; cached global Mongoose connection; `lean()` queries with field projection; Atlas Search index for the search box.

## Pending (Phase 0, step 3)
The caching API must be taken from the docs of the **installed** Next.js version (`node_modules/next`), not from memory. Record here:
- Next.js version: _TBD_
- Cache directive / function: _TBD_
- Tagging API: _TBD_
- Invalidation API + signature: _TBD_
- How dynamic blocks opt out of caching: _TBD_

## Consequences
- Every admin mutation calls one shared `revalidateCatalog(...)` helper so no save path forgets invalidation.
