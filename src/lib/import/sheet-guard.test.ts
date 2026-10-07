// Tests for the sheet guard: the range records exceljs expands cell by cell
// on load are stripped (data validations, defined names) or bounded (merges,
// column ranges, sheet ids) before exceljs ever sees the XML.

import { describe, expect, it } from "vitest";

import {
  MAX_IMPORT_MERGED_CELLS,
  MAX_IMPORT_MERGES,
  MAX_IMPORT_SHEET_ID,
} from "@/lib/constants";

import { guardWorkbookXml, guardWorksheetXml } from "./sheet-guard";

const sheet = (inner: string) =>
  `<?xml version="1.0"?><worksheet xmlns="main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>${inner}</worksheet>`;

const book = (inner: string) =>
  `<?xml version="1.0"?><workbook xmlns="main"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>${inner}</workbook>`;

function okXml(result: ReturnType<typeof guardWorksheetXml>): string {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.xml;
}

describe("guardWorksheetXml", () => {
  it("returns a sheet without range records unchanged", () => {
    const xml = sheet(
      '<mergeCells count="1"><mergeCell ref="A1:AG1"/></mergeCells><cols><col min="1" max="16384" width="9"/></cols>',
    );
    expect(guardWorksheetXml(xml)).toEqual({ ok: true, xml, changed: false });
  });

  it("strips data validations, prefixed (x14) ones too, and nothing else", () => {
    const before = sheet("");
    const xml = before.replace(
      "</worksheet>",
      '<dataValidations count="2"><dataValidation type="list" sqref="C3:C1048576 E3:XFD1048576"><formula1>"a,b"</formula1></dataValidation></dataValidations>' +
        '<extLst><ext uri="x"><x14:dataValidations count="1"><x14:dataValidation><xm:sqref>A1:XFD1048576</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst></worksheet>',
    );
    const out = okXml(guardWorksheetXml(xml));
    expect(out).not.toMatch(/dataValidation/);
    expect(out).toBe(
      before.replace(
        "</worksheet>",
        '<extLst><ext uri="x"></ext></extLst></worksheet>',
      ),
    );
  });

  it("refuses text that joins into a new element once one is removed", () => {
    expect(
      guardWorksheetXml(
        sheet(
          '<dataVal<dataValidations/>idations count="1"><dataValidation type="list" sqref="A1:XFD1048576"/></dataValidations>',
        ),
      ),
    ).toEqual({ ok: false, reason: "corrupt" });
    expect(
      guardWorkbookXml(
        book(
          '<definedN<definedNames/>ames><definedName name="x">Sheet1!$A$1:$XFD$1048576</definedName></definedNames>',
        ),
      ),
    ).toEqual({ ok: false, reason: "corrupt" });
    // A joined merge or column tag is scanned too: the bounds run on the
    // text after stripping, so it is read like any other.
    expect(
      guardWorksheetXml(
        sheet(
          '<mergeCells><merge<dataValidations/>Cell ref="A1:XFD1048576"/></mergeCells>',
        ),
      ),
    ).toEqual({ ok: false, reason: "too_many_merged_cells" });
  });

  it("strips a self-closing data validations element", () => {
    const out = okXml(guardWorksheetXml(sheet('<dataValidations count="0"/>')));
    expect(out).toBe(sheet(""));
  });

  it("is not fooled by a '>' inside an attribute value", () => {
    const out = okXml(
      guardWorksheetXml(
        sheet(
          '<dataValidations note="a>b" count="1"><dataValidation sqref="A1:XFD1048576"/></dataValidations>',
        ),
      ),
    );
    expect(out).toBe(sheet(""));
  });

  it("refuses an unclosed data validations element", () => {
    expect(
      guardWorksheetXml(
        sheet('<dataValidations count="1"><dataValidation sqref="A1"/>'),
      ),
    ).toEqual({ ok: false, reason: "corrupt" });
  });

  it("accepts merges up to both caps and refuses past either", () => {
    const merges = (n: number) =>
      `<mergeCells>${Array.from({ length: n }, (_, i) => `<mergeCell ref="A${2 * i + 1}:A${2 * i + 2}"/>`).join("")}</mergeCells>`;
    expect(guardWorksheetXml(sheet(merges(MAX_IMPORT_MERGES))).ok).toBe(true);
    expect(guardWorksheetXml(sheet(merges(MAX_IMPORT_MERGES + 1)))).toEqual({
      ok: false,
      reason: "too_many_merged_cells",
    });
    // One merge covering more than the cell cap (here a full-width strip).
    const rows = Math.ceil(MAX_IMPORT_MERGED_CELLS / 16_384) + 1;
    expect(
      guardWorksheetXml(
        sheet(`<mergeCells><mergeCell ref="A1:XFD${rows}"/></mergeCells>`),
      ),
    ).toEqual({ ok: false, reason: "too_many_merged_cells" });
    expect(
      guardWorksheetXml(
        sheet('<mergeCells><mergeCell ref="AH20:XFD1048576"/></mergeCells>'),
      ),
    ).toEqual({ ok: false, reason: "too_many_merged_cells" });
  });

  it("reads merge refs in either order, with $ and single quotes", () => {
    expect(
      guardWorksheetXml(
        sheet("<mergeCells><mergeCell ref='$B$9:$A$1'/></mergeCells>"),
      ).ok,
    ).toBe(true);
  });

  it("refuses a merge ref outside Excel's grid or not a plain A1 range", () => {
    for (const ref of [
      "A1:XFE1",
      "A1:A1048577",
      "A0:B2",
      "&#65;1:B2",
      "A1:B2:C3",
      "",
      "Sheet1!A1:B2",
    ]) {
      expect(
        guardWorksheetXml(
          sheet(`<mergeCells><mergeCell ref="${ref}"/></mergeCells>`),
        ),
      ).toEqual({ ok: false, reason: "sheet_out_of_range" });
    }
    expect(
      guardWorksheetXml(sheet("<mergeCells><mergeCell/></mergeCells>")),
    ).toEqual({ ok: false, reason: "sheet_out_of_range" });
  });

  it("reads the real attribute, not a decoy inside another attribute's value", () => {
    // XML names may be non-ASCII: a reader that skipped "é" would
    // start inside its value and take ref='A1' for the merge's ref.
    expect(
      guardWorksheetXml(
        sheet(
          `<mergeCells><mergeCell é="ref='A1'" ref="A1:XFD1048576"/></mergeCells>`,
        ),
      ),
    ).toEqual({ ok: false, reason: "too_many_merged_cells" });
    expect(
      guardWorksheetXml(
        sheet(`<cols><col é="max='1'" max="999999999"/></cols>`),
      ),
    ).toEqual({ ok: false, reason: "sheet_out_of_range" });
    expect(
      guardWorkbookXml(
        book("").replace('sheetId="1"', `é="sheetId='1'" sheetId="999999999"`),
      ),
    ).toEqual({ ok: false, reason: "sheet_out_of_range" });
  });

  it("bounds prefixed merge and column tags too (a superset of exceljs)", () => {
    expect(
      guardWorksheetXml(
        sheet(
          '<x:mergeCells><x:mergeCell ref="A1:XFD1048576"/></x:mergeCells>',
        ),
      ),
    ).toEqual({ ok: false, reason: "too_many_merged_cells" });
    expect(
      guardWorksheetXml(sheet('<x:cols><x:col min="1" max="16385"/></x:cols>')),
    ).toEqual({ ok: false, reason: "sheet_out_of_range" });
  });

  it("refuses a tag whose attributes are not plain name=value pairs", () => {
    for (const fragment of [
      '<mergeCells><mergeCell ref="A1" ref="A1:XFD1048576"/></mergeCells>',
      '<mergeCells><mergeCell bogus ref="A1"/></mergeCells>',
      '<mergeCells><mergeCell ref="A1<"/></mergeCells>',
      "<mergeCells><mergeCell ref=A1:XFD1048576/></mergeCells>",
    ]) {
      expect(guardWorksheetXml(sheet(fragment))).toEqual({
        ok: false,
        reason: "corrupt",
      });
    }
  });

  it("refuses a column range past column XFD (exceljs builds every column)", () => {
    for (const col of [
      '<col min="40" max="10000000"/>',
      '<col min="2000000000" max="1"/>',
      '<col min="1" max="1e9"/>',
      '<col min="1" max=" 16385"/>',
    ]) {
      expect(guardWorksheetXml(sheet(`<cols>${col}</cols>`))).toEqual({
        ok: false,
        reason: "sheet_out_of_range",
      });
    }
  });

  it("stays linear on a large sheet full of near-miss tags", () => {
    const filler = "<colx/><mergeCellsX/><dataValidationsX/>".repeat(100_000);
    const start = performance.now();
    expect(guardWorksheetXml(sheet(filler)).ok).toBe(true);
    expect(performance.now() - start).toBeLessThan(3_000);
  });

  it("stays linear when tag names repeat inside one tag or a comment", () => {
    for (const inner of [
      `<cols><col width="${"&lt;col ".repeat(200_000)}"/></cols>`,
      `<!--${'<col a="1" '.repeat(200_000)}-->`,
      `<!--${'<mergeCell ref="'.repeat(200_000)}-->`,
    ]) {
      const start = performance.now();
      guardWorksheetXml(sheet(inner));
      expect(performance.now() - start).toBeLessThan(3_000);
    }
  });
});

describe("guardWorkbookXml", () => {
  it("refuses an unclosed defined names element", () => {
    expect(
      guardWorkbookXml(book('<definedNames><definedName name="x">A1')),
    ).toEqual({ ok: false, reason: "corrupt" });
  });

  it("returns a workbook without defined names unchanged", () => {
    const xml = book("");
    expect(guardWorkbookXml(xml)).toEqual({ ok: true, xml, changed: false });
  });

  it("strips defined names (print areas and named ranges included)", () => {
    const out = guardWorkbookXml(
      book(
        '<definedNames><definedName name="x">Sheet1!$A$1:$XFD$1048576</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">Sheet1!$A$1:$AG$14</definedName></definedNames><calcPr calcId="1"/>',
      ),
    );
    expect(out).toEqual({
      ok: true,
      xml: book('<calcPr calcId="1"/>'),
      changed: true,
    });
  });

  it("refuses a sheet id exceljs would turn into a huge sparse array", () => {
    const at = (id: string) =>
      guardWorkbookXml(book("").replace('sheetId="1"', `sheetId="${id}"`));
    expect(at(String(MAX_IMPORT_SHEET_ID)).ok).toBe(true);
    for (const id of [
      String(MAX_IMPORT_SHEET_ID + 1),
      "200000000",
      "1e9",
      "&#49;0",
    ]) {
      expect(at(id)).toEqual({ ok: false, reason: "sheet_out_of_range" });
    }
  });
});
