# 0049 — Settings service
- Status: Accepted
- Date: 2026-10-07
- Builds on: [0002](0002-restricted-specs-and-caching.md), [0019](0019-models.md), [0035](0035-admin-write-path.md), [0003](0003-geo-block-env-only.md)

## Context
The admin needs to change which spec columns are restricted, the WhatsApp number and the company email. ADR 0019 keeps settings in `siteContent` (one document per key, 11 collections only).

## Decision
1. **Storage.** `siteContent` keys `settings.columnVisibility`, `settings.whatsappNumber`, `settings.companyEmail` (constants in `src/lib/schemas/settings.ts`). Written with an upsert on `key`; clearing the number or email deletes the document (the `value` field is required), and a missing document reads as null. There is no geo-block setting (ADR 0003).
2. **Column visibility.** The form schema is a strict object with all 28 spec keys, each `public | restricted`, so a missing or misspelled column is an error rather than a public one. With nothing stored, `DEFAULT_COLUMN_VISIBILITY` (from `SPEC_COLUMNS`; restricted: Batch No., Chip Type, Holder, Chip Efficiency, Driver) applies. Reading a stored value **fails closed**: any key that is not exactly `"public"` counts as restricted.
3. **Save and tags.** `saveColumnVisibility` returns `settings:columns` and `products`. The setting is saved first, then the cleanup runs, so the restriction is live even if the cleanup fails; that failure returns a form error and still returns the tags. The filter cleanup is idempotent and covers every restricted column, not just newly restricted ones, so a retry after a failed cleanup repairs the products (it matches only products that have the fields and keeps `updatedAt`, which ADR 0043 uses for edit conflicts). A failed cleanup still audits the saved change (`cleanupFailed: true`). A save with no visibility change writes and audits nothing, and returns tags only if the cleanup changed products.
4. **Filter cleanup.** A column newly made restricted that feeds a listing filter (`cct`→`cctK`, `cri`, `beamAngle`→`beamDeg`, `ugr`, `wattage`, `ipRating`→`ip`) has `filters.<name>` removed from every product with one `updateMany`, so filters cannot be used to probe restricted values. Making a column public again does not restore filters; the next import or product save recomputes them.
5. **WhatsApp number.** Input may contain `+`, spaces, dashes, dots and brackets; the stored value is digits only, 8 to 15 long, no leading `0`, a leading `00` stripped (the `wa.me` form). `""` clears it.
6. **Company email.** Trimmed, lowercased, valid email; `""` clears it, and the site then uses the `COMPANY_EMAIL` env value.
7. **Audit.** Actions `settings.columns.update`, `settings.whatsapp.update`, `settings.email.update` (already in the vocabulary) with target `{type: "settings", id: <siteContent key>}`. `meta` holds column keys and counts for columns, and only `{isSet: boolean}` for the number and email. Never the number or the address.
8. **No tags for number and email.** No cached catalog data holds them, and no catalog tag exists for them, so those writes return `[]`. If a cached page later renders them, add a tag then.
9. **Guard.** Like the other services, these take the session's user id and `assertActorId` it; the admin check (`requireAdmin()` as the first line) is the job of the Server Action (T15), which also carries the customer/visitor denial tests.

## Consequences
- T15 builds the settings page and actions on these functions and passes the returned tags to `revalidateCatalogInAction`.
- Public readers of the number and email (Phase 4) read the keys with their `stored*Schema`, falling back to env/none.
