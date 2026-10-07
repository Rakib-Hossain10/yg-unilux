# Phase 3 — Bulk import: implementation plan

Status: **APPROVED** (2026-10-07). The user accepted all six defaults (Q1–Q6). The client sheet arrived and was studied (see "Fixture findings").

## Context
Phase 2 is merged (PR #11). The admin can build a product by hand: categories, areas, product form, images, datasheets, column visibility. Phase 3 lets the admin upload the client's spec sheet (33 bilingual columns, one row per model no., ~500 products) as it is, check a preview with warnings, and save it. Importing the same file again must change nothing.

**Exit criteria (from `tasks.md`):**
- the golden fixture imports as expected: No. 76 → one product "Arc", variants AR-013A1 (lens, 1140 lm) and AR-013A2 (reflector, 1200 lm), lumen efficiency (95± / 100±) also differs, every other value shared (see "Fixture findings");
- importing the same file again writes nothing (no write, no audit entry, no revalidation, no image upload, `updatedAt` unchanged) and creates no duplicates.

**Already in place:**
- `exceljs` 4.4 and `jszip` 3.10 are dependencies.
- `src/lib/xlsx-signature.ts` reads the zip's central directory itself and has capped inflate.
- `src/lib/storage.ts` handles R2 presigned PUT/GET/copy/delete.
- `src/lib/cloudinary{,-ids}.ts` gives server-chosen ids `yg/products/<productId>/<uuid>` and `inspectImage`.
- `src/lib/admin/products.ts` provides `withoutRestrictedFilters`, `takenModelNos`, `tagsFor` and the duplicate-key mapping.
- `src/lib/{audit,revalidate,slug}.ts` and `src/models/spec-columns.ts` (28 spec keys plus English headers).
- In-memory R2 and Cloudinary fakes for e2e (ADR 0052).

**Fixture:** the client's real sheet is at `doc/reference/client-sample-sheet.xlsx` (gitignored). See "Fixture findings".

## Skill check (`/find-skills`, 2026-10-07)
- `npx skills find xlsx | "excel import" | "mongodb bulk"`: the only relevant hit is `anthropics/skills@xlsx` (178K installs), and **it is already installed** as `xlsx`, preloaded by `import-engineer`.
- That skill is Python/openpyxl and builds spreadsheet deliverables. We use it for **studying the client's fixture** (headers, merged cells, where images are anchored, odd cells) and for writing test fixtures by hand when useful. It does not replace the runtime parser, which must be TypeScript on our server.
- Other installed skills that apply: `tdd` (parser work is test-first), `security-and-hardening` (untrusted upload), `mongodb-connection` (bulk writes), `next-best-practices` / `next-cache-components` (Server Actions, `maxDuration`, `updateTag`), `playwright-best-practices` (the e2e), `shadcn` (the import UI).
- Nothing else is worth installing. Lark/Google Sheets/Prisma results don't apply.

## Subagents (reuse; no new one)
| Agent | Phase 3 role |
|---|---|
| `import-engineer` (exists, made for this) | Everything in `src/lib/import/**` (reader, cleaner, parsers, grouping, images, plan, commit services) plus fixtures and import tests |
| `backend-architect` | Shared infrastructure: model no. collation (L-A), `ProductImage.sourceSha256`, R2 `imports/` staging, server-side Cloudinary upload, audit vocabulary, sweep extension, template route |
| `admin-panel-builder` | `/admin/import` UI, `actions.ts` (thin, `requireAdmin()` first), nav entry, e2e |
| `qa-security-reviewer` | Gates A, B, C |
| `code-reviewer` | Automatic per-file review (hook) |

No new subagent: `import-engineer` already covers the parsing and import logic. All subagents run on **Opus** (user rule, 2026-10-06). `import-engineer.md` now says `test/fixtures/` (fixed in T0).

## Decisions (user, 2026-10-07: all six defaults accepted)
1. **The real sheet stays local only.** It lives at `doc/reference/client-sample-sheet.xlsx`, and `.gitignore` covers `/doc/reference/*.xlsx` and `/test/fixtures/private/`. The golden test reads it from there (`IMPORT_FIXTURE` env overrides the path). When the file is missing, the test is skipped with a loud message. CI uses a synthetic fixture built by code that copies the real sheet's structure.
2. **Main category:** the admin picks a default main category in the upload step. An optional `Category` template column overrides it per row. New products are always **draft**.
3. **Variants gone from the sheet are removed**, but only after the admin ticks "I understand N variants will be removed". The preview lists every removal.
4. **An import never deletes images.** It only adds images it hasn't seen before (matched by sha256).
5. **30 MB** cap for the import file, uploaded straight to R2.
6. **Case-insensitive model numbers** (collation `en`, strength 2). Text is stored as typed.
7. **English only.** No Chinese reaches the database or the site (user, restated 2026-10-07). This is covered by the blank-line cut plus the CJK strip, below.

## Fixture findings (client sheet, studied 2026-10-07)
The file is 4.2 MB, 28 zip entries, one sheet `Sheet1`, 14 rows × 33 columns, saved by **WPS Sheets**.
- **Header:** row 1. Each header is `English\nChinese`. The case varies (`HOLDER`, `Voltage INPUT`, `LUMEN Output`), there are stray spaces (`Batch No.\n批号 `, `Chip Efficiency\n 芯片光效`), and `NO.` has no Chinese line. → Match headers on the first line, case-insensitively, with spaces collapsed and a trailing `.` optional.
- **Row 2 is blank** (a spacer). → Skip fully empty rows. They don't end a product.
- **No merged cells.** A continuation row repeats `Model Name` and leaves `NO.` empty, as CLAUDE.md says. Merged-cell support stays in, as a cheap safety net.
- **Bilingual cells put English first:** `Die Casting\nAluminium + PC\n\n压铸铝 + PC`, `White/Black\n\n白色/黑色`, `Regular Lens\n\n普通透镜`. → "Keep the text before the first blank line" is confirmed. The mixed cell `Lifud 莱福德` (Driver) needs the CJK strip.
- **Rich text is common** in bilingual cells. → Flatten the runs to plain text.
- **Number cells:** `NO.` (76) and Power Factor (`0.9`). → Use a plain decimal string for specs and an integer for `NO.`.
- **Multi-line does NOT always mean options.**
  - Options: `3000K\n4000K` and `20°\n30°\n40°\n60°`.
  - One value spread over two lines: `Die Casting\nAluminium + PC` (Housing Material) and `Pull-Down Spot Light\nTrim Round 1 Head` (Model Type).
  - → The split policy is now **per column**: `options` (lines become an array), `options+slash`, or `join` (lines joined with a space into one value). See the cleaning rules.
- **Odd values to keep as text and flag to the client, not "fix":** `95±` / `100±` (Lumen Efficiency), `≤3` (SDCM), `50,000 hrs ` (trailing space, trimmed), `High Effciency Reflector` (typo).
- **Empty in every row:** Batch No., Reflector Color, Diffuser, Rotating Angle, Holder, Chip Efficiency, UGR, Dimmable, Warranty Period. They are hidden as not applicable. The `missing_spec` warning only checks CCT, CRI, Beam Angle, Wattage and Lumen Output.
- **Products:**
  - No. 76 = AR-013A1/A2;
  - 77 = AR-013B1/B2;
  - 78 = AR-013C1/C2 (Model Type "Trimless", like 79; 76/77 are "Trim");
  - 79 = AR-013D1/D2;
  - **80 and 81 have no Model No. and almost no specs** (only family, material, finish, image). → Error `missing_model_no`: they are blocked in the preview and the rest imports. This answers the open client question "Nos. 80/81" for the importer; the client still has to supply the data.
- **Golden No. 76 (corrected):**
  - Shared: family Arc, type, material, finish, cut-out Ø90mm, dimensions, chip COB, CCT, CRI >90, beam angles, driver Lifud, voltage, 12W, PF 0.9, SDCM ≤3, lifespan, IP20.
  - Per variant: **lens** (AR-013A1 "Regular Lens", A2 none), **reflector** (A1 none, A2 "High Effciency Reflector"), **lumen output** (1140 LM / 1200 LM) and **lumen efficiency** (95± / 100±).
  - Base code `AR-013A`, slug `arc-ar-013a`, labels "Regular Lens" / "High Effciency Reflector".
- **Images:** standard `xl/drawings/drawing1.xml`, `oneCellAnchor` in the Image column (col 6), one anchor per row, 4 PNGs (0.18–2.4 MB).
  - **The same picture is anchored on every row of two products** (image1 on rows 3–6 = Nos. 76 + 77; image2 on 78 + 79).
  - → Dedupe by sha256 within a product, so each product gets one gallery image. Each product uploads its own Cloudinary copy, because ids are per product.
  - An image is set on a variant only when that product's rows carry different images.
  - **No WPS `DISPIMG` / `cellimages.xml` in this file.** WPS in-cell image reading is dropped from the plan. If such a store (or Excel `richData`) ever appears, the preview shows the warning `unsupported_image_store` instead of guessing.
- **Header fill colours** (pink = theme 9, green = theme 8) are a product-page layout instruction from the client. They are logged in **ADR 0054** for the Phase 4 product page. The import ignores fills.

## Architecture

### Flow
```
[admin] choose .xlsx + default category
   │  presignImportUpload → browser PUT → R2 imports/<uuid>.xlsx   (≤30 MB; Vercel body cap avoided)
   ▼
previewImport(key, options)      — Server Action, writes NOTHING
   R2 GET → safety check → read workbook → clean → group → match DB → ImportPlan + planHash
   ▼
[admin] reviews summary, per-product rows, warnings, diffs; ticks removal ack if needed
   ▼
commitImportBatch(key, options, planHash, batchIndex)   — repeated by the client, ~20 products per call
   re-plan from the same file → planHash must match → per product: stale check → upload new images
   → create / update / skip → one audit entry per batch → return tags → updateTag in the action
   ▼
finishImport(key) — deletes the staged file (the sweep removes it after 24 h anyway)
```

**Why it is built this way:**
- **No preview state is stored.** The preview is recomputed from the staged file. `planHash` (sha256 of the canonical plan, including each matched product's `updatedAt`) proves the commit saves exactly what the admin saw. If the DB or the file changed in between, the hash doesn't match and the admin is asked to preview again. No new collection, nothing to clean up.
- **The commit runs in idempotent batches.** 500 products with image uploads cannot be relied on to fit in one function call. Every batch is safe to re-run. A failure halfway leaves finished batches in place, and running again resumes, because done products now come out "unchanged".
- **Images are uploaded only at commit, from the server.** This fixes the Phase 2 must-do: nothing is uploaded at preview time, so the 24 h `sweep:cloudinary` window can't hit pending preview images. A new product gets its ObjectId before its images are uploaded, so the existing id shape `yg/products/<productId>/<uuid>` and its checks keep working unchanged.

### Module layout (`src/lib/import/`, all `server-only` except the pure parsers and `types.ts`)
| File | Purpose | Pure? |
|---|---|---|
| `types.ts` | `SheetRow`, `ImportProduct`, `ImportVariant`, `RowWarning`, `ImportPlan`, `PlanEntry` (create/update/unchanged/blocked) | yes |
| `safety.ts` | Pre-check before any full inflate: reuses the central-directory reader from `xlsx-signature.ts` (exported, with configurable limits). Caps: 30 MB file, 5000 entries, 300 MB total uncompressed, 100:1 ratio per entry, `.xlsm`/macros refused | yes |
| `workbook.ts` | exceljs load. Finds the header row (first row in the top 15 with a `Model No.` cell). Matches headers on the first (English) line: case-insensitive, spaces collapsed, trailing `.` optional (`HOLDER`, `Voltage INPUT`). Fully empty rows are skipped (the client sheet's row 2). A merged cell's value is copied to every cell it covers. Rich text is flattened. Formulas use the **cached result only**, never evaluated. Hidden rows are imported (noted in warnings). Every sheet with a matching header is read; others are listed as skipped | no (I/O-free, but takes a Buffer) |
| `columns.ts` | Header map: the 5 identity columns + 28 `SPEC_COLUMNS` + optional template columns `Category`, `Extra Categories`, `Areas`. Per-column split policy (below). An unknown header is a warning | yes |
| `clean.ts` | Cell cleaner (rules below) | yes |
| `numbers.ts` | Filter parsers: cctK, cri, beamDeg, ugr, wattage, ip | yes |
| `group.ts` | Groups rows into products by `NO.`. Splits shared values from per-variant values. Base model code, slug, variant label, filters, category/area resolution | yes (category/area lookups passed in) |
| `images.ts` | Embedded images: standard drawing anchors (`xl/drawings/*.xml` + rels, twoCell and oneCell; the client sheet uses oneCell). Any other image store (WPS `cellimages.xml`, Excel `richData`) → warning `unsupported_image_store`. Maps each to a sheet row, computes sha256, checks format with `sharp` metadata (jpg/png/webp; EMF/WMF/GIF → warning "unsupported image"), caps size at 10 MB | no |
| `plan.ts` | Matches by model no. (collation) against the DB and classifies each product. Field-ownership merge, display diff, warnings, `planHash` | DB read only |
| `commit.ts` | Batch commit (re-plan, hash check, stale check, image upload, write, audit, tags) | DB + Cloudinary |
| `index.ts` | Service entry points: `previewImport`, `commitImportBatch`, `finishImport` (`ServiceResult`, like the ADR 0035 write path) | — |

### Cell cleaning rules (`clean.ts`; ADR in T3)
Applied in this order:
1. Convert to a string. A number cell becomes its plain decimal string, with no float noise like `0.30000000000000004`.
2. Unicode **NFKC**, so full-width `３０００Ｋ` and `（` turn into ASCII before stripping.
3. Normalise line endings to `\n`. Keep only the text **before the first blank line** (`\n\s*\n`). That drops the Chinese block.
4. Remove CJK characters: `\p{Script=Han}`, Hiragana, Katakana, Hangul, CJK symbols and punctuation (`U+3000–303F`) and the CJK full-width punctuation still left after NFKC (`U+FF00–FFEF`). Then remove brackets left empty (`()`, `[]`) and dangling separators, collapse spaces, and trim each line.
5. Drop lines left empty. A cell that had text but is now empty (it was all-Chinese) gets the warning `cjk_only_cell`.
6. `-`, `–`, `—`, `/` and blank count as **not applicable**: the key is left out, so the value is hidden.
7. Apply the column's **split policy** (`columns.ts`), decided from the fixture:
   - **`options`**: each line becomes one option. Used for `cct`, `beamAngle`, `wattage`, `lumenOutput`, `lumenEfficiency`, `cri`, `ugr`, `ipRating`, `voltageInput`, `chipType`, `driver`, `dimmable`.
   - **`options+slash`**: lines and `/` both separate options. Used for `housingFinish` and `reflectorColor` (`White/Black`).
   - **`join`**: lines are joined with one space into a single value. Used for `housingMaterial` (`Die Casting Aluminium + PC`), `lens`, `reflector`, `diffuser`, `dimensions`, `cutOutSize`, `rotatingAngle`, `holder`, `chipEfficiency`, `powerFactor`, `sdcm`, `lifespan`, `warrantyPeriod`, `batchNo`, and the identity field `type` (`Pull-Down Spot Light Trim Round 1 Head`).

   No column splits on `/` except those two (voltage `AC100-240V/50-60Hz` stays one value). Options are deduped and kept in order. Caps come from `MAX_SPEC_OPTIONS` and `MAX_SPEC_VALUE_LENGTH`; anything over a cap is cut off with a warning. A test pins the policy of all 28 keys, so a new column can't be added without one.

Examples, each a test case (the real sheet's cells):
- `"Lifud 莱福德"` (driver) → `["Lifud"]`
- `"Die Casting\nAluminium + PC\n\n压铸铝 + PC "` (housingMaterial, `join`) → `["Die Casting Aluminium + PC"]`
- `"White/Black\n\n白色/黑色"` (housingFinish) → `["White", "Black"]`
- `"3000K\n4000K"` (cct) → `["3000K", "4000K"]`
- `0.9` (powerFactor, number cell) → `["0.9"]`
- `"50,000 hrs "` → `["50,000 hrs"]`
- `"3000K（暖白）"` → `["3000K"]`
- `"铝"` → empty, warning `cjk_only_cell`

**Confirmed by the fixture:** English always comes first and Chinese follows a blank line, so step 3 removes it. Step 4 covers mixed cells. No Chinese is ever stored (user, 2026-10-07: English only).

### Numeric filter parsers (`numbers.ts`)
| Filter | Accepted examples | Stored |
|---|---|---|
| `cctK` | `3000K`, `2700K-6500K`, `3000K/4000K`, `CCT 3000K` | every number in 1000–10000 (a range stores both ends) |
| `cri` | `Ra>90`, `>90`, `CRI 90`, `Ra≥80` | the number (50–100) |
| `beamDeg` | `24°`, `15°/24°/36°`, `24 deg` | each angle (1–360) |
| `ugr` | `<19`, `UGR<16`, `UGR≤22` | the number (0–40) |
| `wattage` | `10W`, `7W/10W`, `10±1W`, plain `10` | each wattage (0.1–2000), tolerance dropped |
| `ip` | `IP20`, `IP65` | the two digits as a number |

- A value present but not parseable → warning `unparsed_filter_value` (column, value). The display string is kept.
- Filters = the union over product-level specs and every variant's specs. Then `withoutRestrictedFilters()` runs (Phase 2 must-do), so restricted columns never get filter numbers.

### Grouping (`group.ts`)
**Products**
- A product is one `NO.`. A row with an empty `NO.` belongs to the product above it.
- An empty `NO.` before any product is an error, `orphan_row`. So is an empty `Model No.` (`missing_model_no`).

**Shared vs per-variant values**
- For each spec key: if every row of the product has the same cleaned value (including "not applicable"), it becomes a product-level spec. Otherwise each row keeps its own value in `variant.specs`.
- `family` (Model Name) and `type` (Model Type) come from the first row. If later rows differ → warning.

**Base model code and slug**
- Base model code = the longest common prefix of the variants' model nos, with trailing `-`, `_`, `.`, `/` and spaces trimmed (T4): `AR-013A1`, `AR-013A2` → `AR-013A`.
- With a single variant, the base code is its model no.
- A prefix shorter than 3 characters → the first model no., plus a warning.
- Slug = `slugify(family + " " + base)` → `arc-ar-013a`. A taken slug gets the existing `uniqueSlug` suffix. **The slug is set on create only** and never changed by a re-import.
- Name on create = `"<Family> <base>"`, e.g. "Arc AR-013A".

**Variant labels**
- A variant's label is its own non-empty value in the optic columns that differ within the product (`lens`, `reflector`, `diffuser`), e.g. "Regular Lens" vs "High Effciency Reflector" for No. 76. If none of those differ, the label is the model no.
- A label the admin has already set is kept.

**Template columns and trackSize**
- `Category`: matched by slug or by `Main > Sub` name path, case-insensitive. `Extra Categories` and `Areas` are `;`-separated.
- An unknown name → warning, and the default category or empty list is used.
- `trackSize` is set only when the resolved category is under Magnetic Track and its slug starts with `5mm`, `10mm` or `20mm` (ADR 0041 rule).

**Duplicates**
- The same model no. on two rows of the sheet (case-insensitive) is an error, `duplicate_model_no`. Both products are blocked.
- The same `NO.` starting two products on one sheet is an error, `duplicate_product_no` (added in T4). NO. is unique per sheet only, because a workbook may restart numbering on each sheet.
- Two variants whose labels would collide get ` (<model no.>)`; still colliding after the length cut → the model no. (T4).

### Matching and field ownership (`plan.ts`; ADR in T7)
For each sheet product, look up existing products owning any of its model nos (case-insensitive):
- **0 found** → `create`.
- **1 found** → `update`, or `unchanged` when the merge result deep-equals the stored doc.
- **>1 found** → `blocked` with `model_no_conflict`: the sheet would merge products. So does a model no. owned by a product that belongs to a different sheet `NO.`.

| Field | Owner on re-import |
|---|---|
| `family`, `type`, `productNo`, `modelCode`, `specs`, `variants[].modelNo/specs`, `filters` (recomputed, restricted dropped) | **sheet**: overwritten |
| `mainCategory`, `extraCategories`, `areas` | sheet only when the template column has a value; otherwise kept (on create: the default category, empty lists) |
| `name`, `slug`, `status` (create = draft) | set on create, never touched afterwards |
| `variants[].label`, `variants[].imagePublicId` | set on create or for a new variant; an existing value is kept |
| `images` | append-only, for images whose `sourceSha256` isn't on the product yet |
| `description`, `extraSpecs`, `publicFiles`, `datasheetId`, `featured`, `trackSize` (once set) | **admin**: never touched |

- A published product stays published. Its tags are revalidated when it changes.
- The preview's diff lists the changed sheet-owned fields per product: `old → new`, at most 10 shown, then "+N more".

### Warnings
| Code | Severity | Meaning |
|---|---|---|
| `not_xlsx`, `too_large`, `zip_unsafe`, `no_header`, `missing_required_column` (NO., Model No.) | fatal (whole file) | nothing is previewed |
| `orphan_row`, `invalid_product_no`, `invalid_model_no`, `missing_model_no`, `duplicate_model_no`, `duplicate_product_no`, `model_no_conflict` | error (blocks that product) | the rest still imports |
| `missing_image`, `missing_spec` (CCT, CRI, Beam Angle, Wattage, Lumen Output), `unparsed_filter_value`, `cjk_only_cell`, `unknown_column`, `unknown_category`, `unknown_area`, `unsupported_image`, `value_truncated`, `family_mismatch`, `short_base_model_code`, `model_no_has_space`, `variant_removed` | warning | shown, does not block (`variant_removed` needs the acknowledgement) |

Every warning carries a sheet name, an Excel row number, and the column where one applies.

### Security
- **Every action:** `requireAdmin()` first, then a Zod-parsed input.
- **Staged key:** must match `^imports/<uuid v4>\.xlsx$`, with an escaped dot. This fixes the gate C L-1 pattern while we're here.
- **Untrusted file:** signature + zip safety check before exceljs inflates anything. Formulas are never evaluated. External links and macros are ignored or refused. Images are re-checked with `sharp` before upload. The Cloudinary upload is signed from the server with `overwrite: false` and a server-chosen id, then `inspectImage`.
- **Restricted values:**
  - The preview is a Server Action response, so it goes only to the admin and is never cached.
  - Audit meta holds counts and ids only, never values.
  - Filters go through `withoutRestrictedFilters`.
  - Nothing import-related is in a cached query.
- **Revalidation:** one revalidation per batch through `revalidateCatalogInAction`, with the batch's `tagsFor(id, published)` tags plus `products`.
- **Audit:** new action `import.commit` (target type `import`, id = the staged file's uuid). Meta: `{batch, created, updated, unchanged, blocked, imagesAdded, variantsRemoved}` and the product ids, within the 4096-byte cap at batch size 20.

## Tasks
Each task gets one commit, with typecheck + lint + tests green and the "Resume here" section rewritten before the commit. Every file starts with a 2–3 line header comment.

| # | Task | Owner | Key files | Tests |
|---|---|---|---|---|
| T0 | **Step 0 (main session, done 2026-10-07):** sheet received and studied ("Fixture findings"); `.gitignore` covers it; fixture path fixed in `import-engineer.md`; ADR 0054 (product page layout) | main | `.gitignore`, `.claude/agents/import-engineer.md` | — |
| T1 | **Model no. + model changes:** case-insensitive unique index on `variants.modelNo` (collation en/2). `takenModelNos`, the list search and the duplicate mapping compare case-insensitively. Add `ProductImage.sourceSha256?` (64 hex). A script `scripts/check-model-no-collisions.ts` lists case-only duplicates **before** the index is rebuilt. Migration note: the sync script never drops indexes, so the old index must be dropped in Atlas first (step in "User must do") | backend-architect | `src/models/product.ts`, `src/lib/admin/products.ts`, `src/lib/db-indexes.ts`, `scripts/*` | gate B L-A `it.fails` → `it`; `ZZ-9`/`zz-9` refused across products and within one; collision script on a memory DB. **ADR 0055** |
| T2 | **Reader + synthetic fixture:** the main session already studied the real sheet ("Fixture findings"); re-check it with the `xlsx` skill only where something is unclear. A synthetic fixture builder (`test/fixtures/import/build.ts`, exceljs) copies the real structure: row-1 bilingual headers with their case/space quirks, blank row 2, rich text cells, number cells, Nos. 76–81 with the Arc values (80/81 without model no.), and one oneCell PNG anchor per row with a picture shared across two products. Variants of it test merged cells and a second sheet. `safety.ts` (export a limits-aware central-directory reader from `xlsx-signature.ts`). `workbook.ts` | import-engineer | `src/lib/import/{types,safety,workbook}.ts`, `src/lib/xlsx-signature.ts`, `test/fixtures/import/*` | zip bomb (ratio, total size, entries), `.xlsm` refused, header detection with the real quirks, blank row skipped, merged cells, rich text, number cells, cached formula result, multiple sheets; the real sheet loads when present |
| T3 | **Cleaner + columns + numbers** (pure, table-driven TDD) | import-engineer | `src/lib/import/{clean,columns,numbers}.ts` | every rule and example above; every parser's accept/reject table; split policy per column. **ADR 0056** (cleaning + parsing rules) |
| T4 | **Grouping:** products, shared vs per-variant, base code, slug, name, labels, template columns, trackSize, row warnings | import-engineer | `src/lib/import/group.ts` | **golden No. 76 test** on the synthetic fixture, and on the real one when present; orphan/duplicate/missing model no.; single-variant base code; category path resolution |
| T5 | **Images:** drawings + rels anchors (oneCell + twoCell), any other image store → warning, row mapping, sha256, `sharp` format/size check; the first image of a product → gallery, a per-row image differing between variants → that variant's `imagePublicId` | import-engineer | `src/lib/import/images.ts` | anchors (twoCell/oneCell), picture shared across two products (one gallery image each), `cellimages.xml` present → warning, unsupported EMF → warning, oversize, same image on two rows → deduped. **QA gate A** (T1–T5: parser + safety, run on Opus) |
| T6 | **Infrastructure for commit:** `presignImportUpload` (R2 `imports/` prefix, ≤30 MB, 5-min TTL); `getImportBytes(key)` capped read; `uploadImageBuffer(productId, buffer)` in `cloudinary.ts` (signed server upload, server id, `overwrite:false`, then `inspectImage`, destroy on rejection); `sweep:incoming` also sweeps `imports/` older than 24 h; audit vocabulary `import.commit` + target type `import`; constants | backend-architect | `src/lib/{storage,cloudinary,constants,orphan-sweep}.ts`, `src/models/audit-actions.ts`, `src/lib/schemas/import.ts` | presign signs size/type; key regex (escaped dot); upload helper with mocked SDK (bad format destroyed); sweep selection includes `imports/` |
| T7 | **Plan / preview service:** matching (case-insensitive), classification, ownership merge, diff, warnings, `planHash`, `previewImport` (writes nothing; a test asserts zero writes) | import-engineer | `src/lib/import/{plan,index}.ts` | memory DB: create / update / unchanged / blocked; conflict across two products; admin-owned fields untouched in the merge; restricted filters dropped; hash changes when a matched product's `updatedAt` changes. **ADR 0057** (pipeline, stateless plan + hash, batches, ownership, removal policy) |
| T8 | **Commit service:** `commitImportBatch` (re-plan, hash check, per-product `updatedAt` stale check, removal ack, image upload with up to 4 at a time + `sourceSha256` dedupe, create with a pre-made ObjectId, update with `$set` on changed sheet-owned paths only, destroy uploaded images if the write fails, audit per batch, tags), `finishImport` | import-engineer | `src/lib/import/{commit,index}.ts` | **idempotency:** import twice → second run: all unchanged, 0 writes, 0 audit, 0 uploads, `updatedAt` identical; re-running a half-done import finishes it with no duplicates; stale product → refused with "preview again"; duplicate-key race → product error, not a crash; published product stays published. **QA gate B** (T6–T8: services, write path, leak check) |
| T9 | **Import UI + actions:** `/admin/import`, nav entry.<br>Step 1: file + default category, XHR PUT progress.<br>Step 2: summary counts, product table (status badge, sheet rows, variants, image count), expandable diff and warnings, filter by severity/code, restricted columns marked.<br>Step 3: removal acknowledgement → batch progress (`n / N`, retry a failed batch) → result with links to the products.<br>`actions.ts` is thin: `requireAdmin()`, service, `revalidateCatalogInAction`. Check `maxDuration` for the segment in the installed Next docs | admin-panel-builder | `src/app/admin/import/*`, `src/components/admin/import/*`, `admin-sections.ts` | actions as customer / visitor / banned → nothing changes; static guard test covers the new actions file; render tests for warning states. **ADR 0058** (import UI) |
| T10 | **Template download** (optional, can drop): `GET /api/admin/import/template` (`requireAdminForRoute`) returns an empty .xlsx with the 33 bilingual headers + `Category` / `Extra Categories` / `Areas`, `private, no-store` | backend-architect | `src/app/api/admin/import/template/route.ts` | 401/403 matrix; headers match `columns.ts` |
| T11 | **Exit e2e:** sign in → upload the synthetic fixture (R2/Cloudinary fakes) → preview shows the expected counts and warnings → commit → Arc product exists as a draft with 2 variants and an image → import again → preview says "all unchanged" and the commit writes nothing; axe on the import page; 375 px | admin-panel-builder | `e2e/admin-import.spec.ts` | as listed; never `networkidle`; `http://localhost`. **QA gate C** (Phase 3 exit, whole branch, Opus) |

After gate C passes: final ADR notes, tick Phase 3, rewrite Resume (next = Phase 4 planning), push, PR with `gh`, wait for CI, and **ask the user before merging**.

## Things the user must do
- ~~Provide the sheet, answer Q1–Q6~~ (done 2026-10-07). Ask the client about Nos. 80/81 (no model no.), the `95±` lumen efficiency values and the "Effciency" typo.
- **Before T1 runs against the real DB:** run `npm run check:model-nos` (T1 adds it). If it lists nothing, drop the index `variants.modelNo_1` in Atlas, then run `npm run db:indexes`. The sync script never drops indexes on its own.
- The R2 CORS rule from Phase 2 (PUT from localhost) already covers the `imports/` prefix. Nothing new until deploy.
- After T11: one manual smoke with real credentials. Import the real sheet into the dev DB, check a few products against the sheet, then import again and confirm "all unchanged".

## Risks
- **The real sheet is unknown.** Merged cells, where the Chinese sits, hidden rows and image anchoring decide several rules. T2 studies it first, and the rules marked "fixture decides" may change by one line.
- **Other image stores:** the client uses WPS but anchors images the standard way. If a later sheet uses WPS in-cell images (`DISPIMG`) or Excel "Place in cell" (`richData`), the preview warns `unsupported_image_store` and we add a reader then.
- **Client data quality:** Nos. 80/81 have no model no., and some values are odd (`95±`, a typo). The importer flags them and never corrects data.
- **Memory and time:** exceljs loads the whole workbook. A 30 MB file is fine within the function memory, but commit time grows with image count, hence the batches. Vercel's plan limits aren't known yet (account pending), so batch size is a constant.
- **Data loss through ownership mistakes.** That is why the ownership table is explicit and tested, removals need an acknowledgement, and images are append-only.
- **Collation index migration:** an existing case-only duplicate would make the index build fail. The collision script runs first.
- **Cloudinary orphans:** if a product write fails after its images were uploaded, the uploads are destroyed (best effort). Otherwise they are left for the 24 h sweep, the same as in Phase 2. The per-environment folder prefix is still open (gate E).
- **Filter parse gaps:** values that don't parse are kept for display and flagged, never guessed.

## ADRs to write (main session)
- **0054**: product page spec placement (the client's pink/green columns). Written 2026-10-07, applied in Phase 4.
- **0055**: case-insensitive model no. uniqueness (collation index, lookups, migration).
- **0056**: import cell cleaning and parsing rules (NFKC, blank-line cut, CJK strip, n/a tokens, per-column split policy, filter parsers).
- **0057**: import pipeline (R2 staging, stateless preview + `planHash`, idempotent batches, field ownership, variant removal policy, images at commit with sha256 dedupe, audit `import.commit`).
- **0058**: import UI.

## Verification
- Per task: `npm run typecheck`, `npm run lint`, `npm test`.
- Exit:
  - `npm run build`, `npm run test:e2e`, `npm run audit`, gitleaks;
  - `npm run db:indexes` on a scratch DB (collation index built);
  - golden test green on the real sheet locally;
  - re-import smoke with real credentials (see above).
- QA gates: A after T5, B after T8, C at exit.

## Phase 2 leftovers folded in
- Gate B L-A → T1.
- `withoutRestrictedFilters` in the import → T7/T8.
- The 24 h sweep vs preview images → solved by uploading at commit (T8).
- Gate C L-1 (escaped dot) → the new import key pattern in T6 is written correctly; the datasheet patterns get the same fix in T6 (two `it.fails` → `it`).
- Everything else from Phase 2 stays in the backlog (not blocking).
