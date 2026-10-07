// Runs the cleaner over whole sheets: the synthetic fixture (always) and the
// client's real sheet (local only; skipped when absent). Property: no CJK
// character survives in any cleaned value, and no cell of these sheets is
// CJK-only. Also pins No. 76's cleaned values. Restricted columns are only
// compared row against row here, never printed.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESTRICTED_SPEC_KEYS,
  SPEC_KEYS,
  type SpecValues,
} from "@/models/spec-columns";

import { buildFixture } from "../../../test/fixtures/import/build";
import { checked } from "../../../test/fixtures/import/checked";
import { cleanRow, type CleanedRow } from "./clean";
import { filtersFromSpecs, parseFilterNumbers } from "./numbers";
import { readWorkbook } from "./workbook";

/*
 * Zero CJK, checked by whole Unicode block (independent of the cleaner's
 * CJK_CLASS), so Script=Common CJK punctuation such as the katakana middle
 * dot U+30FB is caught too: Hangul Jamo, radicals/Kangxi/IDCs, U+3000-4DFF
 * (punctuation, kana, bopomofo, strokes, CJK compatibility, ext. A, Yijing),
 * unified ideographs, Hangul, compatibility ideographs, vertical and
 * compatibility forms, full- and half-width forms, supplementary ideographs.
 */
const CJK_CHECK =
  /[\u1100-\u11FF\u2E80-\u2FFF\u3000-\u4DFF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE10-\uFE1F\uFE30-\uFE4F\uFF00-\uFFEF\u{16FE0}-\u{16FFF}\u{1F200}-\u{1F2FF}\u{20000}-\u{323AF}]/u;

async function cleanedRows(bytes: Buffer): Promise<CleanedRow[]> {
  const read = await readWorkbook(await checked(bytes));
  if (!read.ok) throw new Error(JSON.stringify(read.warnings));
  return read.rows.map(cleanRow);
}

const RESTRICTED = new Set<string>(DEFAULT_RESTRICTED_SPEC_KEYS);

/* Every string a cleaned row carries, with the label a failure shows: the
 * value for public fields, only the key for restricted ones. */
function allStrings(row: CleanedRow): { label: string; value: string }[] {
  const fields: [string, string | null][] = [
    ["family", row.family],
    ["type", row.type],
    ["modelNo", row.modelNo],
    ["category", row.category],
    ...row.extraCategories.map((v): [string, string] => ["extraCategories", v]),
    ...row.areas.map((v): [string, string] => ["areas", v]),
    ...Object.entries(row.specs).flatMap(([key, list]) =>
      (list ?? []).map((v): [string, string] => [key, v]),
    ),
  ];
  return fields.flatMap(([key, value]) =>
    value === null
      ? []
      : [
          {
            value,
            label: `row ${row.row} ${key}${RESTRICTED.has(key) ? " (restricted)" : `: ${JSON.stringify(value)}`}`,
          },
        ],
  );
}

/* The public specs of a row; restricted ones never reach an assertion diff. */
function publicSpecs(specs: SpecValues): SpecValues {
  return Object.fromEntries(
    Object.entries(specs).filter(([key]) => !RESTRICTED.has(key)),
  );
}

function expectNoCjk(rows: CleanedRow[]): void {
  const offending = rows.flatMap((row) =>
    allStrings(row)
      .filter(({ value }) => CJK_CHECK.test(value))
      .map(({ label }) => label),
  );
  expect(offending).toEqual([]);
  expect(
    rows
      .flatMap((row) => row.warnings)
      .filter((w) => w.code === "cjk_only_cell"),
  ).toEqual([]);
}

/* No. 76's public values that both variants share (plan "Golden No. 76"). */
const SHARED_76 = {
  housingMaterial: ["Die Casting Aluminium + PC"],
  housingFinish: ["White", "Black"],
  cutOutSize: ["Ø90mm"],
  dimensions: ["D100*H110mm"],
  cct: ["3000K", "4000K"],
  cri: [">90"],
  beamAngle: ["20°", "30°", "40°", "60°"],
  wattage: ["12W"],
  powerFactor: ["0.9"],
  sdcm: ["≤3"],
  lifespan: ["50,000 hrs"],
  ipRating: ["IP20"],
};

/* The keys whose value differs between AR-013A1 and AR-013A2. */
const PER_VARIANT = new Set([
  "lens",
  "reflector",
  "lumenOutput",
  "lumenEfficiency",
]);

function expectGolden76(rows: CleanedRow[], voltage: string): void {
  const [a1, a2] = rows;
  expect(a1?.productNo).toEqual({ status: "ok", value: 76 });
  expect(a2?.productNo).toEqual({ status: "continuation" });
  expect([a1?.modelNo, a2?.modelNo]).toEqual(["AR-013A1", "AR-013A2"]);
  for (const row of [a1, a2]) {
    expect(row?.family).toBe("Arc");
    expect(row?.type).toBe("Pull-Down Spot Light Trim Round 1 Head");
    expect(publicSpecs(row?.specs ?? {})).toMatchObject({
      ...SHARED_76,
      voltageInput: [voltage],
    });
  }
  expect(a1?.specs.lens).toEqual(["Regular Lens"]);
  expect(a1?.specs.reflector).toBeUndefined();
  expect(a2?.specs.lens).toBeUndefined();
  expect(a2?.specs.reflector).toEqual(["High Effciency Reflector"]);
  expect([a1?.specs.lumenOutput, a2?.specs.lumenOutput]).toEqual([
    ["1140 LM"],
    ["1200 LM"],
  ]);
  expect([a1?.specs.lumenEfficiency, a2?.specs.lumenEfficiency]).toEqual([
    ["95±"],
    ["100±"],
  ]);
  // Every other key, restricted ones included, is equal on both rows. Only
  // the differing keys are reported, never their values.
  const differing = SPEC_KEYS.filter(
    (key) =>
      !PER_VARIANT.has(key) &&
      !isDeepStrictEqual(a1?.specs[key], a2?.specs[key]),
  );
  expect(differing).toEqual([]);
  // The two restricted columns filled on No. 76 survive cleaning (keys only).
  const missing = (["chipType", "driver"] as const).filter(
    (key) => a1?.specs[key] === undefined || a2?.specs[key] === undefined,
  );
  expect(missing).toEqual([]);
}

describe("cleaning the synthetic fixture", () => {
  it("leaves no CJK in any value and no CJK-only cell", async () => {
    const rows = await cleanedRows(await buildFixture());
    expect(rows).toHaveLength(12);
    expectNoCjk(rows);
  });

  it("gives No. 76 its golden values", async () => {
    const rows = await cleanedRows(await buildFixture());
    expectGolden76(rows.slice(0, 2), "AC220-240V");
  });

  it("reports Nos. 80/81 rows with no model no. as null (T4 flags them)", async () => {
    const rows = await cleanedRows(await buildFixture());
    expect(rows.slice(8).map((r) => r.modelNo)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});

// A test-only path override; nothing secret (plan decision 1).
// eslint-disable-next-line no-restricted-properties
const override = process.env.IMPORT_FIXTURE;
const fixturePath = resolve(
  override && override.trim() !== ""
    ? override
    : "doc/reference/client-sample-sheet.xlsx",
);
const present = existsSync(fixturePath);

describe.skipIf(!present)("cleaning the client's real sheet", () => {
  const bytes = present ? readFileSync(fixturePath) : Buffer.alloc(0);

  it("leaves no CJK in any value and no CJK-only cell", async () => {
    expectNoCjk(await cleanedRows(bytes));
  });

  it("gives No. 76 its golden values", async () => {
    const rows = await cleanedRows(bytes);
    expectGolden76(rows.slice(0, 2), "220-240V");
  });

  it("raises no cleaning warning at all", async () => {
    const rows = await cleanedRows(bytes);
    expect(rows.flatMap((row) => row.warnings).map((w) => w.code)).toEqual([]);
  });
});

/* Filters: No. 76's numbers, and no filter value either sheet can't parse. */
async function expectFilters(bytes: Buffer): Promise<void> {
  const rows = await cleanedRows(bytes);
  const unparsed = rows.flatMap((row) =>
    SPEC_KEYS.flatMap(
      (key) => parseFilterNumbers(key, row.specs[key] ?? null, row).warnings,
    ),
  );
  expect(unparsed).toEqual([]);
  expect(filtersFromSpecs(rows.slice(0, 2).map((row) => row.specs))).toEqual({
    cctK: [3000, 4000],
    cri: [90],
    beamDeg: [20, 30, 40, 60],
    wattage: [12],
    ip: [20],
  });
}

describe("filter numbers of whole sheets", () => {
  it("synthetic fixture: No. 76 filters, nothing unparsed", async () => {
    await expectFilters(await buildFixture());
  });

  it.skipIf(!present)(
    "real sheet: No. 76 filters, nothing unparsed",
    async () => {
      await expectFilters(readFileSync(fixturePath));
    },
  );
});
