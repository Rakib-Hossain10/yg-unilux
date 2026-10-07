// Builds the downloadable import template (ADR 0059): the sheet the client
// fills in, generated per download from the live category tree and areas.
//
// Sheet "Products": the 33 client columns in the client's order (English
// only), then Category, Extra Category 1, Extra Category 2 and one
// "Area: <name>" Yes/No column per area. The header row is bold and frozen
// and carries cell notes with the rules.
// Sheet "Lists" (veryHidden): the dropdown values. The strict list
// validations (rows 2..MAX_TEMPLATE_ROWS + 1) point straight at ranges on it,
// with no defined names (the sheet guard strips those on import anyway).
//
// The parser (columns.ts, workbook.ts) reads this layout back; the round trip
// is pinned by template.test.ts.

import "server-only";

import ExcelJS from "exceljs";

import { MAX_TEMPLATE_ROWS } from "@/lib/constants";
import { SPEC_COLUMNS } from "@/models/spec-columns";

import { IDENTITY_COLUMNS } from "./columns";
import type { AreaLookup, CategoryLookup } from "./group";

export const TEMPLATE_PRODUCTS_SHEET = "Products";
export const TEMPLATE_EXTRA_SLOTS = 2;

export interface TemplateInput {
  /** The category tree (main categories and subcategories). */
  categories: readonly Pick<CategoryLookup, "id" | "name" | "parentId">[];
  /** The areas in the admin's order. */
  areas: readonly Pick<AreaLookup, "name">[];
}

const FONT = "Arial";
const NO_NOTE =
  "One row per variant (one Model No. per row).\n" +
  "Type NO. on a product's first row. Leave it blank on its other variant rows (or repeat the same NO. directly below).\n" +
  "Do not merge cells. English only. Use - for not applicable.";

/** The header notes: header text → the rule shown when the cell is hovered. */
const NOTES: Readonly<Record<string, string>> = {
  "NO.": NO_NOTE,
  "Model Name": "The product family, for example Arc. English only.",
  "Model No.":
    "Required on every row and never repeated. Each row is one variant; the model no. is how a re-import finds the product.",
  Image:
    "Put one picture inside this cell of the product's row (Insert > Picture > Place in Cell, or drag it over the cell). One picture per row.",
  Category:
    "Pick the main category from the dropdown (Main, or Main > Sub). Do not type your own.",
  "Extra Category 1":
    "Optional. Pick from the dropdown only. More extras can be added in the admin panel.",
  "Extra Category 2":
    "Optional. Pick from the dropdown only. More extras can be added in the admin panel.",
};
const AREA_NOTE =
  "Pick Yes or No from the dropdown. Leave blank for No. Do not type your own.";
const SPEC_NOTE =
  "English only. Use - for not applicable. Several options go on separate lines in the cell (for example 3000K, then 4000K on the next line).";

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

/** The sheet's headers in the client's order: NO. .. Model No., Batch No., Image, the rest. */
export function templateSheetHeaders(): string[] {
  const identity = (key: string) =>
    IDENTITY_COLUMNS.find((c) => c.key === key)?.header as string;
  const batch = SPEC_COLUMNS.find((c) => c.key === "batchNo");
  return [
    identity("productNo"),
    identity("family"),
    identity("type"),
    identity("modelNo"),
    batch?.header as string,
    identity("image"),
    ...SPEC_COLUMNS.filter((c) => c.key !== "batchNo").map((c) => c.header),
  ];
}

/** "Main" and "Main > Sub" for every category, in tree order. */
export function categoryPaths(
  categories: TemplateInput["categories"],
): string[] {
  const paths: string[] = [];
  for (const main of categories.filter((c) => c.parentId === null)) {
    paths.push(main.name);
    for (const sub of categories.filter((c) => c.parentId === main.id)) {
      paths.push(`${main.name} > ${sub.name}`);
    }
  }
  return paths;
}

/** Builds the template workbook as .xlsx bytes. */
export async function buildImportTemplate(
  input: TemplateInput,
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "YG UniLUX";
  const sheet = workbook.addWorksheet(TEMPLATE_PRODUCTS_SHEET, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const lists = workbook.addWorksheet("Lists", { state: "veryHidden" });

  const paths = categoryPaths(input.categories);
  lists.getCell(1, 1).value = "Categories";
  paths.forEach((path, i) => {
    lists.getCell(i + 2, 1).value = path;
  });
  lists.getCell(1, 2).value = "Yes/No";
  lists.getCell(2, 2).value = "Yes";
  lists.getCell(3, 2).value = "No";

  const headers = [
    ...templateSheetHeaders(),
    "Category",
    ...Array.from(
      { length: TEMPLATE_EXTRA_SLOTS },
      (_, i) => `Extra Category ${i + 1}`,
    ),
    ...input.areas.map((area) => `Area: ${area.name}`),
  ];
  const specHeaders = new Set<string>(SPEC_COLUMNS.map((c) => c.header));
  const lastRow = MAX_TEMPLATE_ROWS + 1;

  headers.forEach((header, i) => {
    const column = i + 1;
    const cell = sheet.getCell(1, column);
    cell.value = header;
    cell.font = { name: FONT, bold: true };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEDEDED" },
    };
    const note = header.startsWith("Area: ")
      ? AREA_NOTE
      : (NOTES[header] ?? (specHeaders.has(header) ? SPEC_NOTE : undefined));
    if (note !== undefined) cell.note = note;
    sheet.getColumn(column).width = Math.max(14, header.length + 4);
  });
  sheet.getRow(1).height = 30;
  sheet.getColumn(1).width = 8;

  const dataValidations = (
    sheet as unknown as {
      dataValidations: { model: Record<string, ExcelJS.DataValidation> };
    }
  ).dataValidations.model;
  const addList = (column: number, range: string, what: string) => {
    const letter = columnLetter(column);
    dataValidations[`${letter}2:${letter}${lastRow}`] = {
      type: "list",
      allowBlank: true,
      formulae: [range],
      showErrorMessage: true,
      errorStyle: "stop",
      errorTitle: "Pick from the list",
      error: `Choose ${what} from the dropdown; typed values are not accepted.`,
    };
  };
  headers.forEach((header, i) => {
    if (
      paths.length > 0 &&
      (header === "Category" || header.startsWith("Extra Category "))
    ) {
      addList(i + 1, `Lists!$A$2:$A$${paths.length + 1}`, "a category");
    } else if (header.startsWith("Area: ")) {
      addList(i + 1, "Lists!$B$2:$B$3", "Yes or No");
    }
  });

  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
