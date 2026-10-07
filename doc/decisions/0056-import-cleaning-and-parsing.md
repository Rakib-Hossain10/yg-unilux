# 0056 — Import cell cleaning and filter parsing
- Status: Accepted
- Date: 2026-10-07
- Code: `src/lib/import/{clean,columns,numbers}.ts` (Phase 3 T3, `4c9821f`)

## Context
The admin uploads the client's sheet as it is. Its cells are:
- bilingual (English, a blank line, then Chinese);
- sometimes mixed on one line ("Lifud 莱福德");
- sometimes rich text, full-width or number cells.

The site is English only (Phase 3 decision 7), so no Chinese may be stored.

## Decision
### Cleaning order (`cleanSpecCell`, `cleanRow`)
1. **To string.** A number cell becomes a plain decimal string (`numberToText`: 15 significant digits, no exponent, no grouping, never "-0"). The reader uses the same helper.
2. **NFKC.** Full-width `３０００Ｋ` and `（` become ASCII. `≤ ± ° Ø × ~` stay as they are (tested). Accepted side effect: NFKC also folds `²`→`2` and `™`→`TM`.
3. **Normalise, then cut at the first blank line.**
   - CRLF, CR, U+2028 and U+2029 become `\n`.
   - Invisible characters are removed: C0/C1 controls except tab and newline, the soft hyphen, U+200B–200F, U+202A–202E, U+2060–2064 and the BOM. Left in, they would create a second upsert key for the same model no.
   - Tabs become spaces.
   - The wave dashes U+301C and U+3030 become `~`, so a range survives the CJK strip.
   - Blank lines before the first text are skipped. Only the text before the first empty or whitespace-only line is kept.
4. **Strip CJK on each line.**
   - Ranges (`CJK_CLASS`, shared with header matching): Han, Hiragana, Katakana, Hangul, Bopomofo, U+3000–303F, U+FE30–FE4F, U+FF00–FFEF.
   - Brackets left holding nothing are removed, nested ones too.
   - Separators left dangling next to removed text are dropped: `/ , ; : + | & · - – —`.
   - A sign that belongs to a number is kept (`Ra90+`, `-20°C`).
   - Two pieces are joined by the separator that stood between them (`White/白色/Black` → `White/Black`), otherwise by a space.
   - Spaces are collapsed and each line is trimmed. The trimming uses loops, not regexes, so there is no regex backtracking.
5. **Drop empty lines.** If the kept text had CJK and nothing is left, the cell gets the warning `cjk_only_cell`.
6. **Not applicable.** A line that is exactly `-`, `–`, `—`, `/` or `n/a` (any case) is dropped. A cell with nothing else is not applicable: the key is left out and the value is hidden. Blank and `-` therefore compare equal. `n/a` was added so `N/A` in a slash column doesn't split into "N" and "A".
7. **Split policy** (`SPLIT_POLICY`, `satisfies Record<SpecKey | "family" | "type", SplitPolicy>`, pinned by a test):
   - `options` (one option per line): cct, beamAngle, wattage, lumenOutput, lumenEfficiency, cri, ugr, ipRating, voltageInput, chipType, driver, dimmable.
   - `options+slash` (lines and `/`): housingFinish, reflectorColor.
   - `join` (lines joined with one space): housingMaterial, lens, reflector, diffuser, dimensions, cutOutSize, rotatingAngle, holder, chipEfficiency, powerFactor, sdcm, lifespan, warrantyPeriod, batchNo, and the identity fields `type` and `family`.
   - Only the slash policy splits on `/`, so `AC100-240V/50-60Hz` stays one value.
   - Values are cut by code point to `MAX_SPEC_VALUE_LENGTH`, deduped with order kept, and capped at `MAX_SPEC_OPTIONS`. Either cut gives the warning `value_truncated`.

### Identity and template cells
- **`NO.`:** blank means a continuation row. Otherwise it must be a safe integer above 0, or the row gets the error `invalid_product_no`. `-` counts as invalid, never as a silent merge into the product above.
- **`Model No.`:** one line, never truncated (it is the upsert key).
  - Longer than `MAX_MODEL_NO_LENGTH` → error `invalid_model_no`.
  - Empty → null; T4 reports `missing_model_no`.
- **`Model Name` / `Model Type`:** `join` policy, capped at 100 characters.
- **`Category`:** one name or a `Main > Sub` path.
- **`Extra Categories` / `Areas`:** split on `;` or line breaks, deduped case-insensitively, at most 20 each.

### Filter parsers (`numbers.ts`)
- **Reading numbers:**
  - Each number is read with the unit written right after it: `°`, a count marker `×` / `*`, or letters. `to` is a range word, not a unit.
  - A unitless number before a range gap (`-`, `~`, `–`, `—`, `/`, `to`) takes the next number's unit.
  - Each parser keeps only numbers that have no unit or one of its own units, and that lie within its bounds.

| Filter | Bounds | Accepted |
|---|---|---|
| cctK | 1000–10000 | K |
| cri | 50–100 | Ra, min; R-values like `R9>50` are removed first |
| beamDeg | 1–360 | °, deg, degree(s); `15x45°` is a pair |
| ugr | 0–40 | max |
| wattage | 0.1–2000 | W |
| ip | 0–69 | `IP[0-6][0-9]`; `IPX4` gives nothing |

- **What is ignored:**
  - other units (the 220 in `AC220V`);
  - counts (`2x10W`, `10W*2`);
  - codes glued to letters (`GU10`, `MR16`, `PAR30`), except after the labels Ra, CRI, UGR and CCT;
  - tolerances (`±n`, `+/-n`).
- **Thousands separators:**
  - a single comma (`3,000`), or a chain whose first group has 1–2 digits (`1,200,000`), is one number;
  - a chain of 3-digit groups (`100,150,200`) is a list;
  - a lone `ddd,ddd` is ambiguous: it is read as one number, which falls out of bounds and gets flagged.
- **Warnings:** an option with text but no number gives `unparsed_filter_value`. The display string is always kept.
- **`filtersFromSpecs`:** the union over product and variant specs, deduped, sorted ascending, at most `MAX_FILTER_VALUES` per filter, values above `MAX_FILTER_NUMBER` dropped. It does **not** remove restricted columns' filters. The plan step (T7) must call `withoutRestrictedFilters` (rule 9, ADR 0002).
- **`FILTER_KEY_BY_SPEC`** moved to the pure `src/models/spec-columns.ts` (`FilterKey` type). `settings.ts` re-exports it, and `settings-ui` derives its column list from it.

## Consequences
- No CJK reaches the database. A property test checks every cleaned value of the synthetic fixture, and of the real sheet when it is present: zero CJK, zero `cjk_only_cell`, No. 76's golden values and filters pinned.
- Data is never "fixed". Odd values (`95±`, typos) are kept, and unreadable ones are flagged.
- A Model No. cell holding two model nos. on separate lines becomes one value with a space. T4 may warn when a model no. contains a space.
- Tooling: the Write/Edit tools can turn `\uXXXX` escapes into raw characters. Source files keep escapes (a raw U+2028 inside a regex literal broke parsing once).
