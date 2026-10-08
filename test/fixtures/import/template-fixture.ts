// Test helper: fills a generated import template the way the client would
// (typed rows, one picture per row, dropdown values) and returns the .xlsx.
// Lookups below are the category tree and areas the tests generate it with.

import ExcelJS from "exceljs";

import type { AreaLookup, CategoryLookup } from "@/lib/import/group";
import { buildImportTemplate } from "@/lib/import/template";

import { fixturePictures } from "./build";

export const TEMPLATE_CATEGORIES: readonly CategoryLookup[] = [
  { id: "c-spot", name: "Spot Lights", slug: "spot-lights", parentId: null },
  { id: "c-spot-rec", name: "Recessed", slug: "recessed", parentId: "c-spot" },
  {
    id: "c-rec",
    name: "Recessed Lights",
    slug: "recessed-lights",
    parentId: null,
  },
  { id: "c-rec-spot", name: "Spot", slug: "spot", parentId: "c-rec" },
];

export const TEMPLATE_AREAS: readonly AreaLookup[] = [
  { id: "a-res", name: "Residential", slug: "residential" },
  { id: "a-ret", name: "Retail", slug: "retail" },
  { id: "a-hos", name: "Hospitality", slug: "hospitality" },
];

export const TEMPLATE_INPUT = {
  categories: TEMPLATE_CATEGORIES,
  areas: TEMPLATE_AREAS,
};

/** One data row as header text -> cell value ("Image" is never a value). */
export type TemplateRow = Record<string, ExcelJS.CellValue>;

const SPECS = {
  "Housing Material": "Die Casting Aluminium",
  "Housing Color/Finish": "White/Black",
  "Chip Type": "COB",
  CCT: "3000K\n4000K",
  CRI: ">90",
  "Beam Angle": "20°\n30°",
  Driver: "Lifud",
  "Voltage INPUT": "AC220-240V",
  Wattage: "12W",
  "IP Rating": "IP20",
};

/** The 1-based column of a header, matched case-insensitively. */
function columnOf(headers: readonly string[], header: string): number {
  const at = headers.findIndex((h) => h.toLowerCase() === header.toLowerCase());
  if (at === -1) throw new Error(`template has no column "${header}"`);
  return at + 1;
}

/** The golden fill: Arc No. 76 (2 variants), No. 77, and No. 78 with NO. repeated. */
export function goldenTemplateRows(): { row: TemplateRow; picture: number }[] {
  const arc = (variant: 0 | 1): TemplateRow => ({
    ...(variant === 0 ? { "NO.": 76 } : {}),
    "Model Name": "Arc",
    "Model Type": "Pull-Down Spot Light",
    "Model No.": `AR-013A${variant + 1}`,
    ...SPECS,
    Lens: variant === 0 ? "Regular Lens" : "-",
    Reflector: variant === 0 ? "-" : "High Efficiency Reflector",
    "Lumen Output": variant === 0 ? "1140 LM" : "1200 LM",
    "Lumen Efficiency": variant === 0 ? "95" : "100",
    Category: "Spot Lights > Recessed",
    "Extra Category 1": "Recessed Lights > Spot",
    "Area: Residential": "Yes",
    "Area: Retail": "Yes",
    "Area: Hospitality": "No",
  });
  const single = (no: number, model: string): TemplateRow => ({
    "NO.": no,
    "Model Name": "Beam",
    "Model Type": "Track Spot",
    "Model No.": model,
    ...SPECS,
    "Lumen Output": "900 LM",
    Category: "Recessed Lights",
    "Area: Retail": "Yes",
  });
  return [
    { row: arc(0), picture: 0 },
    { row: arc(1), picture: 0 },
    { row: single(77, "BM-001A1"), picture: 1 },
    // NO. repeated on every variant row of product 78 (tolerated).
    { row: single(78, "BM-002A1"), picture: 2 },
    { row: single(78, "BM-002A2"), picture: 2 },
  ];
}

/**
 * Writes rows under the header of a template and anchors one picture in the
 * Image cell of each row. Rows start at Excel row 2.
 */
export async function fillTemplate(
  template: Uint8Array,
  rows: readonly { row: TemplateRow; picture?: number }[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(template) as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Products") as ExcelJS.Worksheet;
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, column) => {
    headers[column - 1] = String(cell.value);
  });
  const pictures = await fixturePictures();
  const ids = pictures.map((buffer) =>
    workbook.addImage({
      buffer: buffer as unknown as ExcelJS.Buffer,
      extension: "png",
    }),
  );
  const imageColumn = columnOf(headers, "Image");
  rows.forEach(({ row, picture }, i) => {
    const r = i + 2;
    for (const [header, value] of Object.entries(row)) {
      sheet.getCell(r, columnOf(headers, header)).value = value;
    }
    if (picture !== undefined) {
      sheet.addImage(ids[picture] as number, {
        tl: { col: imageColumn - 1, row: r - 1 },
        ext: { width: 64, height: 64 },
        editAs: "oneCell",
      });
    }
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** The template with the golden rows filled in. */
export async function goldenTemplateFile(): Promise<Buffer> {
  return fillTemplate(
    await buildImportTemplate(TEMPLATE_INPUT),
    goldenTemplateRows(),
  );
}
