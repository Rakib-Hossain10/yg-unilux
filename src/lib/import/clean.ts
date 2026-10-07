// The import's cell cleaner: turns one raw sheet cell into plain English
// display values, in the exact order of the Phase 3 plan's "Cell cleaning
// rules" 1-7 (ADR 0056). Pure: no I/O, no server-only, safe for any caller.
//
// English only (plan decision 7): no CJK character survives any function
// here. The client's sheet puts English first, then a blank line, then the
// Chinese, so the blank-line cut drops most Chinese and the CJK strip catches
// the rest ("Lifud 莱福德" → "Lifud").

import {
  MAX_EXTRA_CATEGORIES,
  MAX_MODEL_NO_LENGTH,
  MAX_PRODUCT_AREAS,
  MAX_PRODUCT_FAMILY_LENGTH,
  MAX_PRODUCT_TYPE_LENGTH,
  MAX_SPEC_OPTIONS,
  MAX_SPEC_VALUE_LENGTH,
} from "@/lib/constants";
import {
  SPEC_KEYS,
  type SpecKey,
  type SpecValues,
} from "@/models/spec-columns";

import { CJK_CLASS, SPLIT_POLICY, type SplitPolicy } from "./columns";
import {
  importWarning,
  type ColumnKey,
  type ImportWarning,
  type SheetRow,
} from "./types";

/** A raw cell as the reader gives it: text, or a number from a number cell. */
export type RawCell = string | number | null | undefined;

/** Where a cell is, for the warnings it produces. */
export interface CellAt {
  sheet: string;
  /** Excel row number (1-based). */
  row: number;
}

/** A cleaned multi-value cell. `values` null = not applicable (hidden). */
export interface CleanedCell {
  values: string[] | null;
  warnings: ImportWarning[];
}

/** A cleaned single-value cell. `value` null = empty / not applicable. */
export interface CleanedText {
  value: string | null;
  warnings: ImportWarning[];
}

/** A cleaned name list (template columns); empty when the cell is blank. */
export interface CleanedList {
  values: string[];
  warnings: ImportWarning[];
}

/** The `NO.` cell: a new product, a continuation row, or an error. */
export type ProductNoResult =
  | { status: "ok"; value: number }
  | { status: "continuation" }
  | { status: "invalid"; warning: ImportWarning };

/*
 * Template names (Category, Extra Categories, Areas) are looked up, never
 * stored as typed; a "Main > Sub" path of two 200-character names fits.
 */
const MAX_TEMPLATE_NAME_LENGTH = MAX_SPEC_VALUE_LENGTH;

/* Rule 6: these, alone on a line, mean "not applicable". Compared lowercased.
 * "n/a" is ours (ADR 0056): without it, "N/A" in a slash column would split
 * into the options "N" and "A". */
const NOT_APPLICABLE = new Set(["-", "\u2013", "\u2014", "/", "n/a"]);

const CJK_TEST = new RegExp(`[${CJK_CLASS}]`, "u");
const CJK_RUNS = new RegExp(`[${CJK_CLASS}]+`, "gu");

/* Removed CJK is first replaced by this marker, so the separators next to it
 * can be found. Control characters (U+0000 included) are removed before. */
const MARK = "\u0000";

/* Invisible characters a copy-paste can carry: C0/C1 controls except tab and
 * newline, the soft hyphen, zero-width spaces/joiners, direction marks and
 * embeddings, invisible operators and the BOM. */
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/* Characters that can dangle when the CJK next to them is removed:
 * "White/白色" → "White", "铝 + PC" → "PC" (see danglingStart/End). */
const SEPARATOR_CHARS = new Set([..."/,;:+|&\u00B7-\u2013\u2014"]);
const isSpace = (ch: string) => /\s/.test(ch);
/* A space, a separator, or "" (the end of the piece). */
const isBoundary = (ch: string) =>
  ch === "" || isSpace(ch) || SEPARATOR_CHARS.has(ch);

/* A bracket pair holding nothing but removed CJK, spaces and separators.
 * Brackets that were empty in the sheet ("()") go too, on purpose. */
const EMPTY_BRACKETS = /[([{]([\s\u0000/,;:+|&\u00B7\u2013\u2014-]*)[)\]}]/g;

/**
 * A number cell as a plain decimal string: at most 15 significant digits (so
 * 0.1 + 0.2 is "0.3"), no exponent, no grouping, never "-0". Non-finite
 * numbers give undefined (an empty cell).
 */
export function numberToText(n: number): string | undefined {
  if (!Number.isFinite(n)) return undefined;
  if (Object.is(n, -0)) return "0";
  return n.toLocaleString("en-US", {
    useGrouping: false,
    maximumSignificantDigits: 15,
  });
}

/* ---------------------------------------------------------------------------
 * Rules 1-5: raw cell → clean English lines.
 * ------------------------------------------------------------------------- */

interface Lines {
  /** The cleaned, non-empty lines (rule 5). */
  lines: string[];
  /** The kept text held CJK before the strip (for `cjk_only_cell`). */
  hadCjk: boolean;
}

function toLines(raw: RawCell): Lines {
  // 1. To a string.
  const text = typeof raw === "number" ? numberToText(raw) : (raw ?? undefined);
  if (text === undefined || text === "") return { lines: [], hadCjk: false };

  // 2. NFKC: full-width "３０００Ｋ" and "（" become ASCII before stripping.
  //    It leaves ≤ ± ° Ø × alone (tested).
  let normal = text.normalize("NFKC");

  // 3. Line endings to \n, invisible characters out, tabs to spaces; then
  //    keep only the text before the first blank line (the Chinese block).
  //    Blank lines BEFORE any text are just stray newlines and are skipped.
  normal = normal
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(INVISIBLE, "")
    // Wave dashes are CJK punctuation NFKC keeps; they mean a range "~".
    .replace(/[\u301C\u3030]/g, "~")
    .replace(/\t/g, " ")
    .replace(/^(?:[^\S\n]*\n)+/, "");
  const blank = normal.search(/\n[^\S\n]*\n/);
  const kept = blank === -1 ? normal : normal.slice(0, blank);

  // 4 + 5. Strip CJK per line, drop lines left empty.
  const lines = kept
    .split("\n")
    .map(stripCjkLine)
    .filter((line) => line !== "");
  return { lines, hadCjk: CJK_TEST.test(kept) };
}

/*
 * Rule 4 for one line: CJK out, then empty brackets and the separators left
 * dangling next to the removed text, then spaces collapsed and trimmed.
 * Separators away from removed CJK are kept ("-20~45°C", "Aluminium + PC").
 */
function stripCjkLine(line: string): string {
  let marked = line.replace(CJK_RUNS, MARK);
  // Brackets left holding nothing ("3000K(暖白)" → "3000K"); repeat for nesting.
  for (let i = 0; i < 5; i++) {
    const next = marked.replace(EMPTY_BRACKETS, MARK);
    if (next === marked) break;
    marked = next;
  }
  return joinAroundMarks(marked).replace(/\s+/g, " ").trim();
}

/*
 * Splits a line at the removed-CJK marks, trims the dangling separators off
 * the sides that faced removed text, and rejoins the remaining pieces. Two
 * pieces are joined by the separator that stood between them
 * ("White/白色/Black" → "White/Black", "Aluminium 铝 + PC" →
 * "Aluminium + PC"), else by a space ("Aluminium铝Body" → "Aluminium Body").
 * Loops, not regexes, for the trim: a long separator run cannot backtrack.
 */
function joinAroundMarks(marked: string): string {
  const parts = marked.split(/\u0000+/);
  if (parts.length === 1) return marked;
  let out = "";
  let gap = "";
  parts.forEach((part, i) => {
    const start = i > 0 ? danglingStart(part) : 0;
    const end = i < parts.length - 1 ? danglingEnd(part, start) : part.length;
    gap += part.slice(0, start);
    const piece = part.slice(start, end);
    if (piece !== "") {
      out = out === "" ? piece : out + joiner(gap) + piece;
      gap = "";
    }
    gap += part.slice(end);
  });
  return out;
}

/*
 * Where a piece's text starts after the removed CJK before it: spaces are
 * skipped, and a separator is dropped only when it dangles, i.e. it touches
 * the removed text or has a boundary (space, separator, end) on its far side.
 * " + PC" → "PC", "/Black" → "Black", but the sign of " -20°C" stays.
 */
function danglingStart(part: string): number {
  let i = 0;
  for (;;) {
    let j = i;
    while (j < part.length && isSpace(part.charAt(j))) j++;
    const ch = part.charAt(j);
    const touching = j === i;
    // A sign glued to a number belongs to it: "温度:-20°C" keeps "-20°C".
    if ((ch === "+" || ch === "-") && /\d/.test(part.charAt(j + 1))) return j;
    if (
      SEPARATOR_CHARS.has(ch) &&
      (touching || isBoundary(part.charAt(j + 1)))
    ) {
      i = j + 1;
      continue;
    }
    return j;
  }
}

/* The mirror of danglingStart for the end of a piece, before removed CJK:
 * "White/" → "White", "Lens," → "Lens", but "Ra90+ " keeps its "+". */
function danglingEnd(part: string, start: number): number {
  let i = part.length;
  for (;;) {
    let j = i;
    while (j > start && isSpace(part.charAt(j - 1))) j--;
    const ch = j > start ? part.charAt(j - 1) : "";
    const touching = j === i;
    const far = j - 2 >= start ? part.charAt(j - 2) : "";
    // A "+" right after a number belongs to it: "Ra90+高显色" keeps "Ra90+".
    if (ch === "+" && /\d/.test(far)) return j;
    if (SEPARATOR_CHARS.has(ch) && (touching || isBoundary(far))) {
      i = j - 1;
      continue;
    }
    return j;
  }
}

/* The text that joins two pieces: the first real separator in the gap
 * (spaced like the original), or one space. */
function joiner(gap: string): string {
  const separator = [...gap].find((ch) => SEPARATOR_CHARS.has(ch));
  if (separator === undefined) return " ";
  const spaced = /^\s|\s$/.test(gap);
  return spaced ? ` ${separator} ` : separator;
}

const isNotApplicable = (text: string) =>
  NOT_APPLICABLE.has(text.toLowerCase());

/* ---------------------------------------------------------------------------
 * Rules 5-7 on top: warnings, not applicable, split policy, caps.
 * ------------------------------------------------------------------------- */

interface Caps {
  maxOptions: number;
  maxLength: number;
}

const SPEC_CAPS: Caps = {
  maxOptions: MAX_SPEC_OPTIONS,
  maxLength: MAX_SPEC_VALUE_LENGTH,
};

/*
 * The meaningful lines of a cell, or null when it is not applicable. A cell
 * whose kept text was all CJK gets `cjk_only_cell` (its English is missing).
 */
function meaningfulLines(
  raw: RawCell,
  at: CellAt,
  column: ColumnKey,
  warnings: ImportWarning[],
): string[] | null {
  const { lines, hadCjk } = toLines(raw);
  if (lines.length === 0) {
    if (hadCjk) {
      warnings.push(
        importWarning("cjk_only_cell", {
          ...at,
          column,
          detail:
            "This cell has only Chinese text, so it was left empty. Add the English value in the sheet (English first, then a blank line, then Chinese).",
        }),
      );
    }
    return null;
  }
  // 6. Not-applicable lines go; a cell of nothing else is not applicable.
  const kept = lines.filter((line) => !isNotApplicable(line));
  return kept.length === 0 ? null : kept;
}

/* Rule 7: the split policy, then length cap, dedupe and option-count cap. */
function splitAndCap(
  lines: string[],
  policy: SplitPolicy,
  caps: Caps,
  at: CellAt,
  column: ColumnKey,
  warnings: ImportWarning[],
): string[] | null {
  let values: string[];
  if (policy === "join") {
    values = [lines.join(" ")];
  } else if (policy === "options+slash") {
    values = lines
      .flatMap((line) => line.split("/"))
      .map((value) => value.trim())
      .filter((value) => value !== "" && !isNotApplicable(value));
  } else {
    values = lines;
  }

  let cut = false;
  values = values.map((value) => {
    const chars = Array.from(value); // code points, so no half surrogate pair
    if (chars.length <= caps.maxLength) return value;
    cut = true;
    return chars.slice(0, caps.maxLength).join("").trimEnd();
  });
  if (cut) {
    warnings.push(
      importWarning("value_truncated", {
        ...at,
        column,
        detail: `A value was longer than ${caps.maxLength} characters and was cut to that length.`,
      }),
    );
  }

  values = [...new Set(values)];
  if (values.length > caps.maxOptions) {
    warnings.push(
      importWarning("value_truncated", {
        ...at,
        column,
        detail: `Only the first ${caps.maxOptions} of ${values.length} options were kept.`,
      }),
    );
    values = values.slice(0, caps.maxOptions);
  }
  return values.length === 0 ? null : values;
}

function cleanCell(
  raw: RawCell,
  policy: SplitPolicy,
  caps: Caps,
  at: CellAt,
  column: ColumnKey,
): CleanedCell {
  const warnings: ImportWarning[] = [];
  const lines = meaningfulLines(raw, at, column, warnings);
  const values =
    lines === null
      ? null
      : splitAndCap(lines, policy, caps, at, column, warnings);
  return { values, warnings };
}

/* ---------------------------------------------------------------------------
 * Public entry points, one per kind of column.
 * ------------------------------------------------------------------------- */

/**
 * One spec cell → its display values (options or one joined value, by the
 * column's split policy), or null when not applicable, plus warnings
 * (`cjk_only_cell`, `value_truncated`).
 */
export function cleanSpecCell(
  key: SpecKey,
  raw: RawCell,
  at: CellAt,
): CleanedCell {
  return cleanCell(raw, SPLIT_POLICY[key], SPEC_CAPS, at, key);
}

/**
 * The `NO.` cell. Blank = a continuation row (it belongs to the product
 * above). Anything else must be a positive whole number, or the row gets the
 * error `invalid_product_no`; "-" is an error here, never a silent merge.
 */
export function cleanProductNo(raw: RawCell, at: CellAt): ProductNoResult {
  const { lines, hadCjk } = toLines(raw);
  if (lines.length === 0 && !hadCjk) return { status: "continuation" };
  const text = lines.join(" ");
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (Number.isSafeInteger(value) && value > 0) return { status: "ok", value };
  return {
    status: "invalid",
    warning: importWarning("invalid_product_no", {
      ...at,
      column: "productNo",
      detail:
        "NO. must be a whole number above 0 (or empty on a product's second and later rows). This product is not imported.",
    }),
  };
}

/**
 * The `Model No.` cell: one line (inner whitespace becomes one space), NFKC,
 * CJK stripped, never truncated (a cut model no. could collide with another;
 * an over-long one gets the error `invalid_model_no`).
 * Empty or "-" gives null; grouping (T4) reports `missing_model_no`.
 */
export function cleanModelNo(raw: RawCell, at: CellAt): CleanedText {
  const warnings: ImportWarning[] = [];
  const lines = meaningfulLines(raw, at, "modelNo", warnings);
  const value = lines === null ? null : lines.join(" ").trim();
  // Too long to save (the model no. is the upsert key, so it is never cut):
  // flag it here so the preview blocks the product with a clear reason.
  if (value !== null && Array.from(value).length > MAX_MODEL_NO_LENGTH) {
    warnings.push(
      importWarning("invalid_model_no", {
        ...at,
        column: "modelNo",
        detail: `Model No. is longer than ${MAX_MODEL_NO_LENGTH} characters. This product is not imported.`,
      }),
    );
  }
  return { value: value === "" ? null : value, warnings };
}

function cleanSingle(
  raw: RawCell,
  at: CellAt,
  column: ColumnKey,
  maxLength: number,
): CleanedText {
  const { values, warnings } = cleanCell(
    raw,
    "join",
    { maxOptions: 1, maxLength },
    at,
    column,
  );
  return { value: values?.[0] ?? null, warnings };
}

/** The `Model Name` cell (the family, e.g. "Arc"). */
export function cleanFamily(raw: RawCell, at: CellAt): CleanedText {
  return cleanSingle(raw, at, "family", MAX_PRODUCT_FAMILY_LENGTH);
}

/** The `Model Type` cell; its lines are one value (`join` policy). */
export function cleanType(raw: RawCell, at: CellAt): CleanedText {
  return cleanSingle(raw, at, "type", MAX_PRODUCT_TYPE_LENGTH);
}

/** The optional `Category` template cell: one slug or "Main > Sub" path. */
export function cleanCategory(raw: RawCell, at: CellAt): CleanedText {
  return cleanSingle(raw, at, "category", MAX_TEMPLATE_NAME_LENGTH);
}

/**
 * The optional `Extra Categories` / `Areas` template cells: names separated
 * by ";" (or by line breaks), CJK stripped, deduped case-insensitively, capped
 * at the product's list limits.
 */
export function cleanNameList(
  column: "extraCategories" | "areas",
  raw: RawCell,
  at: CellAt,
): CleanedList {
  const warnings: ImportWarning[] = [];
  const lines = meaningfulLines(raw, at, column, warnings) ?? [];
  const names = lines
    .flatMap((line) => line.split(";"))
    .map((name) => name.trim())
    .filter((name) => name !== "" && !isNotApplicable(name));
  const seen = new Set<string>();
  const unique = names.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const maxOptions =
    column === "areas" ? MAX_PRODUCT_AREAS : MAX_EXTRA_CATEGORIES;
  const values =
    unique.length === 0
      ? null
      : splitAndCap(
          unique,
          "options",
          { maxOptions, maxLength: MAX_TEMPLATE_NAME_LENGTH },
          at,
          column,
          warnings,
        );
  return { values: values ?? [], warnings };
}

const AREA_YES = new Set(["yes", "y", "true", "1", "✓", "✔"]);
const AREA_NO = new Set(["", "no", "n", "false", "0", "-"]);
const AREA_CJK = new RegExp(`[${CJK_CLASS}]`, "gu");

/**
 * One `Area: <name>` Yes/No cell. Yes / Y / True / 1 / a tick select the
 * area; blank, No, N, False, 0 and "-" do not (case-insensitive, a Chinese
 * word beside the English one is ignored); anything else is a warning
 * (`invalid_area_flag`) and does not select.
 */
export function cleanAreaFlag(
  raw: string,
  name: string,
  at: CellAt,
): { selected: boolean; warnings: ImportWarning[] } {
  const text =
    raw
      .normalize("NFKC")
      .replace(AREA_CJK, " ")
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim().toLowerCase())
      .find((line) => line !== "") ?? "";
  if (AREA_YES.has(text)) return { selected: true, warnings: [] };
  if (AREA_NO.has(text)) return { selected: false, warnings: [] };
  return {
    selected: false,
    warnings: [
      importWarning("invalid_area_flag", {
        ...at,
        column: "areaFlag",
        detail: `Area "${name}": the cell says "${text.slice(0, 40)}"; use Yes or No. The area is not selected.`,
      }),
    ],
  };
}

/** One sheet row with every column cleaned; the input of grouping (T4). */
export interface CleanedRow {
  sheet: string;
  row: number;
  hidden: boolean;
  productNo: ProductNoResult;
  family: string | null;
  type: string | null;
  /** Null when empty; grouping reports `missing_model_no`. */
  modelNo: string | null;
  /** Not-applicable specs are left out (hidden on the product page). */
  specs: SpecValues;
  category: string | null;
  extraCategories: string[];
  areas: string[];
  /** Every cleaning warning of the row, the NO. error included. */
  warnings: ImportWarning[];
}

/**
 * Cleans every recognised column of one sheet row. The Image column's text
 * is ignored: pictures are read from the drawing anchors (T5).
 */
export function cleanRow(row: SheetRow): CleanedRow {
  const at: CellAt = { sheet: row.sheet, row: row.row };
  const { cells } = row;
  const warnings: ImportWarning[] = [];
  const take = <T>(result: { warnings: ImportWarning[] } & T): T => {
    warnings.push(...result.warnings);
    return result;
  };

  const productNo = cleanProductNo(cells.productNo, at);
  if (productNo.status === "invalid") warnings.push(productNo.warning);
  const family = take(cleanFamily(cells.family, at)).value;
  const type = take(cleanType(cells.type, at)).value;
  const modelNo = take(cleanModelNo(cells.modelNo, at)).value;

  const specs: SpecValues = {};
  for (const key of SPEC_KEYS) {
    const { values } = take(cleanSpecCell(key, cells[key], at));
    if (values !== null) specs[key] = values;
  }

  const areas = [...take(cleanNameList("areas", cells.areas, at)).values];
  for (const flag of row.areaFlags ?? []) {
    const { selected } = take(cleanAreaFlag(flag.text, flag.name, at));
    if (selected && !areas.includes(flag.name)) areas.push(flag.name);
  }

  return {
    sheet: row.sheet,
    row: row.row,
    hidden: row.hidden,
    productNo,
    family,
    type,
    modelNo,
    specs,
    category: take(cleanCategory(cells.category, at)).value,
    extraCategories: take(
      cleanNameList("extraCategories", cells.extraCategories, at),
    ).values,
    areas: areas,
    warnings,
  };
}
