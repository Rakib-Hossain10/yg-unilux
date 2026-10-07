// Pins the synthetic fixture's image structure to the real sheet's: standard
// xl/drawings with one oneCellAnchor per data row in column 6 (0-based col 5),
// four pictures, the same picture on all rows of two products.

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { FIXTURE_DATA_ROWS, buildFixture } from "./build";

describe("buildFixture images", () => {
  it("anchors one picture per data row, oneCell, in the Image column", async () => {
    const zip = await JSZip.loadAsync(await buildFixture());
    const media = Object.keys(zip.files).filter(
      (n) => n.startsWith("xl/media/") && !n.endsWith("/"),
    );
    expect(media).toHaveLength(4);

    const drawing = await zip.file("xl/drawings/drawing1.xml")?.async("string");
    expect(drawing).toBeDefined();
    const anchors = drawing?.match(/<xdr:oneCellAnchor\b/g) ?? [];
    expect(anchors).toHaveLength(FIXTURE_DATA_ROWS.length);
    expect(drawing).not.toContain("twoCellAnchor");

    const from = [
      ...(drawing ?? "").matchAll(
        /<xdr:from><xdr:col>(\d+)<\/xdr:col>.*?<xdr:row>(\d+)<\/xdr:row>/g,
      ),
    ].map((m) => [Number(m[1]), Number(m[2]) + 1]);
    expect(from.every(([col]) => col === 5)).toBe(true);
    expect(from.map(([, row]) => row)).toEqual(FIXTURE_DATA_ROWS);

    // Rows 3-6 (Nos. 76+77) share one picture: one relationship id.
    const embeds = [...(drawing ?? "").matchAll(/r:embed="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(embeds.slice(0, 4)).size).toBe(1);
    expect(new Set(embeds.slice(4, 8)).size).toBe(1);
    expect(embeds[0]).not.toBe(embeds[4]);
  });
});
