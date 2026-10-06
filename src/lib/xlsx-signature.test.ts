// Tests for the .xlsx content check: a real workbook passes; a zip that is
// not a workbook, plain text, a truncated file, an oversized file and a zip
// with too many entries are all refused, whatever the file was named.

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { MAX_DATASHEET_BYTES, MAX_XLSX_ENTRIES } from "./constants";
import { checkXlsx } from "./xlsx-signature";

async function realWorkbook(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Specs");
  sheet.addRow(["NO.", "Model Name"]);
  sheet.addRow([1, "Arc"]);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

async function zipOf(
  files: Record<string, string>,
  compression: "DEFLATE" | "STORE" = "DEFLATE",
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array", compression });
}

const WORKBOOK_TYPES =
  '<?xml version="1.0"?><Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';

describe("checkXlsx", () => {
  it("accepts a workbook written by exceljs", async () => {
    expect(await checkXlsx(await realWorkbook())).toEqual({ ok: true });
  });

  it("accepts stored (uncompressed) parts too", async () => {
    const bytes = await zipOf(
      { "[Content_Types].xml": WORKBOOK_TYPES, "xl/workbook.xml": "<w/>" },
      "STORE",
    );
    expect(await checkXlsx(bytes)).toEqual({ ok: true });
  });

  it("refuses an empty file", async () => {
    expect(await checkXlsx(new Uint8Array(0))).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("refuses plain text renamed to .xlsx", async () => {
    const bytes = new TextEncoder().encode(
      "hello, this is not a workbook ".repeat(5),
    );
    expect(await checkXlsx(bytes)).toEqual({ ok: false, reason: "not_zip" });
  });

  it("refuses a zip that is not a workbook (renamed .zip)", async () => {
    const bytes = await zipOf({ "readme.txt": "just a zip" });
    expect(await checkXlsx(bytes)).toEqual({ ok: false, reason: "not_xlsx" });
  });

  it("refuses a zip with the parts but no workbook content type", async () => {
    const bytes = await zipOf({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml": "<w/>",
    });
    expect(await checkXlsx(bytes)).toEqual({ ok: false, reason: "not_xlsx" });
  });

  it("refuses a macro-enabled workbook (.xlsm)", async () => {
    const bytes = await zipOf({
      "[Content_Types].xml": WORKBOOK_TYPES.replace(
        "sheet.main+xml",
        "sheet.macroEnabled.main+xml",
      ),
      "xl/workbook.xml": "<w/>",
    });
    expect(await checkXlsx(bytes)).toEqual({ ok: false, reason: "not_xlsx" });
  });

  it("refuses a truncated zip", async () => {
    const whole = await realWorkbook();
    const cut = whole.subarray(0, Math.floor(whole.length / 2));
    expect(await checkXlsx(cut)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("refuses a file over the size limit", async () => {
    const big = new Uint8Array(MAX_DATASHEET_BYTES + 1);
    big.set([0x50, 0x4b, 0x03, 0x04]);
    expect(await checkXlsx(big)).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses a zip with too many entries, before reading them", async () => {
    const files: Record<string, string> = {
      "[Content_Types].xml": WORKBOOK_TYPES,
      "xl/workbook.xml": "<w/>",
    };
    for (let i = 0; i < MAX_XLSX_ENTRIES; i++) files[`f/${i}.txt`] = "";
    const bytes = await zipOf(files, "STORE");
    expect(await checkXlsx(bytes)).toEqual({
      ok: false,
      reason: "too_many_entries",
    });
  });

  it("refuses a content type part that inflates past the cap", async () => {
    const bomb = `${WORKBOOK_TYPES}${" ".repeat(3 * 1024 * 1024)}`;
    const bytes = await zipOf({
      "[Content_Types].xml": bomb,
      "xl/workbook.xml": "<w/>",
    });
    expect((await checkXlsx(bytes)).ok).toBe(false);
  });

  it("refuses a directory whose offsets point outside the file", async () => {
    const bytes = await realWorkbook();
    const broken = new Uint8Array(bytes);
    // Central directory offset field of the end record: past the end.
    const view = new DataView(broken.buffer);
    for (let i = broken.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        view.setUint32(i + 16, broken.length - 1, true);
        break;
      }
    }
    expect(await checkXlsx(broken)).toEqual({ ok: false, reason: "corrupt" });
  });
});
