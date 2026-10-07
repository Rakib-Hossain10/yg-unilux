# 0057 — Import pipeline: stateless plan + hash, field ownership, safety-net rules
- Status: Accepted
- Date: 2026-10-07
- Code: Phase 3 T2–T7 (`src/lib/import/{safety,sheet-guard,zip-rebuild,workbook,clean,group,images,plan,index,types}.ts`, `src/lib/schemas/import.ts`); T8 adds `commit.ts`

## Context
The admin uploads the client's spec sheet (now normally our controlled template, ADR 0059) to import ~500 products. A wrong parse silently corrupts the catalogue, re-importing must change nothing, and the upload is untrusted. ADR 0056 covers cell cleaning and filter parsing, ADR 0059 the template, ADR 0060 staging and the server image upload. This ADR records the pipeline as a whole and the rules settled in T2–T7 (including QA gate A).

## Decision

### 1. Pipeline and the stateless preview
- Flow: browser PUT → R2 `imports/<uuid>.xlsx` → `previewImport({key, defaultCategoryId})` → admin reviews → `commitImportBatch` (T8, ~20 products per call) → `finishImport` deletes the staged file (the 24 h sweep is the backstop).
- `previewImport` (`src/lib/import/index.ts`): Zod (`importFileInputSchema`, strict) → the default category must exist (`fieldError("defaultCategoryId")`, gate A I-5) → `getImportBytes(key)` → `planFromBytes` → `unchanged(...)` (no tags). It returns the plan and the staged object's **ETag**; T8 reads with `ifMatch: etag`, so the commit sees exactly the previewed bytes.
- **The preview writes nothing**: no DB write, no audit entry, no upload, no revalidation. A test records every Mongoose collection call during a preview and asserts that only reads happen, that products are deep-equal before/after, that the audit log is empty and that no storage write helper is called.
- **No preview state is stored.** The commit re-plans from the same file and must reproduce the same `planHash`. Nothing to expire or clean up; a changed DB, file or setting means "preview again".
- `planFromBytes`: `checkImportFile(bytes)` → `readWorkbook(check.file)` → `cleanRow` → `groupRows` → `readEmbeddedImages(check.file, read.sheets.map(s => s.name))` → `attachImages` → `planProducts`. Only the `CheckedImportFile` reaches a reader (never the raw upload, gate A); nothing writes into `file.bytes` (I-9). The picture bytes (`files`) come back for T8 only; the preview drops them.

### 2. Matching and classification (`plan.ts`)
- Every model no. of the non-blocked products is looked up with `$in` under `MODEL_NO_COLLATION` (chunks of 1,000), then compared with `modelNoKey` (ADR 0055).
- 0 saved products → `create`; 1 → `update`, or `unchanged` when the merge changes nothing; >1 → `blocked` with `model_no_conflict` (saving would merge saved products).
- **Conflict across sheet products:** when two grouped products of the file match the same saved product, both are blocked (`model_no_conflict`). Products are compared as grouped, never by a global `NO.`, because `NO.` is unique per sheet only.
- Sheet errors (`product.blocked`) → `blocked`, target null.
- New plan error codes: `no_slug` (no slug can be made) and `invalid_record` (the merged product fails Zod).

### 3. Field ownership (merge on update)
| Field | Owner |
|---|---|
| `family`, `type`, `productNo`, `modelCode`, `specs`, `variants[].modelNo` (text as in the sheet) / `specs`, the variant list and its order, `filters` (recomputed) | sheet: overwritten |
| `mainCategory`, `extraCategories`, `areas` | sheet only when `...FromSheet` (a template column resolved something), else the saved value; the same set keeps the saved order; main removed from extras |
| `name`, `slug`, `status` (create = draft) | create only |
| `variants[].label`, `variants[].imagePublicId` | kept when saved; a missing label is filled from the sheet; a new variant's picture comes from its `imageSha256` at commit |
| `images` | append-only by `sourceSha256`, within `MAX_PRODUCT_IMAGES` (overflow → `value_truncated`) |
| `trackSize` | null unless a merged category is Magnetic Track or its child (ADR 0041); a 5/10/20mm subcategory chosen by the sheet wins; otherwise the saved value (admin-owned), else derived (`trackSizeOf`, main first) |
| `description`, `extraSpecs`, `publicFiles`, `datasheetId`, `featured` | admin: never in the plan target at all |
- Saved variants missing from the sheet → `variantsRemoved` + `variant_removed` warning; T8 removes them only with the admin's acknowledgement.
- A blank area flag cannot clear saved areas (an all-"No" row is "not from the sheet"). Deleting an imported picture in the admin and re-importing adds it again (its `sourceSha256` is gone).
- **Zod on every record:** the merged target is parsed with `productInputSchema` (the admin form's schema: lengths, option caps, `MAX_VARIANTS`, id shapes, repeated model nos.). A failure blocks the product (`invalid_record`).
- **Slugs:** `uniqueSlug(candidate)`; candidate = `ImportProduct.slug`, or the base model code when that is "". Root slugs are looked up in one query; only a taken root costs per-candidate queries; slugs reserved by earlier creates in the same plan are skipped.

### 4. Restricted filters
`filters = gate(filtersFromSpecs([p.specs, ...variants.map(v => v.specs)]))`, where the gate is built from **`withoutRestrictedFilters`** (called once per plan with every filter present, so a 500-product plan reads the visibility setting once). `filtersFromSpecs` itself ignores visibility; a test pins both facts (gate A I-2). The visibility therefore also feeds the hash.

### 5. Diff and plan hash
- Diff: per changed sheet-owned field `{field, label, before, after}` (lists joined " / ", compared on raw values), at most 10 (`MAX_PLAN_CHANGES`) + `moreChanges`. Creates have no diff.
- `planHash` = sha256 of stable JSON (sorted keys) of `{version, defaultCategoryId, products, entries}`: every grouped product as the sheet gave it (incl. `images[].sha256` and `variants[].imageSha256`) and each entry's status, matched id + `updatedAt`, target, pictures to add and removals. **Never the `files` map** (picture bytes). Any save to a matched product (its `updatedAt`) changes the hash, and so does a visibility change.

### 6. Batches (T8)
The commit runs in idempotent batches of ~20 products: each batch re-plans, checks the hash, re-checks each product's `updatedAt`, uploads only pictures a written product references, writes, and records one `import.commit` audit entry with counts and ids only. A re-run resumes: finished products plan as `unchanged`.

### 7. Untrusted file (T2 + gate A)
- Safety refusal reasons map to `not_xlsx` / `too_large` / `zip_unsafe` (plus `sheet_too_complex`). The 100:1 compression-ratio cap applies only to entries over 1 MB.
- **Sheet guard** inside `checkImportFile`: `<dataValidations>` and `<definedNames>` are stripped (exceljs expands their ranges cell by cell, so a tiny file could hang the function; stripping keeps a valid sheet importable where refusing would fail the client's own template); merges capped at 2,000 ranges / 100,000 cells (measured: 2,000 merges ≈ 0.3 s, 10,000 ≈ 6 s); `<col max>` ≤ XFD; `sheetId` ≤ 10,000. Range records checked and found safe: conditional formatting, autoFilter, hyperlinks, tables, shared formulas, selection, dimension. The guard re-checks its own output.
- **Refuse, don't repair, ambiguous XML** (duplicate attributes, unexpected nesting).
- **One zip path:** read with `xlsx-signature.ts`, write with `zip-rebuild.ts`; the checked file is always rewritten, and the output is a fixed point of the check. No JSZip in production.
- `CheckedImportFile` is a brand plus a WeakSet: readers refuse anything `checkImportFile` did not issue.
- Part names must already be JSZip-canonical (no `./`, `../`, backslashes); duplicates compare case-insensitively (OPC). Any `vbaProject.bin` is refused.
- Pictures follow the sheet part exceljs reads (gate A I-7).
- CJK is stripped by Unicode block and script after NFKC (ADR 0056).
- Out of scope: the datasheet `checkXlsx` path (datasheets are never unzipped or parsed).
- Memory: guarding a large worksheet peaks at ~2–3× the part size (I-8); watch the Vercel memory budget.

### 8. Reader rules (T2)
- Header row = the first row (top 15) with a `Model No.` cell, or failing that a row with 3+ known headers, so a sheet missing Model No. is `missing_required_column`, not `no_header`.
- Reader warning codes: `duplicate_column`, `sheet_skipped`, `hidden_sheet`, `hidden_row`, `date_cell`, `formula_without_result`, `cell_error`.

### 9. Grouping rules (T4)
- Shared values are decided over the rows with a model no. (all rows if none); option lists compare in order.
- `family`/`type` from the first non-empty value; a different later value → `family_mismatch` on that column.
- Base code = case-insensitive common prefix, trailing `-_./ ` trimmed; shorter than 3 characters → the first model no. + `short_base_model_code`. (Open client question: `AR-10`/`AR-12` → `AR-1`.)
- Labels = the variant's own values in the differing optic columns, joined ", "; collisions get ` (<model no.>)`, then the model no.
- Category cell: slug, name or `Main > Sub` (also `›`), case-insensitive; an ambiguous bare name → `unknown_category`. Extras and areas = union over the rows, main removed from extras; `...FromSheet` only when something resolved/kept.
- trackSize: main category first, then extras.
- `duplicate_product_no` per sheet; an invalid NO. starts its own blocked product; `duplicate_model_no` on every involved row.
- `missing_spec` once per product when no row has it, else per variant row; `unparsed_filter_value` is emitted in `group.ts`.

### 10. Pictures (T5)
- Read from the zip ourselves, not exceljs's image model (it drops absolute anchors, AlternateContent and linked pictures). Row = anchor `from` row + 1; any column counts.
- Check order: declared size > 10 MB (never inflated) → magic-byte sniff (only JPEG/PNG/WebP reach sharp) → sharp header only (25 MP; format must match the sniff). Linked pictures are never fetched. Only picture parts of `richData` warn (`unsupported_image_store`).
- Gallery = distinct sha256 in row/column order, cap 30 → `value_truncated`. A variant picture only when the variants' lead pictures differ. Bytes live only in `EmbeddedImages.files`.

## Consequences
- The preview can be shown and re-run freely; the commit refuses a stale plan with "preview again".
- Admin edits made between preview and commit (any field, as `updatedAt` changes) also invalidate the hash. That is intended: the admin re-reviews.
- T8 must write exactly the plan target (so the next preview is `unchanged`); the plan tests' `saveAsCommitWould` helper describes that shape.
- T9 shows warning text to the admin only, never in logs, audit or the DB (it repeats cell values).
