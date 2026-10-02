# 0019 — Mongoose models
- Status: Accepted
- Date: 2026-10-02

## Decision
- **One file per collection** in `src/models/`, registered in `src/models/index.ts`.
  - Each model imports `mongoose` from `@/lib/db` (strict settings, ADR 0018) and is compiled once through `defineModel()`.
  - Collection names are explicit camelCase: `products`, `categories`, `areas`, `datasheets`, `accessRequests`, `downloadLogs`, `leaders`, `siteContent`, `whistleblowerCases`, `auditLog`, `loginAttempts`, plus the read-only `users`.
- **`strict: "throw"` on every writable schema:** an unknown field fails loudly instead of being silently dropped.
- **Product specs use one fixed key per sheet column** (`src/models/spec-columns.ts` lists the keys, header labels and default visibility).
  - Each value is an array of English display strings: one entry is a single value, several are option chips.
  - Fixed keys make it possible to exclude restricted columns **by projection** (`-specs.driver -variants.specs.driver`), so restricted values never enter cached code (ADR 0002); a test proves it.
  - Variants store only the values that differ from the product.
  - Parsed numbers for filters live in `filters.*`.
  - `variants.modelNo` is unique across products (a partial unique index), and also unique within one product (a validator).
- **Settings live in `siteContent`** under `settings.*` keys (`settings.columnVisibility`, `settings.whatsappNumber`, `settings.companyEmail`), so we stay at 11 collections. Values are validated per key with Zod in the app.
- **Better Auth user ids are BSON ObjectIds** (checked in `@better-auth/mongo-adapter` 1.7.7). Our references (`uploadedBy`, `handledBy`, `actor`, `downloadLogs.user`) are ObjectIds with `ref: "User"`, and `populate()` through the read-only users model works. **This corrects ADR 0017,** which said `populate()` was unavailable.
  - Better Auth's default model name is `user`; task 5 sets `modelName: "users"`.
  - The admin plugin stores several roles as one comma-joined string, so role checks must split on `,`.
- **The `users` model is read-only:** pre-hooks throw on every write path (tested on 20 paths). It guards against our own mistakes, not attackers (the raw `collection` bypasses hooks).
- **Whistleblower privacy, enforced in the schema** (rule 7):
  - A test pins the exact list of stored paths, bans identity words in path names and bans Mixed fields.
  - Attachment names must be neutral and server-generated (`attachment-1.pdf`); the reporter's own file name is never stored. Storage keys must be random.
  - Attachments are limited to JPEG/PNG/WebP/PDF, 10 MB each and 5 per case.
  - A case holds at most 500 messages, and ciphertext is capped at 200 000 characters, so a case can't hit the 16 MB document limit. Phase 8 must append messages with a length guard, because array validators don't run on `$push`.
  - `passwordHash` is `select: false` and optional in the TS type; the login query must use `.select("+passwordHash")`.
  - Per-case login lockout will reuse `loginAttempts`, keyed by case number (never by IP).
- **Indexes** are built only by `npm run db:indexes` (`createIndexes`, never drops). It runs as `node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/sync-indexes.ts`.
  - The `react-server` condition is needed because `db.ts` imports `server-only`.
  - It prints no document values, and gives a hint for duplicate-key (11000) and index-conflict (85/86) errors.
- **No `_id` on array items** (images, variants, files, messages).

## Open questions (defaults chosen; to confirm with the user)
1. Can a product have zero variants? Default: yes, so the admin can save drafts.
2. Are `modelCode` and `family` required, and is `productNo` unique? Default: all optional and not unique.
3. Should model numbers be normalised (uppercased) for uniqueness and re-import matching? Default: trimmed only.
4. Category and area icon format. Default: a free string.
5. Is `extraSpecs.group` required? Default: no.
6. Audit actor for CLI/cron actions. Default: required (decide in task 7, seed script).
7. Whistleblower relationship and concern lists: free text now, enums in Phase 8.
8. `publicFiles.url` hosting. Default: any `https` URL.

## Follow-ups
- **Phase 4:** if a filtered column (CCT, CRI, beam, UGR, W, IP) is made restricted, the cached projection must also drop the matching `filters.*` key, and that filter must be disabled.
- **Phase 2:** consider an index on `products.datasheetId` (it supports "which products use this datasheet" and blocking delete).
- **Task 3:** consider hashing the email in the `loginAttempts` key.
