// Reads the client's spec sheet with exceljs into raw rows (no cleaning; that
// is clean.ts). Call it only after safety.ts accepted the bytes. Formulas are
// never evaluated: only the result Excel cached in the file is used.
//
// Per sheet: find the header row, map headers to column keys (columns.ts),
// then turn every non-empty row below it into a SheetRow of raw strings keyed
// by column, with Excel's own row numbers. The loaded workbook is returned
// too, so the image stage (T5) reuses it instead of parsing the file again.

import "server-only";

import ExcelJS from "exceljs";

import { IMPORT_HEADER_SCAN_ROWS } from "@/lib/constants";

import { numberToText } from "./clean";
import { REQUIRED_COLUMNS, columnForHeader } from "./columns";
import {
  importWarning,
  type ColumnKey,
  type ImportWarning,
  type SheetRow,
  type WarningCode,
} from "./types";

/** One recognised column of a sheet's header row. */
export interface HeaderColumn {
  /** 1-based column number, as in Excel (A = 1). */
  column: number;
  key: ColumnKey;
  /** The header cell's text as typed (both lines). */
  header: string;
}

/** A sheet that has a header row and was read. */
export interface SheetHeader {
  name: string;
  /** exceljs worksheet id, for `workbook.getWorksheet(id)` in later stages. */
  worksheetId: number;
  headerRow: number;
  columns: HeaderColumn[];
}

export type WorkbookRead =
  | {
      ok: true;
      /** The parsed workbook, kept for the image stage (no second parse). */
      workbook: ExcelJS.Workbook;
      sheets: SheetHeader[];
      rows: SheetRow[];
      warnings: ImportWarning[];
    }
  | { ok: false; warnings: ImportWarning[] };

/* A header row needs a Model No. cell; failing that, this many known headers
 * (so a sheet missing Model No. is reported as such, not as "no header"). */
const MIN_KNOWN_HEADERS = 3;

/**
 * Loads the workbook and reads every sheet that has a header row. Fatal
 * problems (unreadable file, no header anywhere, a required column missing)
 * return `ok: false` with the warnings; nothing else is returned then.
 */
export async function readWorkbook(
  bytes: Buffer | Uint8Array,
): Promise<WorkbookRead> {
  const workbook = new ExcelJS.Workbook();
  try {
    const buffer = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // exceljs's types predate Node's generic Buffer; the runtime takes any Buffer.
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    return {
      ok: false,
      warnings: [
        importWarning("not_xlsx", {
          sheet: null,
          detail:
            "The workbook could not be read. Save it again in Excel and re-upload.",
        }),
      ],
    };
  }

  const warnings: ImportWarning[] = [];
  const sheets: SheetHeader[] = [];
  const rows: SheetRow[] = [];

  for (const worksheet of workbook.worksheets) {
    const header = findHeader(worksheet, warnings);
    if (!header) {
      warnings.push(
        importWarning("sheet_skipped", {
          sheet: worksheet.name,
          detail: `Sheet "${worksheet.name}" has no header row with a Model No. column in its first ${IMPORT_HEADER_SCAN_ROWS} rows, so it was not read.`,
        }),
      );
      continue;
    }
    if (worksheet.state !== "visible") {
      warnings.push(
        importWarning("hidden_sheet", {
          sheet: worksheet.name,
          detail: `Sheet "${worksheet.name}" is hidden in Excel but was imported.`,
        }),
      );
    }
    sheets.push(header);
    rows.push(...readRows(worksheet, header, warnings));
  }

  if (sheets.length === 0) {
    warnings.push(
      importWarning("no_header", {
        sheet: null,
        detail: `No sheet has a header row with "NO." and "Model No." columns in its first ${IMPORT_HEADER_SCAN_ROWS} rows.`,
      }),
    );
  }
  if (warnings.some((w) => w.severity === "fatal")) {
    return { ok: false, warnings };
  }
  return { ok: true, workbook, sheets, rows, warnings };
}

/*
 * The header row: the first of the top rows with a Model No. cell, or else
 * the first with several known headers. Maps its cells to keys and reports
 * unknown, duplicate and missing required columns.
 */
function findHeader(
  worksheet: ExcelJS.Worksheet,
  warnings: ImportWarning[],
): SheetHeader | null {
  const last = Math.min(IMPORT_HEADER_SCAN_ROWS, worksheet.rowCount);
  let fallback: number | null = null;
  let headerRow: number | null = null;
  for (let r = 1; r <= last; r++) {
    // findRow, not getRow: never create rows that are not in the file.
    const row = worksheet.findRow(r);
    if (!row) continue;
    const keys = headerKeys(row);
    if (keys.includes("modelNo")) {
      headerRow = r;
      break;
    }
    if (fallback === null && new Set(keys).size >= MIN_KNOWN_HEADERS) {
      fallback = r;
    }
  }
  headerRow ??= fallback;
  if (headerRow === null) return null;

  const sheet = worksheet.name;
  const columns: HeaderColumn[] = [];
  const seen = new Set<ColumnKey>();
  worksheet.getRow(headerRow).eachCell((cell, column) => {
    // A header merged across columns names one column, not several.
    if (isCoveredByMerge(cell)) return;
    const header = cellValue(cell).text ?? "";
    if (header.trim() === "") return;
    const key = columnForHeader(header);
    const label = `Column ${columnLetter(column)} "${firstLine(header)}"`;
    if (key === null) {
      warnings.push(
        importWarning("unknown_column", {
          sheet,
          row: headerRow,
          detail: `${label} is not a known column; its values are ignored.`,
        }),
      );
      return;
    }
    if (seen.has(key)) {
      warnings.push(
        importWarning("duplicate_column", {
          sheet,
          row: headerRow,
          column: key,
          detail: `${label} repeats an earlier column; only the first one is read.`,
        }),
      );
      return;
    }
    seen.add(key);
    columns.push({ column, key, header });
  });

  for (const key of REQUIRED_COLUMNS) {
    if (seen.has(key)) continue;
    warnings.push(
      importWarning("missing_required_column", {
        sheet,
        row: headerRow,
        column: key,
        detail: `Sheet "${sheet}" has no "${key === "productNo" ? "NO." : "Model No."}" column.`,
      }),
    );
  }
  return { name: sheet, worksheetId: worksheet.id, headerRow, columns };
}

function headerKeys(row: ExcelJS.Row): ColumnKey[] {
  const keys: ColumnKey[] = [];
  row.eachCell((cell) => {
    const key = columnForHeader(cellValue(cell).text ?? "");
    if (key !== null) keys.push(key);
  });
  return keys;
}

/*
 * Every row below the header with at least one non-blank recognised cell.
 * Fully empty rows (the client's spacer row 2) are skipped; they do not end
 * a product.
 *
 * Only rows and cells present in the file are visited (eachRow + findCell):
 * exceljs's rowCount is the LAST row number in the file, and one formatted
 * cell at row 1,000,000 would otherwise create a million rows in memory.
 * Cells covered by a merge exist (as merge cells), so they are still found.
 */
function readRows(
  worksheet: ExcelJS.Worksheet,
  header: SheetHeader,
  warnings: ImportWarning[],
): SheetRow[] {
  const rows: SheetRow[] = [];
  const sheet = header.name;
  worksheet.eachRow({ includeEmpty: false }, (row, r) => {
    if (r <= header.headerRow) return;
    const cells: SheetRow["cells"] = {};
    const rowWarnings: ImportWarning[] = [];
    for (const { column, key } of header.columns) {
      const cell = row.findCell(column);
      const { text, issue } = cell ? cellValue(cell, header.headerRow) : {};
      if (issue) {
        rowWarnings.push(
          importWarning(issue, {
            sheet,
            row: r,
            column: key,
            detail: ISSUE_DETAIL[issue](columnLetter(column) + r),
          }),
        );
      }
      if (text !== undefined && text.trim() !== "") cells[key] = text;
    }
    if (Object.keys(cells).length === 0) {
      // Skip the row, but say why if a cell could not be read.
      warnings.push(...rowWarnings);
      return;
    }
    const hidden = row.hidden === true;
    if (hidden) {
      rowWarnings.push(
        importWarning("hidden_row", {
          sheet,
          row: r,
          detail: `Row ${r} is hidden in Excel but was imported.`,
        }),
      );
    }
    warnings.push(...rowWarnings);
    rows.push({ sheet, row: r, hidden, cells });
  });
  return rows;
}

/* A cell inside a merged range other than its top-left (master) cell. */
function isCoveredByMerge(cell: ExcelJS.Cell): boolean {
  return cell.isMerged && cell.master.address !== cell.address;
}

type CellIssue = Extract<
  WarningCode,
  "date_cell" | "formula_without_result" | "cell_error"
>;

const ISSUE_DETAIL: Record<CellIssue, (ref: string) => string> = {
  date_cell: (ref) =>
    `Cell ${ref} is a date in Excel; it was read as an ISO date. Check the value (Excel turns "3/4" into a date).`,
  formula_without_result: (ref) =>
    `Cell ${ref} is a formula with no saved result; it was read as empty. Open and save the file in Excel first.`,
  cell_error: (ref) =>
    `Cell ${ref} holds an Excel error; it was read as empty.`,
};

interface CellText {
  text?: string;
  issue?: CellIssue;
}

/*
 * One cell as a raw string. A cell covered by a merge reads its master's
 * value, but only when that master lies below `aboveRow`: a header merged
 * down over row 2 must not turn row 2 into a data row. Formulas give their
 * cached result only.
 */
function cellValue(cell: ExcelJS.Cell, aboveRow = 0): CellText {
  const source = cell.isMerged && cell.master ? cell.master : cell;
  if (Number(source.row) <= aboveRow) return {};
  return valueText(source.value);
}

function valueText(value: ExcelJS.CellValue | undefined): CellText {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") return { text: value };
  if (typeof value === "number") return { text: numberToText(value) };
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE" };
  if (value instanceof Date) {
    const text = formatDate(value);
    return text === undefined ? {} : { text, issue: "date_cell" };
  }
  if ("richText" in value) {
    return { text: value.richText.map((run) => run.text).join("") };
  }
  if ("formula" in value || "sharedFormula" in value) {
    const result = (value as { result?: ExcelJS.CellValue }).result;
    if (result === undefined || result === null) {
      return { issue: "formula_without_result" };
    }
    return valueText(result);
  }
  if ("hyperlink" in value) {
    return valueText((value as ExcelJS.CellHyperlinkValue).text);
  }
  if ("error" in value) return { issue: "cell_error" };
  return {};
}

/* YYYY-MM-DD for a whole day (exceljs builds dates in UTC), else full ISO. */
function formatDate(date: Date): string | undefined {
  if (Number.isNaN(date.getTime())) return undefined;
  const iso = date.toISOString().replace(/\.000Z$/, "Z");
  return iso.endsWith("T00:00:00Z") ? iso.slice(0, 10) : iso;
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/, 1)[0] ?? "").trim();
}

/** 1 → "A", 27 → "AA". */
function columnLetter(column: number): string {
  let n = column;
  let letters = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}
