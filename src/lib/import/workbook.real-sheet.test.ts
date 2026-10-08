// Reads the client's REAL sheet (local only, gitignored; never committed) and
// checks its structure: safety passes, 33 headers map, 12 data rows with
// Excel's row numbers. Skipped loudly when the file is not present (CI).
// Assertions touch only structure and public identity columns, never values
// of restricted columns.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SPEC_KEYS } from "@/models/spec-columns";

import { checked, digestsOf } from "../../../test/fixtures/import/checked";
import { checkImportFile } from "./safety";
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

// Vitest drops module-level logs of a skipped file and hides console logs of
// passing tests, so the notice is its own test writing straight to stderr.
describe.runIf(!present)("the client's real sheet (missing)", () => {
  it("is not present, so the real-sheet tests are SKIPPED", () => {
    process.stderr.write(
      `\n[import] REAL CLIENT SHEET NOT FOUND at ${fixturePath}: real-sheet tests SKIPPED.\n` +
        "         Put the client's sheet there (gitignored) or set IMPORT_FIXTURE.\n",
    );
    expect(present).toBe(false);
  });
});

describe.skipIf(!present)("the client's real sheet", () => {
  const bytes = present ? readFileSync(fixturePath) : Buffer.alloc(0);

  it("passes the safety check", async () => {
    expect((await checkImportFile(bytes)).ok).toBe(true);
  });

  it("reaches the parsers unchanged: every part of the checked file is the original's", async () => {
    // The range guard (gate A M-1) found nothing to strip or refuse, and the
    // rewritten zip holds the same parts byte for byte, so exceljs and the
    // image reader read the sheet exactly as before.
    const guarded = digestsOf((await checked(bytes)).bytes);
    expect(guarded).toEqual(digestsOf(bytes));
  });

  it("maps all 33 headers on row 1 of Sheet1, with no warnings", async () => {
    const result = await readWorkbook(await checked(bytes));
    if (!result.ok) throw new Error(JSON.stringify(result.warnings));
    expect(result.sheets).toHaveLength(1);
    const [sheet] = result.sheets;
    expect(sheet?.name).toBe("Sheet1");
    expect(sheet?.headerRow).toBe(1);
    const keys = sheet?.columns.map((c) => c.key) ?? [];
    expect(keys).toHaveLength(33);
    expect(new Set(keys)).toEqual(
      new Set([
        "productNo",
        "family",
        "type",
        "modelNo",
        "image",
        ...SPEC_KEYS,
      ]),
    );
    expect(result.warnings).toEqual([]);
  });

  it("reads 12 data rows with Excel's row numbers (blank row 2 skipped)", async () => {
    const result = await readWorkbook(await checked(bytes));
    if (!result.ok) throw new Error(JSON.stringify(result.warnings));
    expect(result.rows.map((r) => r.row)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    const firstRows = result.rows.filter((r) => r.cells.productNo);
    expect(firstRows.map((r) => [r.row, r.cells.productNo])).toEqual([
      [3, "76"],
      [5, "77"],
      [7, "78"],
      [9, "79"],
      [11, "80"],
      [13, "81"],
    ]);
    expect(result.rows.map((r) => r.cells.modelNo ?? null)).toEqual([
      "AR-013A1",
      "AR-013A2",
      "AR-013B1",
      "AR-013B2",
      "AR-013C1",
      "AR-013C2",
      "AR-013D1",
      "AR-013D2",
      null,
      null,
      null,
      null,
    ]);
  });
});
