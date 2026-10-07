// Tests for the orphan clean-up selection logic (src/lib/orphan-sweep.ts) with
// fake listings and a fake delete function. No network, no database.

import { describe, expect, it, vi } from "vitest";

import packageJson from "../package.json";
import {
  applySelection,
  collectReferencedImageIds,
  parseSweepArgs,
  selectOrphanDatasheetObjects,
  selectOrphanImages,
  selectStaleIncoming,
} from "../src/lib/orphan-sweep";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const OID_A = "a".repeat(24);
const OID_B = "b".repeat(24);
const UUID_1 = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";
const UUID_3 = "33333333-3333-4333-8333-333333333333";
const prod = (o: string, u: string) => `yg/products/${o}/${u}`;
const area = (o: string, u: string) => `yg/areas/${o}/${u}`;

describe("selectStaleIncoming", () => {
  it("selects only objects strictly older than 24 h (boundary)", () => {
    const keys = selectStaleIncoming(
      [
        { key: "incoming/exact", lastModified: ago(24 * HOUR) },
        { key: "incoming/just-over", lastModified: ago(24 * HOUR + 1) },
        { key: "incoming/young", lastModified: ago(HOUR) },
      ],
      NOW,
    );
    expect(keys).toEqual(["incoming/just-over"]);
  });

  it("never selects keys outside incoming/ or without a known age", () => {
    const keys = selectStaleIncoming(
      [
        { key: "datasheets/x.xlsx", lastModified: ago(100 * HOUR) },
        { key: "incoming-evil/x", lastModified: ago(100 * HOUR) },
        { key: "incoming/", lastModified: ago(100 * HOUR) },
        { key: "incoming/no-date", lastModified: undefined },
        { key: "incoming/bad-date", lastModified: new Date("nope") },
        { key: "incoming/old", lastModified: ago(100 * HOUR) },
      ],
      NOW,
    );
    expect(keys).toEqual(["incoming/old"]);
  });

  it("selects across every page of a combined listing", () => {
    const pages = [
      [{ key: "incoming/a", lastModified: ago(30 * HOUR) }],
      [{ key: "incoming/b", lastModified: ago(30 * HOUR) }],
      [{ key: "incoming/c", lastModified: ago(HOUR) }],
    ];
    expect(selectStaleIncoming(pages.flat(), NOW)).toEqual([
      "incoming/a",
      "incoming/b",
    ]);
  });
});

describe("selectOrphanImages", () => {
  const old = ago(48 * HOUR);

  it("selects unreferenced, old, well-formed ids in our folders only", () => {
    const referenced = new Set([prod(OID_A, UUID_1)]);
    const selected = selectOrphanImages(
      [
        { publicId: prod(OID_A, UUID_1), createdAt: old },
        { publicId: prod(OID_A, UUID_2), createdAt: old },
        { publicId: area(OID_B, UUID_3), createdAt: old },
        { publicId: `yg/leaders/${OID_A}/${UUID_1}`, createdAt: old },
        { publicId: "yg/products/hand-made", createdAt: old },
        { publicId: "other/folder/x", createdAt: old },
      ],
      referenced,
      NOW,
    );
    expect(selected).toEqual([prod(OID_A, UUID_2), area(OID_B, UUID_3)]);
  });

  it("keeps assets inside the safety window and assets of unknown age", () => {
    const selected = selectOrphanImages(
      [
        { publicId: prod(OID_A, UUID_1), createdAt: ago(24 * HOUR) },
        { publicId: prod(OID_A, UUID_2), createdAt: ago(HOUR) },
        { publicId: prod(OID_A, UUID_3), createdAt: undefined },
        { publicId: area(OID_B, UUID_1), createdAt: ago(24 * HOUR + 1) },
      ],
      new Set(),
      NOW,
    );
    expect(selected).toEqual([area(OID_B, UUID_1)]);
  });

  it("treats images of a deleted product as orphans", () => {
    const referenced = collectReferencedImageIds({
      products: [{ images: [{ publicId: prod(OID_B, UUID_1) }] }],
      areas: [],
    });
    expect(
      selectOrphanImages(
        [
          { publicId: prod(OID_A, UUID_1), createdAt: old },
          { publicId: prod(OID_B, UUID_1), createdAt: old },
        ],
        referenced,
        NOW,
      ),
    ).toEqual([prod(OID_A, UUID_1)]);
  });
});

describe("collectReferencedImageIds", () => {
  it("collects product images, variant images and area images", () => {
    const ids = collectReferencedImageIds({
      products: [
        {
          images: [{ publicId: "a" }, { publicId: "b" }],
          variants: [{ imagePublicId: "c" }, {}],
        },
        {},
      ],
      areas: [{ bwImage: "d" }, {}],
    });
    expect([...ids].sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("selectOrphanDatasheetObjects", () => {
  it("reports unreferenced datasheets/ keys past the grace period", () => {
    const orphans = selectOrphanDatasheetObjects(
      [
        { key: "datasheets/kept.xlsx", lastModified: ago(10 * HOUR) },
        { key: "datasheets/orphan.xlsx", lastModified: ago(10 * HOUR) },
        { key: "datasheets/young.xlsx", lastModified: ago(60_000) },
        { key: "datasheets/exact.xlsx", lastModified: ago(HOUR) },
        { key: "datasheets/no-date.xlsx", lastModified: undefined },
        { key: "incoming/x", lastModified: ago(10 * HOUR) },
        { key: "datasheets/", lastModified: ago(10 * HOUR) },
      ],
      new Set(["datasheets/kept.xlsx"]),
      NOW,
    );
    expect(orphans).toEqual([
      "datasheets/orphan.xlsx",
      "datasheets/no-date.xlsx",
    ]);
  });
});

describe("applySelection", () => {
  it("dry run never calls remove", async () => {
    const remove = vi.fn(async () => true);
    const result = await applySelection(["a", "b"], false, remove);
    expect(remove).not.toHaveBeenCalled();
    expect(result).toEqual({ selected: ["a", "b"], deleted: [], failed: [] });
  });

  it("apply deletes exactly the selected ids and records failures", async () => {
    const remove = vi.fn(async (id: string) => {
      if (id === "bad") return false;
      if (id === "boom") throw new Error("secret detail");
      return true;
    });
    const result = await applySelection(
      ["a", "bad", "boom", "c"],
      true,
      remove,
    );
    expect(remove.mock.calls.map((call) => call[0])).toEqual([
      "a",
      "bad",
      "boom",
      "c",
    ]);
    expect(result.deleted).toEqual(["a", "c"]);
    expect(result.failed).toEqual(["bad", "boom"]);
  });

  it("treats a void return as success", async () => {
    const result = await applySelection(["a"], true, async () => {});
    expect(result.deleted).toEqual(["a"]);
  });
});

describe("parseSweepArgs", () => {
  it("is a dry run by default and --apply turns deletion on", () => {
    expect(parseSweepArgs([])).toEqual({ apply: false });
    expect(parseSweepArgs(["--apply"])).toEqual({ apply: true });
  });

  it("rejects anything else", () => {
    expect(parseSweepArgs(["--aply"])).toEqual({ error: expect.any(String) });
  });
});

describe("npm scripts", () => {
  it("are registered and load env like the other CLIs", () => {
    const scripts = packageJson.scripts as Record<string, string>;
    for (const name of [
      "sweep:incoming",
      "sweep:cloudinary",
      "report:datasheets",
    ]) {
      expect(scripts[name]).toMatch(
        /^node --conditions=react-server --env-file-if-exists=\.env\.local --import tsx scripts\/.+\.ts$/,
      );
    }
  });
});
