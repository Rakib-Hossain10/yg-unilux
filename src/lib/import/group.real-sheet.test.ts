// Golden grouping test on the client's REAL sheet (local only, gitignored).
// Skipped loudly when the file is absent (CI), like workbook.real-sheet.test.
// Restricted columns are checked by key only; their values are never printed.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_RESTRICTED_SPEC_KEYS } from "@/models/spec-columns";

import { cleanRow } from "./clean";
import { groupRows, type GroupResult } from "./group";
import type { ImportProduct } from "./types";
import { readWorkbook } from "./workbook";

// A test-only path override; nothing secret (plan decision 1).
// eslint-disable-next-line no-restricted-properties
const override = process.env.IMPORT_FIXTURE;
const fixturePath = resolve(
  override && override.trim() !== ""
    ? override
    : "doc/reference/client-sample-sheet.xlsx",
);
const present = existsSync(fixturePath);

const RESTRICTED = new Set<string>(DEFAULT_RESTRICTED_SPEC_KEYS);

async function grouped(): Promise<GroupResult> {
  const read = await readWorkbook(readFileSync(fixturePath));
  if (!read.ok) throw new Error(JSON.stringify(read.warnings));
  return groupRows(read.rows.map(cleanRow), {
    categories: [],
    areas: [],
    defaultCategoryId: "default",
  });
}

describe.runIf(!present)("grouping the client's real sheet (missing)", () => {
  it("is not present, so the real-sheet grouping tests are SKIPPED", () => {
    process.stderr.write(
      `\n[import] REAL CLIENT SHEET NOT FOUND at ${fixturePath}: real-sheet grouping tests SKIPPED.\n`,
    );
    expect(present).toBe(false);
  });
});

describe.skipIf(!present)("grouping the client's real sheet", () => {
  it("gives No. 76 its golden shape", async () => {
    const p76 = (await grouped()).products.find(
      (p) => p.productNo === 76,
    ) as ImportProduct;

    expect(p76.blocked).toBe(false);
    expect(p76.warnings).toEqual([]);
    expect([p76.family, p76.baseModelCode, p76.slug, p76.name]).toEqual([
      "Arc",
      "AR-013A",
      "arc-ar-013a",
      "Arc AR-013A",
    ]);
    expect(p76.type).toBe("Pull-Down Spot Light Trim Round 1 Head");
    expect(p76.specs).toMatchObject({
      housingMaterial: ["Die Casting Aluminium + PC"],
      housingFinish: ["White", "Black"],
      cutOutSize: ["Ø90mm"],
      cct: ["3000K", "4000K"],
      cri: [">90"],
      beamAngle: ["20°", "30°", "40°", "60°"],
      voltageInput: ["220-240V"],
      wattage: ["12W"],
      powerFactor: ["0.9"],
      sdcm: ["≤3"],
      lifespan: ["50,000 hrs"],
      ipRating: ["IP20"],
    });
    expect(p76.specs.dimensions).toBeDefined();
    // Chip type and driver are shared (restricted: keys only).
    expect(
      (["chipType", "driver"] as const).filter(
        (k) => p76.specs[k] === undefined,
      ),
    ).toEqual([]);

    expect(p76.variants.map((v) => [v.modelNo, v.label])).toEqual([
      ["AR-013A1", "Regular Lens"],
      ["AR-013A2", "High Effciency Reflector"],
    ]);
    // Only the four golden keys differ, and none of them is restricted.
    const variantKeys = new Set(
      p76.variants.flatMap((v) => Object.keys(v.specs)),
    );
    expect([...variantKeys].sort()).toEqual([
      "lens",
      "lumenEfficiency",
      "lumenOutput",
      "reflector",
    ]);
    expect([...variantKeys].filter((k) => RESTRICTED.has(k))).toEqual([]);
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
  });

  it("imports Nos. 76-79 cleanly and blocks Nos. 80/81 for missing model nos.", async () => {
    const result = await grouped();
    expect(result.warnings).toEqual([]);
    expect(
      result.products.map((p) => [p.productNo, p.blocked, p.baseModelCode]),
    ).toEqual([
      [76, false, "AR-013A"],
      [77, false, "AR-013B"],
      [78, false, "AR-013C"],
      [79, false, "AR-013D"],
      [80, true, ""],
      [81, true, ""],
    ]);
    for (const product of result.products.slice(0, 4)) {
      expect(product.warnings.map((w) => w.code)).toEqual([]);
      expect(product.variants.map((v) => v.label)).toEqual([
        "Regular Lens",
        "High Effciency Reflector",
      ]);
    }
    for (const product of result.products.slice(4)) {
      const errors = product.warnings.filter((w) => w.severity === "error");
      expect(errors.map((w) => [w.code, w.row])).toEqual(
        product.rows.map((row) => ["missing_model_no", row]),
      );
    }
  });
});
