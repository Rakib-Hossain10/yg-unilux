# 0035 — Admin write path
- Status: Accepted
- Date: 2026-10-06
- Implements: CLAUDE.md rules 3, 8 and 9; ADR 0008, 0019, 0024. Refines ADR 0008's single `revalidateCatalog(...)` helper.

## Context
Every admin mutation must:
- check the role on the server;
- validate its input;
- leave an audit entry;
- invalidate the public cache.

`updateTag` throws outside Server Actions (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/updateTag.md`), so the cache step can't live in service code that tests call directly.

## Decision
1. **Three layers per entity.**
   - `src/lib/schemas/<entity>.ts`: pure Zod 4, shared with React Hook Form.
   - `src/lib/admin/<entity>.ts` (server-only services). They run `connectDb()`, re-parse with Zod, write, call `recordAudit()`, and return `{ ok, data | errors, tags }`. Services never call `updateTag` or `revalidateTag`.
   - `src/app/admin/<module>/actions.ts` (`"use server"`). In order:
     - statement one is `await requireAdmin()`;
     - the service, called with `viewer.user.id`;
     - `revalidateCatalogInAction(tags)`;
     - `redirect()` last, outside any `try`.

     Never catch an auth interrupt without `unstable_rethrow` (ADR 0024).
2. **Audit vocabulary.** `src/models/audit-actions.ts` imports nothing. It is the one source for both the auditLog schema enum and `recordAudit`'s Zod check.
   - Admin actions (`<entity>.<verb>`):
     - `product.create`, `update`, `delete`, `publish`, `unpublish`, `images.update`, `datasheet.attach`, `datasheet.detach`;
     - `category.create`, `update`, `delete`, `reorder`;
     - `area.create`, `update`, `delete`, `reorder`;
     - `datasheet.upload`, `replace`, `delete`;
     - `settings.columns.update`, `whatsapp.update`, `email.update`.
   - System actions are written by Phase 1 code, not through `recordAudit`: `auth.rate_limited`, `admin.cli_create`, `admin.cli_reset_password`.
   - The target type must match the action's first word. Record ids must be ObjectIds, and settings ids must look like `settings.<key>`.
3. **Meta policy.**
   - `meta` holds only ids, changed field names and counts.
   - It never holds field values, the WhatsApp number or email, restricted spec values, file names typed by a person, IPs or secrets.
   - The shape is enforced: a flat record of short scalars or scalar lists, at most 50 keys, 200-character strings, 200-item lists and 4096 bytes of JSON. Keys cannot contain `$` or `.`.
   - The meaning is the service's job, because a schema can't tell an id from a phone number.
4. **One revalidation helper, `src/lib/revalidate.ts`.**
   - Tags are typed: the fixed `CATALOG_TAGS` plus a branded `productTag(id)` (ObjectId only). They are de-duplicated and re-checked at run time; one bad tag fails the whole call.
   - Server Actions call `revalidateCatalogInAction`, which uses `updateTag` (read-your-own-writes).
   - Route handlers, cron and import jobs call `revalidateCatalogFromRoute`, which uses `revalidateTag(tag, "max")`. Exception: `settings:columns`, and any call with `immediate: true`, use `{ expire: 0 }`. Stale entries there could expose a newly restricted column (rule 9) or keep showing an unpublished page.
5. **The audit write is not atomic.**
   - The entity write comes first, then the audit entry, with no transaction.
   - If the audit write fails, the change stays saved. The service logs the failure (no values) and returns an error to the admin, and still returns the tags so the action revalidates.
   - This is accepted because there is one admin and writes are rare. A missing entry shows up in the logs.
6. **Constants live in one client-safe place.**
   - `src/lib/constants.ts` holds the depth, size limits, image formats, upload folders and R2 prefixes.
   - `src/lib/slug.ts` holds `slugify`, `uniqueSlug`, `SLUG_PATTERN` and `MAX_SLUG_LENGTH`.
   - The models import these from there.
7. `products.datasheetId` is indexed, so the "datasheet in use" checks and attach counts don't scan the collection.

## Consequences
- The static guard test (T15) checks that every action calls `requireAdmin` first, then the audit helper and the revalidate helper.
- Phase 2 can only unit-test revalidation, because `cacheComponents` stays off until Phase 4.
- A new admin action needs a new entry in `audit-actions.ts`; the enum rejects unknown ones.
- T14 should tie each `settings.*` action to its exact siteContent key.
