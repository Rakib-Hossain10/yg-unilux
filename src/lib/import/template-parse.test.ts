// Parser additions for the controlled template (ADR 0059): header kinds, area
// flags, extra-category slots, legacy ";" columns, the Lists sheet and the
// repeated NO. rule. Hand-made sheets, so each rule is tested alone.

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { checked } from "../../../test/fixtures/import/checked";
import { cleanAreaFlag, cleanRow } from "./clean";
import { classifyHeader, columnForHeader } from "./columns";
import { groupRows } from "./group";
import { readWorkbook } from "./workbook";

const AT = { sheet: "Products", row: 2 };

const CATEGORIES = [
  { id: "c1", name: "Spot Lights", slug: "spot-lights", parentId: null },
  {
    id: "c2",
    name: "Recessed Lights",
    slug: "recessed-lights",
    parentId: null,
  },
  { id: "c3", name: "Magnetic Track", slug: "magnetic-track", parentId: null },
];
const AREAS = [
  { id: "a1", name: "Residential", slug: "residential" },
  { id: "a2", name: "Retail", slug: "retail" },
  { id: "a3", name: "Hospitality", slug: "hospitality" },
];

const BASE_HEADERS = [
  "NO.",
  "Model Name",
  "Model No.",
  "CCT",
  "CRI",
  "Beam Angle",
  "Wattage",
  "Lumen Output",
];

/** A data row of the base columns; `extra` fills the columns after them. */
function dataRow(
  no: number | null,
  model: string,
  extra: (string | null)[] = [],
): (ExcelJS.CellValue | null)[] {
  return [no, "Arc", model, "3000K", ">90", "30°", "12W", "1000 LM", ...extra];
}

async function run(
  extraHeaders: string[],
  rows: (ExcelJS.CellValue | null)[][],
  sheetName = "Products",
) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  [...BASE_HEADERS, ...extraHeaders].forEach((h, i) => {
    sheet.getCell(1, i + 1).value = h;
  });
  rows.forEach((cells, r) =>
    cells.forEach((value, c) => {
      if (value !== null) sheet.getCell(r + 2, c + 1).value = value;
    }),
  );
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const read = await readWorkbook(await checked(bytes));
  if (!read.ok) throw new Error(JSON.stringify(read.warnings));
  const group = groupRows(read.rows.map(cleanRow), {
    categories: CATEGORIES,
    areas: AREAS,
    defaultCategoryId: "c-default",
  });
  return { read, group };
}

const codes = (warnings: { code: string }[]) => warnings.map((w) => w.code);

describe("classifyHeader", () => {
  it("reads Area: <name> headers, ignoring case, spacing and Chinese", () => {
    expect(classifyHeader("Area: Residential")).toEqual({
      key: "areaFlag",
      areaName: "Residential",
    });
    expect(classifyHeader("AREA : Retail\n零售")).toEqual({
      key: "areaFlag",
      areaName: "Retail",
    });
    expect(classifyHeader("Area:")).toBeNull();
    expect(classifyHeader("Area")).toBeNull();
  });

  it("reads numbered extra-category slots and keeps the legacy columns", () => {
    expect(classifyHeader("Extra Category 2")).toEqual({
      key: "extraCategories",
      slot: 2,
    });
    expect(columnForHeader("Extra Categories")).toBe("extraCategories");
    expect(columnForHeader("Areas")).toBe("areas");
    expect(columnForHeader("Category")).toBe("category");
    expect(columnForHeader("Extra Category")).toBeNull();
  });
});

describe("cleanAreaFlag", () => {
  it.each(["Yes", "yes", "Y", "TRUE", "true", "1", "✓", "✔", " Yes 是 "])(
    "selects the area for %j",
    (cell) => {
      expect(cleanAreaFlag(cell, "Retail", AT)).toEqual({
        selected: true,
        warnings: [],
      });
    },
  );

  it.each(["No", "no", "N", "False", "0", "-", "", "   "])(
    "does not select the area for %j (no warning)",
    (cell) => {
      expect(cleanAreaFlag(cell, "Retail", AT)).toEqual({
        selected: false,
        warnings: [],
      });
    },
  );

  it.each(["maybe", "x", "2", "Yes please"])(
    "warns invalid_area_flag for %j and does not select",
    (cell) => {
      const result = cleanAreaFlag(cell, "Retail", AT);
      expect(result.selected).toBe(false);
      expect(codes(result.warnings)).toEqual(["invalid_area_flag"]);
      expect(result.warnings[0]).toMatchObject({
        severity: "warning",
        sheet: "Products",
        row: 2,
        column: "areaFlag",
      });
    },
  );
});

describe("template columns through the reader and grouping", () => {
  it("reads Yes/No area columns and both extra-category slots", async () => {
    const { read, group } = await run(
      [
        "Category",
        "Extra Category 1",
        "Extra Category 2",
        "Area: Residential",
        "Area: Retail",
        "Area: Hospitality",
      ],
      [
        dataRow(1, "ARC-101", [
          "Spot Lights",
          "Recessed Lights",
          "Magnetic Track",
          "Yes",
          "No",
          "Y",
        ]),
      ],
    );
    expect(read.warnings).toEqual([]);
    expect(group.products[0]?.warnings).toEqual([]);
    const product = group.products[0];
    expect(product?.mainCategory).toBe("c1");
    expect(product?.extraCategories).toEqual(["c2", "c3"]);
    expect(product?.areas).toEqual(["a1", "a3"]);
    expect(product?.areasFromSheet).toBe(true);
  });

  it("keeps stored areas when every area cell is No or blank", async () => {
    const { group } = await run(
      ["Area: Residential", "Area: Retail"],
      [dataRow(1, "ARC-101", ["No", null])],
    );
    expect(group.products[0]?.areas).toEqual([]);
    expect(group.products[0]?.areasFromSheet).toBe(false);
  });

  it("warns invalid_area_flag for a bad flag and still imports the product", async () => {
    const { group } = await run(
      ["Area: Residential"],
      [dataRow(1, "ARC-101", ["maybe"])],
    );
    const product = group.products[0];
    expect(codes(product?.warnings ?? [])).toEqual(["invalid_area_flag"]);
    expect(product?.blocked).toBe(false);
    expect(product?.areas).toEqual([]);
  });

  it("warns unknown_area for a Yes under an area that no longer exists", async () => {
    const { read, group } = await run(
      ["Area: Gone"],
      [dataRow(1, "ARC-101", ["Yes"])],
    );
    expect(read.warnings).toEqual([]);
    expect(codes(group.products[0]?.warnings ?? [])).toEqual(["unknown_area"]);
    expect(group.products[0]?.blocked).toBe(false);
  });

  it("warns duplicate_column for the same area twice, not for different areas", async () => {
    const { read } = await run(
      ["Area: Retail", "Area: Residential", "area: RETAIL"],
      [dataRow(1, "ARC-101", ["Yes", "Yes", "Yes"])],
    );
    expect(codes(read.warnings)).toEqual(["duplicate_column"]);
  });

  it("still reads the legacy ';' Extra Categories and Areas columns", async () => {
    const { read, group } = await run(
      ["Category", "Extra Categories", "Areas"],
      [
        dataRow(1, "ARC-101", [
          "Spot Lights",
          "Recessed Lights; Magnetic Track",
          "Retail;Residential",
        ]),
      ],
    );
    expect(read.warnings).toEqual([]);
    expect(group.products[0]?.extraCategories).toEqual(["c2", "c3"]);
    expect(group.products[0]?.areas).toEqual(["a2", "a1"]);
  });

  it("merges a legacy column and a numbered slot", async () => {
    const { group } = await run(
      ["Extra Categories", "Extra Category 2"],
      [dataRow(1, "ARC-101", ["Recessed Lights", "Magnetic Track"])],
    );
    expect(group.products[0]?.extraCategories).toEqual(["c2", "c3"]);
  });

  it("resolves a Main > Sub path from the Category dropdown", async () => {
    const categories = [
      ...CATEGORIES,
      { id: "c4", name: "Recessed", slug: "recessed", parentId: "c1" },
    ];
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Products");
    [...BASE_HEADERS, "Category"].forEach((h, i) => {
      sheet.getCell(1, i + 1).value = h;
    });
    dataRow(1, "ARC-101", ["Spot Lights > Recessed"]).forEach((v, i) => {
      if (v !== null) sheet.getCell(2, i + 1).value = v;
    });
    const read = await readWorkbook(
      await checked(Buffer.from(await workbook.xlsx.writeBuffer())),
    );
    if (!read.ok) throw new Error("not ok");
    const group = groupRows(read.rows.map(cleanRow), {
      categories,
      areas: AREAS,
      defaultCategoryId: "c-default",
    });
    expect(group.products[0]?.mainCategory).toBe("c4");
    expect(group.products[0]?.warnings).toEqual([]);
  });

  it("skips the template's Lists sheet without any warning", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Products");
    BASE_HEADERS.forEach((h, i) => {
      sheet.getCell(1, i + 1).value = h;
    });
    dataRow(1, "ARC-101").forEach((v, i) => {
      if (v !== null) sheet.getCell(2, i + 1).value = v;
    });
    const lists = workbook.addWorksheet("Lists", { state: "veryHidden" });
    lists.getCell(1, 1).value = "Categories";
    lists.getCell(2, 1).value = "Spot Lights";
    const read = await readWorkbook(
      await checked(Buffer.from(await workbook.xlsx.writeBuffer())),
    );
    if (!read.ok) throw new Error("not ok");
    expect(read.warnings).toEqual([]);
    expect(read.sheets.map((s) => s.name)).toEqual(["Products"]);
  });

  it("still warns about a hidden sheet that is not Lists", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Other", { state: "hidden" });
    BASE_HEADERS.forEach((h, i) => {
      sheet.getCell(1, i + 1).value = h;
    });
    dataRow(1, "ARC-101").forEach((v, i) => {
      if (v !== null) sheet.getCell(2, i + 1).value = v;
    });
    const read = await readWorkbook(
      await checked(Buffer.from(await workbook.xlsx.writeBuffer())),
    );
    if (!read.ok) throw new Error("not ok");
    expect(codes(read.warnings)).toEqual(["hidden_sheet"]);
  });
});

describe("a NO. repeated on the directly following row", () => {
  it("continues the product (same NO. on every variant row)", async () => {
    const { group } = await run(
      [],
      [dataRow(5, "ARC-101"), dataRow(5, "ARC-102"), dataRow(6, "BRC-201")],
    );
    expect(group.products.map((p) => p.productNo)).toEqual([5, 6]);
    expect(group.products[0]?.variants.map((v) => v.modelNo)).toEqual([
      "ARC-101",
      "ARC-102",
    ]);
    expect(codes(group.products.flatMap((p) => p.warnings))).toEqual([]);
  });

  it("mixes blank and repeated NO. inside one product", async () => {
    const { group } = await run(
      [],
      [dataRow(5, "ARC-101"), dataRow(null, "ARC-102"), dataRow(5, "ARC-103")],
    );
    expect(group.products).toHaveLength(1);
    expect(group.products[0]?.variants).toHaveLength(3);
  });

  it("still blocks a NO. repeated after another product (duplicate_product_no)", async () => {
    const { group } = await run(
      [],
      [dataRow(5, "ARC-101"), dataRow(6, "BRC-201"), dataRow(5, "CRC-301")],
    );
    expect(group.products).toHaveLength(3);
    const five = group.products.filter((p) => p.productNo === 5);
    expect(five).toHaveLength(2);
    for (const product of five) {
      expect(codes(product.warnings)).toContain("duplicate_product_no");
      expect(product.blocked).toBe(true);
    }
  });
});
