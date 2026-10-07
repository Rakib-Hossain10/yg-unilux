# 0050 — Settings UI
- Status: Accepted
- Date: 2026-10-07
- Builds on: [0049](0049-settings-service.md), [0035](0035-admin-write-path.md), [0003](0003-geo-block-env-only.md)

## Context
T15 puts a screen on the T14 settings service: column visibility, WhatsApp number, company email.

## Decision
1. **One page, two cards.** `/admin/settings` shows a column-visibility form (28 switches, grouped like the product editor; on = restricted; the five default-restricted columns carry a "restricted by default" badge) and a contact card whose WhatsApp and email forms save independently. Empty clears a value. No geo-block switch (ADR 0003).
2. **Retry after a failed cleanup.** When the setting is stored but the product filter cleanup fails, the form treats the setting as saved (baseline updates) and keeps Save enabled (`canSave()` in `settings-ui.ts`, unit-tested) so the admin can retry; the service's cleanup is idempotent (ADR 0049 item 3).
3. **Warnings.** A permanent note says restricting a filter column clears its filters on all products; a second warning names the specific filter columns about to be cleared.
4. **Actions.** `saveColumnVisibilityAction`, `saveWhatsappNumberAction`, `saveCompanyEmailAction`: `requireAdmin()` first, then the T14 service (which validates with Zod and audits, no number or email in meta), then `revalidateCatalogInAction`. The static guard test now also requires every exported admin action to call `revalidateCatalogInAction` and a service from `@/lib/admin/*`. Audit is checked only indirectly (the services write it).
5. **Sync test.** `FILTER_COLUMNS` in `settings-ui.ts` mirrors the service's `FILTER_KEY_BY_SPEC`; a test keeps them equal.
6. **T14 open item closed.** `updateProduct` drops `filters.<x>` for restricted columns on save through `withoutRestrictedFilters()` in `src/lib/admin/products.ts` (reads `getColumnVisibility()`). `createDraft` takes no filters. The Phase 3 import must call it too.

## Consequences
- Grouping still comes from `spec-groups.ts`; moving a `group` field into `SPEC_COLUMNS` is a backend follow-up.
- Phase 4 must confirm the public readers of the company email match the card's wording.
- Not yet seen in a browser; T18 e2e covers it.
