# 0061 — Import commit: per-entry hashes and batched writes
- Status: Accepted
- Date: 2026-10-07
- Code: Phase 3 T8 (`src/lib/import/commit.ts`, `plan.ts`, `index.ts`, `src/lib/schemas/import.ts`, `src/lib/constants.ts`)

## Context
ADR 0057 planned one `planHash` re-checked at commit. That cannot work with several batches: the hash covers each matched product's `updatedAt`, and products created by batch 0 become matched, so batch 1's re-plan never reproduces the previewed hash and a half-done import could not resume.

## Decision
1. **Hash structure (`PLAN_HASH_VERSION` 2).** `planHash = sha256({v2, sheetHash, entryHashes})`. `sheetHash` covers the default category and the grouped sheet products and does not depend on the database. `entryHash` covers what would be written for that product (status, sheet + rows, `existing` incl. `updatedAt`, target, `imagesToAdd`, `variantsRemoved`; never warnings or diff text).
2. **Commit protocol.** The client sends `etag`, `planHash`, every `entry.hash`, `batch`, `acknowledgeRemovals`. The server re-plans from the ETag-pinned file and proves the sent hashes against its own `sheetHash`. Per entry: same hash → write; now `unchanged` → already done (resume); anything else → refuse the whole batch ("preview again") before any upload or write. Batch b = entries [20b, 20b+20), numbered over all entries.
3. **Write rules.** Create: pre-made ObjectId, upload, insert as draft, exactly `entry.target`. Update: conditional `updateOne({_id, updatedAt})`, `$set/$unset` of changed sheet-owned paths only, `$push` images; never name, slug, status or admin fields. One atomic write per product; failures are per product (taken, changed, upload, save).
4. **Pictures.** Only for written products, one copy per product deduped by sha256, within the 30-image cap, 4 uploads at once. Alt = product name. Uploads are destroyed when the write certainly did not happen (duplicate key, no match, validation, upload failure) and kept when the outcome is unknown (network error; the orphan sweep removes them if unreferenced). Variant pictures only for new variants.
5. **Audit and revalidation.** One `import.commit` entry per batch that wrote something (counts + product ids, no values). Nothing written → no audit, no tags. The service returns tags; the action revalidates once.
6. **Removals.** Without `acknowledgeRemovals`, a batch that removes variants is refused as a whole (field error).
7. **Caps.** `IMPORT_BATCH_SIZE` 20, `IMPORT_UPLOAD_CONCURRENCY` 4, `MAX_IMPORT_PLAN_ENTRIES` 5000.

## Consequences
- Each batch re-parses the whole workbook; T9 must check `maxDuration`.
- Test fixture quirk: exceljs writes the 5th anchor with the wrong `r:embed` when `fillTemplate` uses pictures 3 and 4; our reader is right.
- Gate B fixes: the plan refuses files with more than `MAX_IMPORT_PLAN_ENTRIES` products (`too_many_products`), so a preview is always committable. The template's note boxes are enlarged by rewriting the VML after exceljs writes the file (exceljs has no setting for it).
