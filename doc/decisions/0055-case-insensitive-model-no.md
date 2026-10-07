# 0055 — Case-insensitive model no. uniqueness
- Status: Accepted
- Date: 2026-10-07
- Amends: 0019 (open question 3, "trimmed only"), 0041 (decision 3 / consequence "exact-match")
- Closes: Phase 2 gate B L-A

## Context
Re-import (Phase 3) matches products by model no. Before this change, the comparison was inconsistent:
- the unique index on `variants.modelNo` was case-sensitive across products;
- the form compared case-insensitively within one product.

So "ZZ-9" and "zz-9" could live on two products, and one search would find both (gate B L-A). The user decided (Phase 3 decision 6) that model nos. are case-insensitive and stored as typed.

## Decision
1. **Collated index.** The unique partial index on `variants.modelNo` uses collation `{ locale: "en", strength: 2 }`: case-insensitive, accent-sensitive. The partial filter `{ "variants.modelNo": { $exists: true } }` stays. Text is stored exactly as typed.
2. **One shared rule.** It lives in `src/models/product-constants.ts` (pure, client-safe, also used by the importer):
   - `MODEL_NO_COLLATION`;
   - `modelNoKey(s)`: trim → NFKC → strip default-ignorable code points → `toLocaleLowerCase("en")`;
   - `sameModelNo(a, b)`.

   A memory-DB test pins `modelNoKey` to MongoDB's collation:
   - case, full-width letters, ligatures, soft hyphen and zero-width space count as equal;
   - accents and ß/ss count as different.

   For exotic scripts, the index has the final say.
3. **Every comparison uses that rule:**
   - the Mongoose in-document validator (a unique index never compares entries inside one document);
   - the Zod form check;
   - `takenModelNos`, queried with `{ collation: MODEL_NO_COLLATION }` so it both matches case-insensitively and uses the index (a query without the same collation cannot use a collated index);
   - the duplicate-key mapping.
4. **Duplicate-key errors.** With a collated index, the E11000 `keyValue` is an opaque `CollationKey(0x…)`, not the text. So the mapping:
   1. matches a plain-text `keyValue` directly (an old index, before migration);
   2. otherwise asks the DB which of the submitted model nos. another product owns (`distinct` with the collation), to mark the right `variants.N.modelNo`;
   3. falls back to an error on `variants` if neither finds the row.
5. **Admin list search** stays a regex with the `i` flag (already case-insensitive).
6. **`ProductImage.sourceSha256?`** (64 lowercase hex) is added for the import's image dedupe. It is server-owned: `saveProductImages` carries it over by publicId and never accepts it from the browser. Admin uploads leave it unset.
7. **Migration.** `db:indexes` never drops indexes. An old `variants.modelNo_1` without the collation gives `IndexKeySpecsConflict` (86); the sync output names the index and the steps to fix it. `npm run check:model-nos` (read-only) lists model nos. used more than once, ignoring case:
   - across products, they block the index build;
   - inside one product, they make that product fail on its next save.

   The script exits with code 1 if it finds any.

## Consequences
- **One manual step per database.** Run `check:model-nos`, fix what it lists, drop `variants.modelNo_1` in Atlas, then run `npm run db:indexes`. Do the last two back to back: in between, nothing in the database enforces uniqueness.
- **The Phase 3 importer** must use `modelNoKey` for in-sheet duplicates and pass `MODEL_NO_COLLATION` on every model-no. lookup.
- **Reviewers** should flag any query on `variants.modelNo` without the collation: it is case-sensitive and scans the whole collection.
