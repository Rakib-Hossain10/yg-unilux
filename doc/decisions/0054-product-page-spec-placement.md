# 0054 — Product page: quick-spec panel (pink columns) and full spec table (green columns)
- Status: Accepted (client instruction; built with the product page, not in Phase 3)
- Date: 2026-10-07

## Context
The client's spec sheet (`doc/reference/client-sample-sheet.xlsx`, local only) colours its header cells. The client says the colours decide where each column shows on the product page. In the sheet's styles, pink is theme colour 9 and green is theme colour 8, both with tint 0.4:
- **Pink:** Model Name, Model No., Housing Material, Housing Color/Finish, Reflector Color, Cut-out Size, CCT.
- **Green:** Lens, Reflector, Diffuser, Dimensions, Rotating Angle, Chip Type, Holder, Chip Efficiency, CRI, Beam Angle, UGR, Driver, Voltage Input, Wattage, Lumen Output, Lumen Efficiency, Power Factor, SDCM, Dimmable, Lifespan, IP Rating, Warranty Period.
- **No fill:** NO., Model Type, Batch No., Image.

The user called this "Phase 6". In our roadmap the product page is **Phase 4** (Phase 6 is the home page and motion), so it is applied with the Phase 4 product page.

## Decision
1. **Quick-spec panel.** The product page gets a quick-spec panel on the right, next to the gallery: family (Model Name), the current variant's Model No. (it follows the optic switch), Housing Material, Housing Color/Finish, Reflector Color, Cut-out Size, CCT.
2. **Full spec table.** Every green column goes in a full spec table below the product, in sheet order, with the existing UI groups (ADR 0044 `spec-groups.ts`).
3. **Placement lives in data, not in the page.** Add a `placement: "quick" | "table"` field to `SPEC_COLUMNS` (`src/models/spec-columns.ts`), next to the planned `group` field (ADR 0044 follow-up). The page reads it.
   - Model Name and Model No. are identity fields, not spec keys, so the page always puts them in the panel.
   - Batch No. has no colour and is restricted by default. It goes in the table, inside the restricted block.
4. **Placement does not override visibility.**
   - A restricted column is never shown in either place to anyone not allowed to see it (CLAUDE.md rule 9, ADR 0002).
   - A restricted quick-spec column (none by default) renders inside the dynamic restricted block, never in the cached panel.
5. **The import ignores the colours.** Phase 3 does not read fills. Placement is a fixed property of each column, not of each uploaded sheet.

## Consequences
- Phase 4 product page task: build the panel + table from `placement`; add a test that pink keys = `placement: "quick"`.
- If the client recolours a column, we change one line in `spec-columns.ts`, not the import.
- Empty values (not applicable) are hidden in both places, as before.
