// Image stage on the client's REAL sheet (local only, gitignored). Skipped
// loudly when the file is absent (CI), like the other real-sheet tests.
// The real sheet anchors twoCell (editAs="oneCell"), one picture per row:
// image1 on Nos. 76+77, image2 on 78+79, image3 on 80, image4 on 81.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { checked } from "../../../test/fixtures/import/checked";
import { cleanRow } from "./clean";
import { groupRows } from "./group";
import { attachImages, readEmbeddedImages } from "./images";
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

describe.runIf(!present)("images of the client's real sheet (missing)", () => {
  it("is not present, so the real-sheet image tests are SKIPPED", () => {
    process.stderr.write(
      `\n[import] REAL CLIENT SHEET NOT FOUND at ${fixturePath}: real-sheet image tests SKIPPED.\n`,
    );
    expect(present).toBe(false);
  });
});

describe.skipIf(!present)("images of the client's real sheet", () => {
  it("gives each product one gallery picture, shared pairwise like the sheet", async () => {
    const bytes = readFileSync(fixturePath);
    expect((await checkImportFile(bytes)).ok).toBe(true);
    const read = await readWorkbook(await checked(bytes));
    if (!read.ok) throw new Error(JSON.stringify(read.warnings));
    const grouped = groupRows(read.rows.map(cleanRow), {
      categories: [],
      areas: [],
      defaultCategoryId: "default",
    });
    const embedded = await readEmbeddedImages(
      await checked(bytes),
      read.sheets.map((s) => s.name),
    );

    expect(embedded.warnings).toEqual([]);
    expect(embedded.anchors.map((a) => [a.row, a.column])).toEqual(
      [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((row) => [row, 6]),
    );
    expect(embedded.anchors.every((a) => a.issue === null)).toBe(true);
    expect(embedded.files.size).toBe(4);
    for (const file of embedded.files.values()) {
      expect(file.format).toBe("png");
      expect(file.bytes).toBeLessThan(10 * 1024 * 1024);
    }

    const { products, warnings } = attachImages(grouped.products, embedded);
    expect(warnings).toEqual([]);
    const gallery = products.map((p) => [
      p.productNo,
      p.images.map((i) => i.row),
    ]);
    expect(gallery).toEqual([
      [76, [3]],
      [77, [5]],
      [78, [7]],
      [79, [9]],
      [80, [11]],
      [81, [13]],
    ]);
    const shaOf = (no: number) =>
      products.find((p) => p.productNo === no)?.images[0]?.sha256;
    expect(shaOf(76)).toBe(shaOf(77));
    expect(shaOf(78)).toBe(shaOf(79));
    expect(new Set([76, 78, 80, 81].map(shaOf)).size).toBe(4);
    for (const p of products) {
      expect(p.variants.every((v) => v.imageSha256 === null)).toBe(true);
      expect(p.warnings.filter((w) => /image/.test(w.code))).toEqual([]);
    }
  });
});
