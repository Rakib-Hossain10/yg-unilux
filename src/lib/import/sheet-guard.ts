// Bounds the range records exceljs expands cell by cell when it loads a
// workbook (Phase 3 QA gate A, M-1). Run by safety.ts on the workbook part
// and every worksheet part, after the zip checks and BEFORE exceljs sees the
// bytes. Pure: XML text in, XML text (or a refusal) out.
//
// What exceljs 4.4 does with a range on load, and what this guard does:
// - <dataValidation sqref>: one entry per covered cell (parseClose →
//   Range.forEachAddress). The import never reads validations, so the whole
//   <dataValidations> element is stripped (x14 extension copies too). An
//   honest whole-column dropdown therefore costs nothing.
// - <definedName> (named ranges, print areas and titles): one matrix entry per
//   covered cell (DefinedNames.addEx). Never read either: <definedNames> is
//   stripped from the workbook part.
// - <mergeCell ref>: a cell object for every covered cell, and every new merge
//   is checked against all earlier ones (O(merges^2)). The reader needs
//   merges (a merged NO. cell), so they are kept but capped: at most
//   MAX_IMPORT_MERGES ranges covering at most MAX_IMPORT_MERGED_CELLS cells.
// - <col min max>: one Column object per column from 1 to max
//   (Column.fromModel). Excel's grid ends at column 16384 (XFD), so a value
//   past it is refused.
// - <sheet sheetId>: used as an array index that exceljs walks in full
//   (Workbook.worksheets → filter over a sparse array). Capped at
//   MAX_IMPORT_SHEET_ID.
// Safe as they are (stored as strings or looked up per cell, never
// expanded): conditional formatting sqref, autoFilter ref, hyperlink ref,
// table ref, shared and array formula ref, selection sqref, dimension ref,
// row and cell numbers (a sparse array of present rows only).
//
// The scan is linear and never builds a tree: worksheets can be large. It
// matches tag names literally, as exceljs does (saxes without namespaces,
// exact names): anything exceljs treats as one of these elements has that
// literal name. Attribute values are read strictly (plain digits / A1 refs);
// an encoded or unusual value is refused rather than interpreted, so the
// guard can never read a smaller range than exceljs would.

import {
  MAX_IMPORT_MERGED_CELLS,
  MAX_IMPORT_MERGES,
  MAX_IMPORT_SHEET_ID,
} from "@/lib/constants";

export type SheetGuardRejection =
  "too_many_merged_cells" | "sheet_out_of_range" | "corrupt";

export type GuardedXml =
  | { ok: true; xml: string; changed: boolean }
  | { ok: false; reason: SheetGuardRejection };

/** Excel's grid: XFD1048576. */
const EXCEL_MAX_ROW = 1_048_576;
const EXCEL_MAX_COLUMN = 16_384;

/**
 * A worksheet part: strips <dataValidations>, then bounds every <mergeCell>
 * and <col>. `changed` is false when the text is returned as it came.
 */
export function guardWorksheetXml(xml: string): GuardedXml {
  const stripped = stripElements(xml, "dataValidations");
  if (stripped === null) return { ok: false, reason: "corrupt" };

  let merges = 0;
  let mergedCells = 0;
  for (const tag of tags(
    stripped,
    /<(?:[A-Za-z_][\w.-]*:)?(mergeCell|col)(?=[\s/>])/g,
  )) {
    if (tag === null) return { ok: false, reason: "corrupt" };
    if (tag.name === "col") {
      for (const key of ["min", "max"]) {
        const value = tag.attributes.get(key);
        if (value === undefined) continue;
        const n = plainInteger(value);
        if (n === null || n > EXCEL_MAX_COLUMN) {
          return { ok: false, reason: "sheet_out_of_range" };
        }
      }
      continue;
    }
    const area = rangeArea(tag.attributes.get("ref"));
    if (area === null) return { ok: false, reason: "sheet_out_of_range" };
    merges += 1;
    mergedCells += area;
    if (merges > MAX_IMPORT_MERGES || mergedCells > MAX_IMPORT_MERGED_CELLS) {
      return { ok: false, reason: "too_many_merged_cells" };
    }
  }
  return { ok: true, xml: stripped, changed: stripped !== xml };
}

/** The workbook part: strips <definedNames> and bounds every sheetId. */
export function guardWorkbookXml(xml: string): GuardedXml {
  const stripped = stripElements(xml, "definedNames");
  if (stripped === null) return { ok: false, reason: "corrupt" };
  for (const tag of tags(
    stripped,
    /<(?:[A-Za-z_][\w.-]*:)?(sheet)(?=[\s/>])/g,
  )) {
    if (tag === null) return { ok: false, reason: "corrupt" };
    const value = tag.attributes.get("sheetId");
    if (value === undefined) continue;
    const id = plainInteger(value);
    if (id === null || id > MAX_IMPORT_SHEET_ID) {
      return { ok: false, reason: "sheet_out_of_range" };
    }
  }
  return { ok: true, xml: stripped, changed: stripped !== xml };
}

/* ------------------------------------------------------------------------ */

interface Tag {
  /** The local name matched by the pattern's first group. */
  name: string;
  attributes: Map<string, string>;
}

/*
 * Every start tag the (global) pattern finds, with its attributes; null
 * (then stop) when a tag never ends. The search resumes after each tag's ">",
 * so text inside one tag's attribute values is never scanned again: each
 * character is read a bounded number of times.
 */
function* tags(xml: string, pattern: RegExp): Generator<Tag | null> {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const end = endOfTag(xml, match.index);
    if (end === -1) {
      yield null;
      return;
    }
    pattern.lastIndex = end + 1;
    const attributes = attributesOf(
      xml.slice(match.index + match[0].length, end + 1),
    );
    if (attributes === null) {
      yield null;
      return;
    }
    yield { name: match[1] ?? "", attributes };
  }
}

/* The index of the ">" closing the tag that starts at `start`, skipping
 * quoted attribute values (a ">" is legal inside them); -1 if none, or if a
 * value holds a raw "<" (not well-formed XML: exceljs would refuse it too). */
function endOfTag(xml: string, start: number): number {
  let quote = "";
  for (let i = start + 1; i < xml.length; i++) {
    const ch = xml[i];
    if (quote !== "") {
      if (ch === quote) quote = "";
      else if (ch === "<") return -1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

/*
 * The attributes of one start tag, read in order from just after its name
 * (`rest` runs from there to the ">"): name → raw value, entities NOT
 * decoded (the strict value parsers refuse them). null when the rest is not
 * a plain sequence of name="value" pairs ending in ">" or "/>", or a name
 * repeats: a reader that skipped ahead could take a decoy inside another
 * attribute's value (`é="ref='A1'"`) for the real one.
 */
function attributesOf(rest: string): Map<string, string> | null {
  const attributes = new Map<string, string>();
  const pair = /\s+([^\s=/>"'<]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = pair.exec(rest)) !== null) {
    const name = m[1] as string;
    if (attributes.has(name)) return null;
    attributes.set(name, m[2] ?? m[3] ?? "");
    at = pair.lastIndex;
  }
  return /^\s*\/?>$/.test(rest.slice(at)) ? attributes : null;
}

/*
 * Removes every element with this local name (any prefix), self-closing or
 * up to its matching close tag. Elements of the same name do not nest in
 * SpreadsheetML; a nested copy leaves a stray close tag, which makes the
 * part malformed, and exceljs then refuses the whole file. null = an
 * element that never ends, or a removal that joined the text around it into
 * a new element of the same name.
 */
function stripElements(xml: string, local: string): string | null {
  const open = new RegExp(`<((?:[A-Za-z_][\\w.-]*:)?)${local}(?=[\\s/>])`, "g");
  const kept: string[] = [];
  let from = 0;
  let match: RegExpExecArray | null;
  while ((match = open.exec(xml)) !== null) {
    const tagEnd = endOfTag(xml, match.index);
    if (tagEnd === -1) return null;
    let end: number;
    if (xml[tagEnd - 1] === "/") {
      end = tagEnd + 1;
    } else {
      const close = closeTag(xml, `</${match[1] ?? ""}${local}`, tagEnd + 1);
      if (close === -1) return null;
      end = close;
    }
    kept.push(xml.slice(from, match.index));
    from = end;
    open.lastIndex = end;
  }
  if (from === 0) return xml;
  kept.push(xml.slice(from));
  const result = kept.join("");
  // The text around a removed element can join into a new opening tag
  // ("<dataVal" + "idations ..."). Such a file is crafted: refuse it rather
  // than strip again, so what reaches exceljs never holds this element.
  open.lastIndex = 0;
  return open.test(result) ? null : result;
}

/* The index just past `</name>` (optional spaces before ">"), searching
 * from `from`; -1 if there is none. */
function closeTag(xml: string, prefix: string, from: number): number {
  let at = xml.indexOf(prefix, from);
  while (at !== -1) {
    let i = at + prefix.length;
    while (i < xml.length && /\s/.test(xml[i] as string)) i++;
    if (xml[i] === ">") return i + 1;
    at = xml.indexOf(prefix, at + 1);
  }
  return -1;
}

/* A plain decimal integer (up to 9 digits), else null. */
function plainInteger(value: string): number | null {
  return /^\d{1,9}$/.test(value) ? Number(value) : null;
}

/* The number of cells of an "A1" or "A1:B2" ref inside Excel's grid, else
 * null. Either corner order and "$" are accepted, as exceljs accepts them. */
function rangeArea(ref: string | undefined): number | null {
  if (ref === undefined) return null;
  const m =
    /^\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?$/i.exec(ref);
  if (!m) return null;
  const c1 = columnNumber(m[1] as string);
  const r1 = Number(m[2]);
  const c2 = m[3] === undefined ? c1 : columnNumber(m[3]);
  const r2 = m[4] === undefined ? r1 : Number(m[4]);
  for (const [n, max] of [
    [c1, EXCEL_MAX_COLUMN],
    [c2, EXCEL_MAX_COLUMN],
    [r1, EXCEL_MAX_ROW],
    [r2, EXCEL_MAX_ROW],
  ] as const) {
    if (n < 1 || n > max) return null;
  }
  return (Math.abs(r2 - r1) + 1) * (Math.abs(c2 - c1) + 1);
}

/* "A" → 1, "XFD" → 16384. */
function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
