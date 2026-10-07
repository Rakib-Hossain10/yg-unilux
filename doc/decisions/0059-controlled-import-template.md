# 0059 — The controlled import template is the primary import input
- Status: Accepted
- Date: 2026-10-07
- Code: planned in Phase 3 T10a/T10b (`src/lib/import/template.ts`, `src/app/api/admin/import/template/route.ts`)

## Context
Phase 3 was planned around importing the client's own spec sheet as it is: bilingual headers, merged cells, WPS quirks, free-typed values. The sheet we studied (`doc/reference/client-sample-sheet.xlsx`) turned out to be only a sample. The user (2026-10-07) decided that from now on the client always fills a template the user controls, with fixed rules:
- one row per variant;
- Model No. always filled;
- no merged cells;
- English-only headers;
- `-` for not applicable;
- fixed Category / Extra Category / Area values.

## Decision
1. **The template is the main defence; the parser is the safety net.** T10 (template download) is no longer optional, and it is built next, before T6. The tolerant parser stays as it is: case-insensitive headers, the blank-line cut and CJK strip, per-column split policies, the sheet guard and every warning. It exists to catch human error, and we no longer design for arbitrary sheets.
2. **Template layout** (`buildImportTemplate({categories, areas})`, generated per download from the database, because the category tree and areas are edited in the admin panel):
   - **Sheet `Products`** (visible):
     - row 1 holds English-only headers: the 33 sheet columns in the client's order, then `Category`, `Extra Category 1`, `Extra Category 2`, then one `Area: <name>` column per area, in the admin's area order;
     - the header row is frozen and bold, with set column widths.
   - **Sheet `Lists`** (`veryHidden`): category paths (`Main` and `Main > Sub`) and `Yes` / `No`. The dropdowns point straight at these ranges (`Lists!$A$2:$A$n`), not at defined names.
   - **Strict list validation** (error style "stop"), on a bounded range of data rows (2 to `MAX_TEMPLATE_ROWS + 1`, never whole columns), for:
     - `Category`, `Extra Category 1` and `Extra Category 2`, from the category list;
     - every `Area:` column, from Yes/No.
   - **Header notes** (cell comments) explain the rules, each on the header it is about:
     - one row per variant;
     - `NO.` goes on a product's first row, and its other variant rows leave it blank (or repeat the same NO.);
     - Model No. is always filled and never repeated;
     - no merged cells;
     - English only;
     - `-` means not applicable;
     - one picture inside the row's Image cell;
     - categories and areas only from the dropdowns.
3. **Areas use one Yes/No column per area** (user's choice). There are 7 known areas; marking Yes is the clearest input for a non-technical person, with no order and no duplicates. The header carries the area name. A header naming an area that no longer exists (renamed or deleted since the download) → the existing `unknown_area` warning, once per column.
4. **Extra categories use 2 numbered dropdown slots** (`Extra Category 1`, `Extra Category 2`; user's choice). The category tree is open and growing, so one column per category would not scale. A product that needs more extras gets them by hand in the admin panel.
5. **Parser additions (safety net, T10a):**
   - `columns.ts` recognises `Extra Category <n>` and `Area: <name>` headers. The legacy `;`-separated `Extra Categories` and `Areas` columns keep working.
   - Area flags: `Yes` / `Y` / `True` / `1` / `✓` select the area (case-insensitive). `No`, blank, `-` and `False` don't. Anything else → a new warning `invalid_area_flag`.
   - Ownership is unchanged from the plan. The sheet owns areas and extras only when at least one value was selected for the product; all No/blank keeps the stored values.
   - `workbook.ts` skips the template's `Lists` sheet silently, with no `sheet_skipped` or `hidden_sheet` warning.
   - `group.ts`: a row that repeats the current product's `NO.` directly below it, on the same sheet, continues that product. A non-adjacent repeat is still `duplicate_product_no`. This tolerates people who fill NO. on every variant row.
6. **On import, the template's own data validations are stripped** by the sheet guard (gate A, `620711c`), like any other validation. That is safe: the import never reads them.
7. **Download route (T10b):** `GET /api/admin/import/template`:
   - `requireAdminForRoute`;
   - reads categories and areas live;
   - `Cache-Control: private, no-store`;
   - `Content-Disposition: attachment`.

   The import page (T9) links to it.

## Consequences
- A filled template round-trips with **zero warnings**: generate → fill (test helper) → `checkImportFile` → `readWorkbook` → clean → group. The comments' VML/comments parts and the validations must pass the safety check and the sheet guard, and pictures must still map to rows. This round trip becomes the main golden test. The bilingual synthetic fixture and the client sample stay as tolerance tests.
- The template's dropdown values go stale when categories or areas change. The client downloads a fresh template, and the preview's `unknown_category` / `unknown_area` warnings catch an old one.
- Excel caps a list dropdown at 32,767 items; the category tree is far below that.
- QA gate B now also covers T10 (template generator, route guard, round trip).

## Addendum (T10a implementation)
- `MAX_TEMPLATE_ROWS = 3000`: validations cover data rows 2–3001, one `sqref` per column, never whole columns.
- An area column holding only `No`/`n`/`false`/`0`/`-`/blank does not make a row a data row (a pre-filled "No" dropdown must not create `orphan_row` warnings). A `Yes` alone still makes one (orphan or continuation).
- Numbered `Extra Category <n>` slots and the legacy `Extra Categories` column merge into one list; the same slot or the same area header twice → `duplicate_column`.
- The helper sheet is skipped by name `Lists` (case-insensitive); any other hidden sheet still warns.
- `cleanAreaFlag` accepts Yes/Y/True/1/✓/✔, strips CJK, uses the first non-empty line.
- `unknown_area` is still emitted per row (only for a Yes under an unknown `Area:` column), not once per column; fixing that needs header names passed to `groupRows` (open).
- Header notes are cell comments; check their box size in real Excel/WPS (gate B). The Image note must not suggest "Place in Cell" (stored as richData → `unsupported_image_store`); reword to floating pictures positioned on the row before client hand-off.
