// Tests for the workbook reader on the synthetic client sheet and its
// variants: header detection with the real quirks, blank rows, merged cells,
// rich text, number cells, cached formulas, dates, hyperlinks, several
// sheets, unknown/missing columns and sheets with no header at all.

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { SPEC_KEYS } from "@/models/spec-columns";

import {
  FIXTURE_DATA_ROWS,
  buildFixture,
} from "../../../test/fixtures/import/build";
import type { ImportWarning, SheetRow } from "./types";
import { readWorkbook, type WorkbookRead } from "./workbook";

type Read = Extract<WorkbookRead, { ok: true }>;

async function read(bytes: Buffer): Promise<Read> {
  const result = await readWorkbook(bytes);
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.warnings)}`);
  }
  return result;
}

function rowAt(result: Read, row: number, sheet = "Sheet1"): SheetRow {
  const found = result.rows.find((r) => r.row === row && r.sheet === sheet);
  if (!found) throw new Error(`no row ${row} on ${sheet}`);
  return found;
}

function codes(warnings: ImportWarning[]): string[] {
  return warnings.map((w) => w.code);
}

/** A one-sheet workbook from plain rows (row 1 first). */
async function tiny(
  rows: ExcelJS.CellValue[][],
  sheetName = "Sheet1",
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  rows.forEach((cells, r) =>
    cells.forEach((value, c) => {
      if (value !== null && value !== undefined) {
        sheet.getCell(r + 1, c + 1).value = value;
      }
    }),
  );
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("readWorkbook on the synthetic client sheet", () => {
  it("finds the row-1 header and maps all 33 columns despite the quirks", async () => {
    const result = await read(await buildFixture());
    expect(result.sheets).toHaveLength(1);
    const [sheet] = result.sheets;
    expect(sheet?.name).toBe("Sheet1");
    expect(sheet?.headerRow).toBe(1);
    const keys = sheet?.columns.map((c) => c.key) ?? [];
    expect(keys).toHaveLength(33);
    expect(keys).toEqual(
      expect.arrayContaining([
        "productNo",
        "family",
        "type",
        "modelNo",
        "image",
        ...SPEC_KEYS,
      ]),
    );
    // HOLDER (col 17), Voltage INPUT (24), LUMEN Output (26).
    expect(sheet?.columns.find((c) => c.column === 17)?.key).toBe("holder");
    expect(sheet?.columns.find((c) => c.column === 24)?.key).toBe(
      "voltageInput",
    );
    expect(sheet?.columns.find((c) => c.column === 26)?.key).toBe(
      "lumenOutput",
    );
    expect(result.warnings).toEqual([]);
  });

  it("skips the blank row 2 and keeps Excel's row numbers", async () => {
    const result = await read(await buildFixture());
    expect(result.rows.map((r) => r.row)).toEqual(FIXTURE_DATA_ROWS);
    expect(result.rows.every((r) => r.sheet === "Sheet1")).toBe(true);
  });

  it("returns raw strings: rich text flattened, nothing cleaned yet", async () => {
    const result = await read(await buildFixture());
    const first = rowAt(result, 3);
    expect(first.cells.housingMaterial).toBe(
      "Die Casting\nAluminium + PC\n\n压铸铝 + PC ",
    );
    expect(first.cells.housingFinish).toBe("White/Black\n\n白色/黑色");
    expect(first.cells.driver).toBe("Lifud 莱福德");
    expect(first.cells.cct).toBe("3000K\n4000K");
    expect(first.cells.lifespan).toBe("50,000 hrs ");
    expect(first.cells.modelNo).toBe("AR-013A1");
    expect(first.cells.reflector).toBe("-");
  });

  it("turns number cells into plain decimal strings", async () => {
    const result = await read(await buildFixture());
    expect(rowAt(result, 3).cells.productNo).toBe("76");
    expect(rowAt(result, 3).cells.powerFactor).toBe("0.9");
  });

  it("leaves blank cells out (a continuation row has no NO.)", async () => {
    const result = await read(await buildFixture());
    const second = rowAt(result, 4);
    expect(second.cells.productNo).toBeUndefined();
    expect(second.cells.modelNo).toBe("AR-013A2");
    // Nos. 80/81: no Model No., continuation row holds only the family.
    expect(rowAt(result, 11).cells.modelNo).toBeUndefined();
    expect(rowAt(result, 12).cells).toEqual({ family: "Arc" });
  });

  it("keeps a handle on the loaded workbook for the image stage", async () => {
    const result = await read(await buildFixture());
    expect(result.workbook).toBeInstanceOf(ExcelJS.Workbook);
    const worksheet = result.workbook.getWorksheet(
      result.sheets[0]?.worksheetId ?? -1,
    );
    expect(worksheet?.getImages()).toHaveLength(12);
  });
});

describe("readWorkbook cell values", () => {
  it("copies a merged cell's value to every cell it covers", async () => {
    const result = await read(await buildFixture({ merged: true }));
    expect(rowAt(result, 4).cells.productNo).toBe("76");
    for (let row = 3; row <= 10; row++) {
      expect(rowAt(result, row).cells.family).toBe("Arc");
    }
  });

  it("uses a formula's cached result and never evaluates it", async () => {
    const result = await read(await buildFixture({ formula: true }));
    expect(rowAt(result, 3).cells.wattage).toBe("12W");
    expect(result.warnings).toEqual([]);
  });

  it("treats a formula with no cached result as empty, with a warning", async () => {
    const result = await read(
      await buildFixture({ formulaWithoutResult: true }),
    );
    expect(rowAt(result, 5).cells.wattage).toBeUndefined();
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "formula_without_result",
        severity: "warning",
        sheet: "Sheet1",
        row: 5,
        column: "wattage",
      }),
    );
  });

  it("writes a date cell as an ISO date, with a warning", async () => {
    const result = await read(await buildFixture({ dateCell: true }));
    expect(rowAt(result, 5).cells.cutOutSize).toBe("2026-03-04");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "date_cell",
        row: 5,
        column: "cutOutSize",
      }),
    );
  });

  it("uses a hyperlink's text, not its address", async () => {
    const result = await read(await buildFixture({ hyperlink: true }));
    expect(rowAt(result, 3).cells.lumenOutput).toBe("1140 LM");
  });

  it("formats numbers without float noise or exponents", async () => {
    const bytes = await tiny([
      ["NO.", "Model No.", "Power Factor", "Wattage", "Lumen Output"],
      [1, "X-1", 0.1 + 0.2, 1e21, 0.0000001],
      [2, "X-2", -0, 12.5, true],
    ]);
    const result = await read(bytes);
    expect(rowAt(result, 2).cells).toMatchObject({
      powerFactor: "0.3",
      wattage: "1000000000000000000000",
      lumenOutput: "0.0000001",
    });
    expect(rowAt(result, 3).cells).toMatchObject({
      powerFactor: "0",
      wattage: "12.5",
      lumenOutput: "TRUE",
    });
  });

  it("treats an error cell as empty, with a warning", async () => {
    const bytes = await tiny([
      ["NO.", "Model No.", "CRI"],
      [1, "X-1", { error: "#N/A" } as ExcelJS.CellErrorValue],
    ]);
    const result = await read(bytes);
    expect(rowAt(result, 2).cells.cri).toBeUndefined();
    expect(codes(result.warnings)).toContain("cell_error");
  });

  it("reads hidden rows but notes them", async () => {
    const result = await read(await buildFixture({ hiddenRow: true }));
    expect(rowAt(result, 6).hidden).toBe(true);
    expect(rowAt(result, 5).hidden).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "hidden_row", row: 6 }),
    );
  });
});

describe("readWorkbook headers and sheets", () => {
  it("finds a header that is not on row 1 (title rows above it)", async () => {
    const bytes = await tiny([
      ["YG UniLUX product list"],
      [],
      ["NO.", "Model No.\n型号", "CCT\n色温"],
      [5, "Y-1", "3000K"],
    ]);
    const result = await read(bytes);
    expect(result.sheets[0]?.headerRow).toBe(3);
    expect(result.rows).toEqual([
      {
        sheet: "Sheet1",
        row: 4,
        hidden: false,
        cells: { productNo: "5", modelNo: "Y-1", cct: "3000K" },
      },
    ]);
  });

  it("warns about an unknown column and ignores its values", async () => {
    const result = await read(await buildFixture({ unknownColumn: true }));
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "unknown_column",
        severity: "warning",
        sheet: "Sheet1",
        row: 1,
        detail: expect.stringContaining("Remarks"),
      }),
    ]);
    expect(Object.values(rowAt(result, 3).cells)).not.toContain("Sample note");
  });

  it("uses the first of two columns with the same header, with a warning", async () => {
    const bytes = await tiny([
      ["NO.", "Model No.", "CCT", "CCT\n色温"],
      [1, "X-1", "3000K", "4000K"],
    ]);
    const result = await read(bytes);
    expect(rowAt(result, 2).cells.cct).toBe("3000K");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "duplicate_column", column: "cct" }),
    );
  });

  it("reads every sheet with a header and reports the others as skipped", async () => {
    const result = await read(await buildFixture({ secondSheet: true }));
    expect(result.sheets.map((s) => s.name)).toEqual(["Sheet1", "Sheet2"]);
    expect(rowAt(result, 2, "Sheet2").cells.productNo).toBe("82");
    expect(result.rows.filter((r) => r.sheet === "Sheet2")).toHaveLength(2);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "sheet_skipped", sheet: "Notes" }),
    ]);
  });

  it("refuses a sheet without a NO. column (fatal)", async () => {
    const result = await readWorkbook(
      await buildFixture({ missingColumn: "productNo" }),
    );
    expect(result.ok).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "missing_required_column",
        severity: "fatal",
        sheet: "Sheet1",
        column: "productNo",
      }),
    );
  });

  it("refuses a sheet whose header has no Model No. column (fatal)", async () => {
    const result = await readWorkbook(
      await buildFixture({ missingColumn: "modelNo" }),
    );
    expect(result.ok).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "missing_required_column",
        severity: "fatal",
        column: "modelNo",
      }),
    );
  });

  it("refuses a workbook where no sheet has a header (fatal)", async () => {
    const bytes = await tiny([["Price list"], ["Lamp", 12]]);
    const result = await readWorkbook(bytes);
    expect(result.ok).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "no_header",
        severity: "fatal",
        sheet: null,
      }),
    );
  });

  it("finds a header on row 15, the last row searched", async () => {
    const rows: ExcelJS.CellValue[][] = Array.from({ length: 14 }, () => [
      "notes",
    ]);
    rows.push(["NO.", "Model No."], [1, "X-1"]);
    expect((await read(await tiny(rows))).sheets[0]?.headerRow).toBe(15);
  });

  it("does not take a sheet with one stray known header for a data sheet", async () => {
    const workbook = new ExcelJS.Workbook();
    const data = workbook.addWorksheet("Sheet1");
    data.addRow(["NO.", "Model No."]);
    data.addRow([1, "X-1"]);
    const notes = workbook.addWorksheet("Notes");
    notes.addRow(["CCT", "means colour temperature"]);
    const result = await read(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(result.sheets.map((s) => s.name)).toEqual(["Sheet1"]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "sheet_skipped", sheet: "Notes" }),
    ]);
  });

  it("reads a hidden sheet but notes it", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Old list", { state: "veryHidden" });
    sheet.addRow(["NO.", "Model No."]);
    sheet.addRow([1, "X-1"]);
    const result = await read(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(result.rows).toHaveLength(1);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "hidden_sheet", sheet: "Old list" }),
    ]);
  });

  it("does not read a header merged down into row 2 as data", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.getCell("A1").value = "NO.\n序号";
    sheet.getCell("B1").value = "Model No.\n型号";
    sheet.mergeCells("A1:A2");
    sheet.mergeCells("B1:B2");
    sheet.getCell("A3").value = 1;
    sheet.getCell("B3").value = "X-1";
    const result = await read(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(result.rows.map((r) => r.row)).toEqual([3]);
  });

  it("keeps the warnings of a row that ends up empty", async () => {
    const bytes = await tiny([
      ["NO.", "Model No."],
      [{ formula: "1+1" } as ExcelJS.CellFormulaValue, null],
    ]);
    const result = await read(bytes);
    expect(result.rows).toEqual([]);
    expect(codes(result.warnings)).toContain("formula_without_result");
  });

  it("does not call a header merged across columns a duplicate", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["NO.", "Model No.", "CCT", null]);
    sheet.mergeCells(1, 3, 1, 4);
    sheet.addRow([1, "X-1", "3000K", null]);
    const result = await read(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(result.warnings).toEqual([]);
    expect(result.rows[0]?.cells.cct).toBe("3000K");
  });

  it("does not walk the empty used range below the data (row 1,000,000)", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["NO.", "Model No."]);
    sheet.addRow([1, "X-1"]);
    // A formatted row and cell far below, no values: exceljs's rowCount
    // becomes 1,000,000 (a naive row loop runs out of memory here).
    sheet.getRow(1_000_000).height = 30;
    sheet.getCell(1_000_000, 1).style = { font: { bold: true } };
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const started = performance.now();
    const result = await read(bytes);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.rows.map((r) => r.row)).toEqual([2]);
  });

  it("only searches the first 15 rows for the header", async () => {
    const rows: ExcelJS.CellValue[][] = Array.from({ length: 15 }, () => [
      "notes",
    ]);
    rows.push(["NO.", "Model No."], [1, "X-1"]);
    const result = await readWorkbook(await tiny(rows));
    expect(result.ok).toBe(false);
    expect(codes(result.warnings)).toContain("no_header");
  });

  it("refuses bytes exceljs cannot read (fatal, no throw)", async () => {
    const result = await readWorkbook(Buffer.from("not a workbook"));
    expect(result.ok).toBe(false);
    expect(result.warnings[0]).toMatchObject({
      code: "not_xlsx",
      severity: "fatal",
    });
  });
});
