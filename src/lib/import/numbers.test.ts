// Tests for the filter parsers (plan "Numeric filter parsers"): an accept /
// reject table per filter, the per-cell entry point with its
// `unparsed_filter_value` warning, and the product-wide union filtersFromSpecs.

import { describe, expect, expectTypeOf, it } from "vitest";

import { MAX_FILTER_VALUES } from "@/lib/constants";
import type { ProductFilters } from "@/models/product";
import type { FilterKey } from "@/models/spec-columns";

import {
  filtersFromSpecs,
  parseBeamDeg,
  parseCctK,
  parseCri,
  parseFilterNumbers,
  parseIp,
  parseUgr,
  parseWattage,
} from "./numbers";

const AT = { sheet: "Sheet1", row: 3 };

it("FilterKey matches the product model's filter keys", () => {
  expectTypeOf<keyof ProductFilters>().toEqualTypeOf<FilterKey>();
});

describe("parseCctK (1000-10000 K; a range stores both ends)", () => {
  it.each<[string, number[]]>([
    ["3000K", [3000]],
    ["2700K-6500K", [2700, 6500]],
    ["2700-6500K", [2700, 6500]],
    ["1800K~3000K", [1800, 3000]],
    ["3000K/4000K", [3000, 4000]],
    ["CCT 3000K", [3000]],
    ["CCT3000K", [3000]],
    ["3,000K", [3000]],
    ["3000", [3000]],
    ["3000 K", [3000]],
    ["3000K±150K", [3000]],
    ["3000K (Ra90)", [3000]],
    ["500K", []],
    ["12000K", []],
    ["Warm White", []],
    ["", []],
  ])("%j → %j", (text, expected) => {
    expect(parseCctK(text)).toEqual(expected);
  });
});

describe("parseCri (50-100; Ra/CRI prefixes and > ≥ all count)", () => {
  it.each<[string, number[]]>([
    [">90", [90]],
    ["Ra>90", [90]],
    ["Ra≥80", [80]],
    ["CRI 90", [90]],
    ["CRI>90", [90]],
    ["Ra90", [90]],
    ["90", [90]],
    ["97+", [97]],
    ["Ra 80/90", [80, 90]],
    ["CRI>90, R9>50", [90]],
    ["90Ra", [90]],
    ["≥80 Ra", [80]],
    ["CRI 90 min", [90]],
    ["CRI90", [90]],
    ["30", []],
    ["101", []],
    ["High", []],
  ])("%j → %j", (text, expected) => {
    expect(parseCri(text)).toEqual(expected);
  });
});

describe("parseBeamDeg (1-360°)", () => {
  it.each<[string, number[]]>([
    ["24°", [24]],
    ["15°/24°/36°", [15, 24, 36]],
    ["24 deg", [24]],
    ["24 degrees", [24]],
    ["24", [24]],
    ["10-60°", [10, 60]],
    ["8.5°", [8.5]],
    ["15°x45°", [15, 45]],
    ["PAR30 24°", [24]],
    ["15x45°", [15, 45]],
    ["15×45°", [15, 45]],
    ["0°", []],
    ["400°", []],
    ["Wide", []],
  ])("%j → %j", (text, expected) => {
    expect(parseBeamDeg(text)).toEqual(expected);
  });
});

describe("parseUgr (0-40)", () => {
  it.each<[string, number[]]>([
    ["<19", [19]],
    ["UGR<16", [16]],
    ["UGR≤22", [22]],
    ["19", [19]],
    ["<19 (4H/8H)", [19]],
    ["UGR19", [19]],
    ["19 max", [19]],
    ["50", []],
    ["Low glare", []],
    // "x" ending the word "max" is not a count marker; "x19" is a count.
    ["max 19", [19]],
    ["x19", []],
  ])("%j → %j", (text, expected) => {
    expect(parseUgr(text)).toEqual(expected);
  });
});

describe("parseWattage (0.1-2000 W; a tolerance is dropped)", () => {
  it.each<[string, number[]]>([
    ["10W", [10]],
    ["7W/10W", [7, 10]],
    ["10±1W", [10]],
    ["10 ± 1 W", [10]],
    ["10", [10]],
    ["12.5W", [12.5]],
    ["7-10W", [7, 10]],
    ["AC220V 12W", [12]],
    ["2x10W", [10]],
    ["3×10W", [10]],
    ["10W*2", [10]],
    ["AC220-240V 12W", [12]],
    ["7 to 10W", [7, 10]],
    ["10+/-1W", [10]],
    ["1,200W", [1200]],
    ["100,150,200W", [100, 150, 200]],
    // One number (1.2 million), so out of range; never read as [1, 200].
    ["1,200,000W", []],
    // Ambiguous (list or 100,150?): read as one number, out of range, flagged.
    ["100,150W", []],
    ["18Wx2", [18]],
    ["18W x 2", [18]],
    ["GU10 max 7W", [7]],
    ["MR16 5W", [5]],
    ["0W", []],
    ["5000W", []],
    ["Max", []],
    // Count markers read backwards from the number (no regex over the
    // prefix): a leading "x", spaces after it, but not across a line break
    // and not an "x" that ends a word.
    ["x2 10W", [10]],
    ["X 2 7W", [7]],
    ["* 2 7W", [7]],
    ["box2 10W", [10]],
    ["x\n2W", [2]],
  ])("%j → %j", (text, expected) => {
    expect(parseWattage(text)).toEqual(expected);
  });

  it("stays linear on a long value with many numbers", () => {
    // Unitless numbers, so every token goes through countBefore and
    // gluedPrefix; a regex over the prefix would take seconds here.
    const text = "a".repeat(20_000) + " 1".repeat(20_000);
    const start = performance.now();
    expect(parseWattage(text)).toEqual([1]);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

describe("parseIp (the two digits as a number)", () => {
  it.each<[string, number[]]>([
    ["IP20", [20]],
    ["IP65", [65]],
    ["ip 44", [44]],
    ["IP44/IP65", [44, 65]],
    ["IPX4", []],
    ["IP7", []],
    ["65", []],
  ])("%j → %j", (text, expected) => {
    expect(parseIp(text)).toEqual(expected);
  });
});

describe("parseFilterNumbers (one cleaned cell of a spec key)", () => {
  it("parses the real sheet's filter cells", () => {
    expect(
      parseFilterNumbers("beamAngle", ["20°", "30°", "40°", "60°"], AT),
    ).toEqual({ filter: "beamDeg", numbers: [20, 30, 40, 60], warnings: [] });
    expect(parseFilterNumbers("cri", [">90"], AT).numbers).toEqual([90]);
    expect(parseFilterNumbers("ipRating", ["IP20"], AT).numbers).toEqual([20]);
    expect(parseFilterNumbers("wattage", ["12W"], AT).numbers).toEqual([12]);
    expect(parseFilterNumbers("cct", ["3000K", "4000K"], AT).numbers).toEqual([
      3000, 4000,
    ]);
  });

  it("dedupes numbers across options, in first-seen order", () => {
    expect(
      parseFilterNumbers("cct", ["4000K", "3000K-4000K"], AT).numbers,
    ).toEqual([4000, 3000]);
  });

  it("warns unparsed_filter_value for an option with text but no number", () => {
    const result = parseFilterNumbers("cct", ["3000K", "Warm White"], AT);
    expect(result.numbers).toEqual([3000]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "unparsed_filter_value",
        severity: "warning",
        sheet: "Sheet1",
        row: 3,
        column: "cct",
      }),
    ]);
    expect(result.warnings[0]?.detail).toContain('"Warm White"');
  });

  it("does nothing for columns without a filter (95± stays text only)", () => {
    expect(parseFilterNumbers("lumenEfficiency", ["95±"], AT)).toEqual({
      filter: null,
      numbers: [],
      warnings: [],
    });
  });

  it("does nothing for a not-applicable cell", () => {
    expect(parseFilterNumbers("cct", null, AT)).toEqual({
      filter: "cctK",
      numbers: [],
      warnings: [],
    });
  });
});

describe("filtersFromSpecs (product + variant specs)", () => {
  it("unions every spec list, deduped and sorted", () => {
    expect(
      filtersFromSpecs([
        {
          cct: ["4000K", "3000K"],
          cri: [">90"],
          beamAngle: ["60°", "20°", "30°", "40°"],
          wattage: ["12W"],
          ipRating: ["IP20"],
          lumenEfficiency: ["95±"],
        },
        { wattage: ["7W/10W"], cct: ["3000K"] },
        {},
      ]),
    ).toEqual({
      cctK: [3000, 4000],
      cri: [90],
      beamDeg: [20, 30, 40, 60],
      wattage: [7, 10, 12],
      ip: [20],
    });
  });

  it("leaves out filters with no numbers", () => {
    expect(
      filtersFromSpecs([{ ugr: ["Low"], lens: ["Regular Lens"] }]),
    ).toEqual({});
    expect(filtersFromSpecs([])).toEqual({});
  });

  it("caps each filter at MAX_FILTER_VALUES (the lowest kept)", () => {
    const watts = Array.from(
      { length: MAX_FILTER_VALUES + 10 },
      (_, i) => `${i + 1}W`,
    );
    const filters = filtersFromSpecs([{ wattage: watts }]);
    expect(filters.wattage).toHaveLength(MAX_FILTER_VALUES);
    expect(filters.wattage?.[0]).toBe(1);
  });

  it("does not drop restricted columns itself (T7 calls withoutRestrictedFilters)", () => {
    // ugr is public by default, but nothing here reads the visibility setting.
    expect(filtersFromSpecs([{ ugr: ["<19"] }])).toEqual({ ugr: [19] });
  });
});
