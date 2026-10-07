// Tests for grouping (Phase 3 T4): cleaned rows → products with shared and
// per-variant specs, base model code, slug, labels, template columns and the
// row errors that block a product. Golden No. 76 runs on the synthetic fixture.

import { describe, expect, it } from "vitest";

import {
  MAX_PRODUCT_NAME_LENGTH,
  MAX_VARIANT_LABEL_LENGTH,
} from "@/lib/constants";

import { buildFixture } from "../../../test/fixtures/import/build";
import { checked } from "../../../test/fixtures/import/checked";
import { cleanRow, type CleanedRow } from "./clean";
import { groupRows, type GroupLookups, type GroupResult } from "./group";
import type { ColumnKey, ImportProduct } from "./types";
import { readWorkbook } from "./workbook";

const DEFAULT_CATEGORY = "c0000000000000000000000a";

/* A small category tree and the seven areas, as the plan step passes them. */
const LOOKUPS: GroupLookups = {
  defaultCategoryId: DEFAULT_CATEGORY,
  categories: [
    {
      id: DEFAULT_CATEGORY,
      name: "Uncategorised",
      slug: "uncategorised",
      parentId: null,
    },
    { id: "c1", name: "Spot Lights", slug: "spot-lights", parentId: null },
    { id: "c1a", name: "Recessed", slug: "recessed", parentId: "c1" },
    { id: "c2", name: "Downlights", slug: "downlights", parentId: null },
    { id: "c2a", name: "Recessed", slug: "recessed", parentId: "c2" },
    {
      id: "c3",
      name: "Magnetic Track",
      slug: "magnetic-track",
      parentId: null,
    },
    { id: "c3a", name: "10mm", slug: "10mm", parentId: "c3" },
    { id: "c3b", name: "GOBO", slug: "gobo", parentId: "c3" },
    { id: "c4", name: "Linear", slug: "linear", parentId: null },
    { id: "c4a", name: "20mm Profiles", slug: "20mm-profiles", parentId: "c4" },
  ],
  areas: [
    { id: "a1", name: "Residential", slug: "residential" },
    { id: "a2", name: "Retail", slug: "retail" },
    { id: "a3", name: "Hospitality", slug: "hospitality" },
  ],
};

async function fixtureRows(): Promise<CleanedRow[]> {
  const read = await readWorkbook(await checked(await buildFixture()));
  if (!read.ok) throw new Error(JSON.stringify(read.warnings));
  return read.rows.map(cleanRow);
}

/* One sheet row through the real cleaner; `cells` are raw cell texts. */
function row(
  excelRow: number,
  cells: Partial<Record<ColumnKey, string>>,
  sheet = "Sheet1",
): CleanedRow {
  return cleanRow({ sheet, row: excelRow, hidden: false, cells });
}

/* A full variant row with the five checked specs filled in. */
function variant(
  excelRow: number,
  no: string | undefined,
  modelNo: string | undefined,
  extra: Partial<Record<ColumnKey, string>> = {},
): CleanedRow {
  return row(excelRow, {
    ...(no === undefined ? {} : { productNo: no }),
    family: "Arc",
    type: "Spot",
    ...(modelNo === undefined ? {} : { modelNo }),
    cct: "3000K",
    cri: ">90",
    beamAngle: "30°",
    wattage: "12W",
    lumenOutput: "1000 LM",
    ...extra,
  });
}

function only(result: GroupResult, productNo: number): ImportProduct {
  const found = result.products.filter((p) => p.productNo === productNo);
  expect(found).toHaveLength(1);
  return found[0] as ImportProduct;
}

function codes(product: ImportProduct): string[] {
  return product.warnings.map((w) => w.code);
}

describe("golden No. 76 (synthetic fixture)", () => {
  it("is one product Arc with two variants and the right shared values", async () => {
    const result = groupRows(await fixtureRows(), LOOKUPS);
    const p76 = only(result, 76);

    expect(p76.blocked).toBe(false);
    expect(p76.family).toBe("Arc");
    expect(p76.type).toBe("Pull-Down Spot Light Trim Round 1 Head");
    expect(p76.baseModelCode).toBe("AR-013A");
    expect(p76.slug).toBe("arc-ar-013a");
    expect(p76.name).toBe("Arc AR-013A");
    expect(p76.rows).toEqual([3, 4]);

    expect(p76.specs).toMatchObject({
      housingMaterial: ["Die Casting Aluminium + PC"],
      housingFinish: ["White", "Black"],
      cutOutSize: ["Ø90mm"],
      dimensions: ["D100*H110mm"],
      chipType: ["COB"],
      cct: ["3000K", "4000K"],
      cri: [">90"],
      beamAngle: ["20°", "30°", "40°", "60°"],
      driver: ["Lifud"],
      voltageInput: ["AC220-240V"],
      wattage: ["12W"],
      powerFactor: ["0.9"],
      sdcm: ["≤3"],
      lifespan: ["50,000 hrs"],
      ipRating: ["IP20"],
    });
    for (const key of ["lens", "reflector", "lumenOutput", "lumenEfficiency"]) {
      expect(p76.specs).not.toHaveProperty(key);
    }

    expect(p76.variants.map((v) => [v.modelNo, v.label, v.row])).toEqual([
      ["AR-013A1", "Regular Lens", 3],
      ["AR-013A2", "High Effciency Reflector", 4],
    ]);
    expect(p76.variants.map((v) => v.specs)).toEqual([
      {
        lens: ["Regular Lens"],
        lumenOutput: ["1140 LM"],
        lumenEfficiency: ["95±"],
      },
      {
        reflector: ["High Effciency Reflector"],
        lumenOutput: ["1200 LM"],
        lumenEfficiency: ["100±"],
      },
    ]);
    expect(p76.warnings).toEqual([]);
  });
});

describe("Nos. 77-81 of the synthetic fixture", () => {
  it("blocks Nos. 80/81 with missing_model_no on every row and keeps the rest", async () => {
    const result = groupRows(await fixtureRows(), LOOKUPS);
    expect(result.warnings).toEqual([]);
    expect(
      result.products.map((p) => [p.productNo, p.blocked, p.slug]),
    ).toEqual([
      [76, false, "arc-ar-013a"],
      [77, false, "arc-ar-013b"],
      [78, false, "arc-ar-013c"],
      [79, false, "arc-ar-013d"],
      [80, true, "arc"],
      [81, true, "arc"],
    ]);
    const p80 = only(result, 80);
    expect(
      p80.warnings
        .filter((w) => w.code === "missing_model_no")
        .map((w) => [w.sheet, w.row, w.column, w.severity]),
    ).toEqual([
      ["Sheet1", 11, "modelNo", "error"],
      ["Sheet1", 12, "modelNo", "error"],
    ]);
    expect(p80.variants).toEqual([]);
  });
});

describe("products and continuation rows", () => {
  it("puts a blank-NO. row on the product above", () => {
    const result = groupRows(
      [
        variant(3, "1", "AB-101"),
        variant(4, undefined, "AB-102"),
        variant(5, "2", "CD-201"),
      ],
      LOOKUPS,
    );
    expect(result.products.map((p) => [p.productNo, p.rows])).toEqual([
      [1, [3, 4]],
      [2, [5]],
    ]);
  });

  it("reports a blank-NO. row with no product above it (on its sheet) as orphan_row", () => {
    const sheet2 = { ...variant(3, undefined, "ZZ-2"), sheet: "Sheet2" };
    const result = groupRows(
      [variant(3, undefined, "ZZ-1"), variant(4, "1", "AB-101"), sheet2],
      LOOKUPS,
    );
    expect(result.products.map((p) => p.productNo)).toEqual([1]);
    expect(only(result, 1).rows).toEqual([4]);
    expect(
      result.warnings.map((w) => [w.code, w.severity, w.sheet, w.row]),
    ).toEqual([
      ["orphan_row", "error", "Sheet1", 3],
      ["orphan_row", "error", "Sheet2", 3],
    ]);
  });

  it("blocks a product whose NO. is invalid, with its continuation rows", () => {
    const result = groupRows(
      [
        variant(3, "-", "AB-101"),
        variant(4, undefined, "AB-102"),
        variant(5, "2", "CD-201"),
      ],
      LOOKUPS,
    );
    const [bad, good] = result.products;
    expect(bad?.productNo).toBeNull();
    expect(bad?.rows).toEqual([3, 4]);
    expect(bad?.blocked).toBe(true);
    expect(bad?.warnings.map((w) => w.code)).toContain("invalid_product_no");
    expect(good?.blocked).toBe(false);
  });

  it("blocks a product with an over-long model no. (invalid_model_no)", () => {
    const result = groupRows([variant(3, "1", "X".repeat(65))], LOOKUPS);
    expect(only(result, 1).blocked).toBe(true);
    expect(codes(only(result, 1))).toContain("invalid_model_no");
  });

  it("blocks both products when one NO. starts two products (not adjacent)", () => {
    const result = groupRows(
      [
        variant(3, "7", "AB-101"),
        variant(4, "8", "EF-301"),
        variant(5, "7", "CD-201"),
      ],
      LOOKUPS,
    );
    expect(result.products.map((p) => [p.blocked, codes(p)])).toEqual([
      [true, ["duplicate_product_no"]],
      [false, []],
      [true, ["duplicate_product_no"]],
    ]);
  });

  it("treats the same NO. on the directly following row as the same product (ADR 0059)", () => {
    const result = groupRows(
      [variant(3, "7", "AB-101"), variant(4, "7", "AB-102")],
      LOOKUPS,
    );
    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.rows).toEqual([3, 4]);
    expect(result.products[0]?.blocked).toBe(false);
  });

  it("allows the same NO. on two different sheets", () => {
    const other = { ...variant(3, "7", "CD-201"), sheet: "Sheet2" };
    const result = groupRows([variant(3, "7", "AB-101"), other], LOOKUPS);
    expect(result.products.map((p) => [p.sheet, p.blocked])).toEqual([
      ["Sheet1", false],
      ["Sheet2", false],
    ]);
  });
});

describe("model nos.", () => {
  it("reports a missing model no. and blocks only that product", () => {
    const result = groupRows(
      [
        variant(3, "1", "AB-101"),
        variant(4, undefined, undefined),
        variant(5, "2", "CD-201"),
      ],
      LOOKUPS,
    );
    const p1 = only(result, 1);
    expect(p1.blocked).toBe(true);
    expect(
      p1.warnings
        .filter((w) => w.code === "missing_model_no")
        .map((w) => w.row),
    ).toEqual([4]);
    expect(only(result, 2).blocked).toBe(false);
  });

  it("blocks BOTH products when a model no. repeats across them, ignoring case", () => {
    const result = groupRows(
      [variant(3, "1", "ab-1"), variant(4, "2", "AB-1")],
      LOOKUPS,
    );
    expect(result.products).toHaveLength(2);
    for (const product of result.products) {
      expect(product.blocked).toBe(true);
      expect(product.warnings.map((w) => [w.code, w.row, w.column])).toEqual([
        ["duplicate_model_no", product.rows[0], "modelNo"],
      ]);
    }
  });

  it("blocks a product whose own rows repeat a model no.", () => {
    const result = groupRows(
      [
        variant(3, "1", "AB-1"),
        variant(4, undefined, "Ab-1"),
        variant(5, "2", "CD-1"),
      ],
      LOOKUPS,
    );
    expect(only(result, 1).warnings.map((w) => [w.code, w.row])).toEqual([
      ["duplicate_model_no", 3],
      ["duplicate_model_no", 4],
    ]);
    expect(only(result, 2).blocked).toBe(false);
  });

  it("warns (without blocking) when a model no. contains a space", () => {
    const p = only(groupRows([variant(3, "1", "AB-1\nAB-2")], LOOKUPS), 1);
    expect(p.variants[0]?.modelNo).toBe("AB-1 AB-2");
    expect(codes(p)).toEqual(["model_no_has_space"]);
    expect(p.blocked).toBe(false);
  });

  it("keeps the model no. as typed next to its case-insensitive key", () => {
    const p = only(groupRows([variant(3, "1", "Ar-013a1")], LOOKUPS), 1);
    expect(p.variants[0]).toMatchObject({
      modelNo: "Ar-013a1",
      modelNoKey: "ar-013a1",
    });
  });
});

describe("base model code, name and slug", () => {
  it("uses the single variant's model no.", () => {
    const p = only(groupRows([variant(3, "1", "AR-013A1")], LOOKUPS), 1);
    expect([p.baseModelCode, p.name, p.slug]).toEqual([
      "AR-013A1",
      "Arc AR-013A1",
      "arc-ar-013a1",
    ]);
  });

  it("trims a trailing dash from the common prefix", () => {
    const p = only(
      groupRows(
        [variant(3, "1", "AR-013-1"), variant(4, undefined, "AR-013-2")],
        LOOKUPS,
      ),
      1,
    );
    expect(p.baseModelCode).toBe("AR-013");
  });

  it("compares the prefix without case and keeps the first row's text", () => {
    const p = only(
      groupRows(
        [variant(3, "1", "Ar-013A1"), variant(4, undefined, "AR-013a2")],
        LOOKUPS,
      ),
      1,
    );
    expect(p.baseModelCode).toBe("Ar-013A");
  });

  it("falls back to the first model no. with a warning when the prefix is under 3 characters", () => {
    const p = only(
      groupRows(
        [variant(3, "1", "AB-1"), variant(4, undefined, "AC-2")],
        LOOKUPS,
      ),
      1,
    );
    expect(p.baseModelCode).toBe("AB-1");
    expect(p.warnings.map((w) => [w.code, w.severity, w.row])).toEqual([
      ["short_base_model_code", "warning", 3],
    ]);
  });

  it("builds name and slug from the base code alone when there is no family", () => {
    const p = only(
      groupRows([variant(3, "1", "XY-100", { family: "" })], LOOKUPS),
      1,
    );
    expect([p.family, p.name, p.slug]).toEqual([null, "XY-100", "xy-100"]);
  });
});

describe("shared vs per-variant values", () => {
  it("treats blank and '-' as the same 'not applicable' (No. 78 vs No. 76)", () => {
    const p = only(
      groupRows(
        [
          variant(3, "1", "AR-101", { reflector: "-", diffuser: "" }),
          variant(4, undefined, "AR-102", { diffuser: "-" }),
        ],
        LOOKUPS,
      ),
      1,
    );
    expect(p.specs).not.toHaveProperty("reflector");
    expect(p.specs).not.toHaveProperty("diffuser");
    expect(p.variants.map((v) => v.specs)).toEqual([{}, {}]);
  });

  it("keeps a value per variant when only some rows have it", () => {
    const p = only(
      groupRows(
        [
          variant(3, "1", "AR-101", { ugr: "<19" }),
          variant(4, undefined, "AR-102"),
        ],
        LOOKUPS,
      ),
      1,
    );
    expect(p.variants.map((v) => v.specs)).toEqual([{ ugr: ["<19"] }, {}]);
  });

  it("compares options in order, so a reordered list is per variant", () => {
    const p = only(
      groupRows(
        [
          variant(3, "1", "AR-101", { cct: "3000K\n4000K" }),
          variant(4, undefined, "AR-102", { cct: "3000K\n4000K" }),
          variant(5, undefined, "AR-103", { cct: "4000K\n3000K" }),
        ],
        LOOKUPS,
      ),
      1,
    );
    expect(p.specs.cct).toBeUndefined();
    expect(p.variants.map((v) => v.specs.cct)).toEqual([
      ["3000K", "4000K"],
      ["3000K", "4000K"],
      ["4000K", "3000K"],
    ]);
  });

  it("appends the model no. to labels two variants would share", () => {
    const p = only(
      groupRows(
        [
          variant(3, "1", "X-101", { lens: "Regular Lens", wattage: "10W" }),
          variant(4, undefined, "X-102", {
            lens: "Regular Lens",
            wattage: "15W",
          }),
          variant(5, undefined, "X-103", {
            reflector: "High Efficiency Reflector",
            wattage: "10W",
          }),
        ],
        LOOKUPS,
      ),
      1,
    );
    expect(p.variants.map((v) => v.label)).toEqual([
      "Regular Lens (X-101)",
      "Regular Lens (X-102)",
      "High Efficiency Reflector",
    ]);
  });

  it("falls back to the model no. when the suffixed label is cut and still collides", () => {
    const long = "L".repeat(MAX_VARIANT_LABEL_LENGTH);
    const p = only(
      groupRows(
        [
          variant(3, "1", "X-101", { lens: long, wattage: "10W" }),
          variant(4, undefined, "X-102", { lens: long, wattage: "15W" }),
          variant(5, undefined, "X-103", { reflector: "Reflector" }),
        ],
        LOOKUPS,
      ),
      1,
    );
    expect(p.variants.map((v) => v.label)).toEqual([
      "X-101",
      "X-102",
      "Reflector",
    ]);
  });

  it("labels variants by the model no. when no optic column differs", () => {
    const p = only(
      groupRows(
        [
          variant(3, "1", "AR-101", { lens: "Regular Lens", wattage: "10W" }),
          variant(4, undefined, "AR-102", {
            lens: "Regular Lens",
            wattage: "12W",
          }),
        ],
        LOOKUPS,
      ),
      1,
    );
    expect(p.variants.map((v) => v.label)).toEqual(["AR-101", "AR-102"]);
  });

  it("takes family from the first row and warns on a different later value", () => {
    const p = only(
      groupRows(
        [
          variant(3, "1", "AR-101"),
          variant(4, undefined, "AR-102", { family: "Arco" }),
        ],
        LOOKUPS,
      ),
      1,
    );
    expect(p.family).toBe("Arc");
    expect(
      p.warnings.map((w) => [w.code, w.row, w.column, w.severity]),
    ).toEqual([["family_mismatch", 4, "family", "warning"]]);
  });

  it("warns on a different later Model Type", () => {
    const p = only(
      groupRows(
        [
          variant(3, "1", "AR-101"),
          variant(4, undefined, "AR-102", { type: "Wall" }),
        ],
        LOOKUPS,
      ),
      1,
    );
    expect(p.type).toBe("Spot");
    expect(p.warnings.map((w) => [w.code, w.row, w.column])).toEqual([
      ["family_mismatch", 4, "type"],
    ]);
  });

  it("keeps the name within MAX_PRODUCT_NAME_LENGTH for an over-long family", () => {
    const p = only(
      groupRows(
        [variant(3, "1", "AR-101", { family: "F".repeat(250) })],
        LOOKUPS,
      ),
      1,
    );
    expect(Array.from(p.name).length).toBeLessThanOrEqual(
      MAX_PRODUCT_NAME_LENGTH,
    );
    expect(p.name.endsWith(" AR-101")).toBe(true);
  });

  it("trims a trailing underscore, dot or slash from the base code", () => {
    const p = only(
      groupRows(
        [variant(3, "1", "AR_01_A"), variant(4, undefined, "AR_01_B")],
        LOOKUPS,
      ),
      1,
    );
    expect(p.baseModelCode).toBe("AR_01");
  });
});

describe("missing_spec and unparsed filter values", () => {
  it("warns once per product when no row has a checked spec", () => {
    const p = only(
      groupRows(
        [
          variant(3, "1", "AR-101", { cri: "-" }),
          variant(4, undefined, "AR-102", { cri: "" }),
        ],
        LOOKUPS,
      ),
      1,
    );
    expect(p.warnings.map((w) => [w.code, w.row, w.column])).toEqual([
      ["missing_spec", 3, "cri"],
    ]);
    expect(p.blocked).toBe(false);
  });

  it("warns on the variant row that lacks a checked spec", () => {
    const p = only(
      groupRows(
        [
          variant(3, "1", "AR-101"),
          variant(4, undefined, "AR-102", { wattage: "-" }),
        ],
        LOOKUPS,
      ),
      1,
    );
    expect(p.warnings.map((w) => [w.code, w.row, w.column])).toEqual([
      ["missing_spec", 4, "wattage"],
    ]);
  });

  it("reports a filter value with no number once, on the row that owns it", () => {
    const p = only(
      groupRows(
        [
          variant(3, "1", "AR-101", { ipRating: "Indoor" }),
          variant(4, undefined, "AR-102", { ipRating: "Indoor" }),
        ],
        LOOKUPS,
      ),
      1,
    );
    expect(p.warnings.map((w) => [w.code, w.row, w.column])).toEqual([
      ["unparsed_filter_value", 3, "ipRating"],
    ]);
  });
});

describe("template columns", () => {
  const product = (cells: Partial<Record<ColumnKey, string>>) =>
    only(groupRows([variant(3, "1", "AR-101", cells)], LOOKUPS), 1);

  it("uses the default category and empty lists when the columns are absent", () => {
    expect(product({})).toMatchObject({
      mainCategory: DEFAULT_CATEGORY,
      mainCategoryFromSheet: false,
      extraCategories: [],
      extraCategoriesFromSheet: false,
      areas: [],
      areasFromSheet: false,
      trackSize: null,
    });
  });

  it("resolves a category by slug or name, any case", () => {
    expect(product({ category: "SPOT-LIGHTS" }).mainCategory).toBe("c1");
    expect(product({ category: "spot lights" })).toMatchObject({
      mainCategory: "c1",
      mainCategoryFromSheet: true,
    });
  });

  it("resolves a 'Main > Sub' path (also with ›) and flags an ambiguous bare name", () => {
    expect(product({ category: "Downlights > recessed" }).mainCategory).toBe(
      "c2a",
    );
    expect(product({ category: "spot-lights › Recessed" }).mainCategory).toBe(
      "c1a",
    );
    const ambiguous = product({ category: "Recessed" });
    expect(ambiguous.mainCategory).toBe(DEFAULT_CATEGORY);
    expect(ambiguous.warnings.map((w) => [w.code, w.column])).toEqual([
      ["unknown_category", "category"],
    ]);
    expect(ambiguous.warnings[0]?.detail).toContain("Main > Sub");
  });

  it("falls back to the default category on an unknown name, with a warning", () => {
    const p = product({ category: "Chandeliers" });
    expect(p).toMatchObject({
      mainCategory: DEFAULT_CATEGORY,
      mainCategoryFromSheet: false,
      blocked: false,
    });
    expect(
      p.warnings.map((w) => [w.code, w.severity, w.row, w.column]),
    ).toEqual([["unknown_category", "warning", 3, "category"]]);
  });

  it("resolves extra categories and areas, skipping unknown names and the main category", () => {
    const p = product({
      category: "Spot Lights",
      extraCategories: "Downlights > Recessed; spot-lights; Nope",
      areas: "retail; Hospitality; Moon",
    });
    expect(p).toMatchObject({
      extraCategories: ["c2a"],
      extraCategoriesFromSheet: true,
      areas: ["a2", "a3"],
      areasFromSheet: true,
    });
    expect(p.warnings.map((w) => [w.code, w.column])).toEqual([
      ["unknown_category", "extraCategories"],
      ["unknown_area", "areas"],
    ]);
  });

  it("does not mark extra categories as from the sheet when the cell only repeats the main category", () => {
    const p = product({
      category: "Spot Lights",
      extraCategories: "spot-lights",
    });
    expect(p).toMatchObject({
      extraCategories: [],
      extraCategoriesFromSheet: false,
    });
  });

  it("sets trackSize only for a 5/10/20mm subcategory of Magnetic Track", () => {
    expect(product({ category: "Magnetic Track > 10mm" }).trackSize).toBe(10);
    expect(product({ category: "Magnetic Track > GOBO" }).trackSize).toBeNull();
    expect(product({ category: "Magnetic Track" }).trackSize).toBeNull();
    expect(
      product({ category: "Linear > 20mm-profiles" }).trackSize,
    ).toBeNull();
    expect(
      product({
        category: "Spot Lights",
        extraCategories: "magnetic-track > 10mm",
      }).trackSize,
    ).toBe(10);
  });
});
