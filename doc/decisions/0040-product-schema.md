# 0040 — Product form schema
- Status: Accepted
- Date: 2026-10-06

## Context
T7 adds the strict Zod schema for the admin product form (`src/lib/schemas/product.ts`). The client form resolver and the T8 service parse with the same schema.

## Decision
1. The schema is pure and client-safe. Plain constants (`PRODUCT_STATUSES`, `TRACK_SIZES`) live in the import-free `src/models/product-constants.ts`; `models/product.ts` re-exports them. A static test fails if the schema imports `@/lib/db`, `@/models/product` or `server-only` (found by the auto-review).
2. All objects are strict. `images`, `featured`, `_id` and timestamps are not form fields; images get their own save action (T11b).
3. `specs` accepts exactly the 28 `SPEC_KEYS` as trimmed string lists (blank dropped). `variants[].specs` holds only values that differ from the product level. `modelNo` is unique inside the form, case-insensitively.
4. `publicFiles` URLs must be `https://`, with no credentials or whitespace.
5. `publishCheck()` takes stored facts (`mainCategory`, `variants`, `images`). The schema does not enforce publishing: T8 must run it on the stored product and refuse `status: "published"` when it returns problems.

## Consequences
- T8 must also check `trackSize` only for Magnetic Track, that category, area and datasheet ids exist, and turn a duplicate `modelNo` index error into a field error.
