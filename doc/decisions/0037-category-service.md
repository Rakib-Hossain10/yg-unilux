# 0037 — Category service rules
- Status: Accepted
- Date: 2026-10-06

## Context
T4 builds the first admin write service on the ADR 0035 path. Its choices set the pattern for areas, products, datasheets and settings.

## Decision
1. **Shared result module** `src/lib/admin/write-result.ts`: `ServiceResult`, errors in `z.flattenError` shape (maps straight onto React Hook Form), `auditAndFinish`. On audit failure the result is `ok:false` but still carries `tags`; actions revalidate on both branches before deciding to redirect.
2. **Tags:** create, move, delete → `categories`; edit → `categories` + `products` (product pages show category names and slugs).
3. **No-op writes** (unchanged edit, move at an edge) return `ok:true`, `tags: []`, no audit entry.
4. **Move** renumbers siblings 0..n-1 and writes only changed rows, so tied or gapped orders self-repair. Changing parent sends the category last under the new parent.
5. **Depth** is generic: parent depth + 1 + subtree height ≤ `MAX_CATEGORY_DEPTH`. Self-parent and cycles are refused.
6. **Slugs:** unique per parent. Blank on create → auto from name (-2, -3…); blank on edit keeps the current slug; a typed collision is a field error (never silently renamed). Duplicate-key races map to the same error.
7. **Delete** is blocked by children or by products using it as `mainCategory`/`extraCategories`; both blockers are reported together.
8. Inputs are `unknown` and re-parsed with strict Zod (no mass assignment, no operator objects as ids). The actor id must be an ObjectId or the service throws before writing.
9. Shared schema helpers live in `src/lib/schemas/common.ts`.

## Consequences
- `icon` and `coverImage` are left out of the category schema until T11 (uploader) and Phase 4.
- Delete check-then-delete and move read-then-bulkWrite are not atomic; acceptable with one admin (ADR 0035 point 5).
- T5 actions: `requireAdmin()` first, pass `viewer.user.id` as actor, parent picker offers main categories only, show `formErrors` above the form.
