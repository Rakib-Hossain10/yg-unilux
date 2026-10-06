# 0039 — Areas module
- Status: Accepted
- Date: 2026-10-06

## Context
T6 adds the areas admin module (7 application areas). It follows the T4 service and T5 UI patterns (ADR 0035, 0037, 0038).

## Decision
1. Same shapes as categories: `src/lib/schemas/area.ts`, `src/lib/admin/areas.ts`, `src/app/admin/areas/*`, `area-{list,form}.tsx`.
2. The form has only `name`, `slug` (optional, generated from the name with `-2`, `-3` on clashes) and `bwImage` (a Cloudinary public id as plain text until the T11b uploader). `order` is changed only by move up/down (renumbers 0..n, no-op at the edges). `icon` is left out until Phase 4 decides its format; the model has no description.
3. Area slugs are globally unique (the model's unique index), unlike categories (unique per parent).
4. Delete is blocked while any product lists the area in `products.areas`; the error states how many.
5. Tags: create, move and delete expire `areas`; update also expires `products`, because product pages show area names and slugs. A no-change update writes, audits and revalidates nothing.

## Consequences
- T11b adds the `bwImage` uploader and should tighten the field to the publicId regex.
- No e2e for areas or categories yet; add in QA gate A or T18.
