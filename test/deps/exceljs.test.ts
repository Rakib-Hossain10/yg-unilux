import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

// Guards the `uuid` override in package.json: exceljs calls uuid's v4() when it
// writes an x14 extension conditional-format rule (dataBar), so this round trip
// fails if the overridden uuid version is incompatible.

const GUID =
  /\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}/;

async function buildWorkbook(): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Specs");
  sheet.addRow(["Model No.", "Wattage"]);
  sheet.addRow(["AR-013A1", 7]);
  sheet.addRow(["AR-013A2", 12]);
  const dataBar: ExcelJS.DataBarRuleType = {
    type: "dataBar",
    priority: 1,
    cfvo: [{ type: "min" }, { type: "max" }],
    color: { argb: "FF638EC6" },
  } as ExcelJS.DataBarRuleType;
  sheet.addConditionalFormatting({ ref: "B2:B3", rules: [dataBar] });
  return workbook.xlsx.writeBuffer();
}

async function sheetXml(file: ExcelJS.Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(file);
  const xml = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
  if (xml === undefined) throw new Error("sheet1.xml missing from workbook");
  return xml;
}

describe("exceljs round trip", () => {
  it("writes a dataBar rule with a uuid v4 based x14 id", async () => {
    const xml = await sheetXml(await buildWorkbook());
    expect(xml).toContain("x14:dataBar");
    expect(xml).toMatch(GUID);
  });

  it("reads the workbook back and re-writes the rule", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildWorkbook());
    const sheet = workbook.getWorksheet("Specs");
    expect(sheet?.getCell("A2").value).toBe("AR-013A1");
    expect(sheet?.getCell("B3").value).toBe(12);

    // exceljs keeps the rule and its x14 id on reload but drops the
    // x14:dataBar extension block, so assert only what it preserves.
    const xml = await sheetXml(await workbook.xlsx.writeBuffer());
    expect(xml).toContain('<cfRule type="dataBar"');
    expect(xml).toMatch(GUID);
  });
});
