// Tests for the orphan clean-up selection logic (src/lib/orphan-sweep.ts) with
// fake listings and a fake delete function. No network, no database.

import { describe, expect, it, vi } from "vitest";

import packageJson from "../package.json";
import {
  applySelection,
  checkMassDelete,
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

  it("reads --max-delete N in either order with --apply", () => {
    expect(parseSweepArgs(["--apply", "--max-delete", "50"])).toEqual({
      apply: true,
      maxDelete: 50,
    });
    expect(parseSweepArgs(["--max-delete", "1", "--apply"])).toEqual({
      apply: true,
      maxDelete: 1,
    });
    // Allowed in a dry run: it previews whether --apply would pass.
    expect(parseSweepArgs(["--max-delete", "7"])).toEqual({
      apply: false,
      maxDelete: 7,
    });
  });

  it.each([
    [["--max-delete"]],
    [["--max-delete", "0"]],
    [["--max-delete", "-3"]],
    [["--max-delete", "05"]],
    [["--max-delete", "2.5"]],
    [["--max-delete", "1e3"]],
    [["--max-delete", " 4"]],
    [["--max-delete", "abc"]],
    [["--max-delete", "--apply"]],
    [["--max-delete", "9999999999"]],
    [["--max-delete=5"]],
    [["--max-delete", "5", "--max-delete", "6"]],
  ])("rejects a malformed or repeated --max-delete: %j", (argv) => {
    expect(parseSweepArgs(argv)).toEqual({ error: expect.any(String) });
  });
});

describe("checkMassDelete", () => {
  const images = { maxShare: 0.2 };
  const incoming = { maxCount: 100 };

  it("allows an empty selection, even with an empty reference set", () => {
    expect(
      checkMassDelete({ selected: 0, listed: 0, referenced: 0 }, images),
    ).toEqual({ ok: true });
  });

  it("refuses when the reference set is empty", () => {
    const verdict = checkMassDelete(
      { selected: 1, listed: 100, referenced: 0 },
      images,
    );
    expect(verdict.ok).toBe(false);
  });

  it("allows exactly 20% and refuses just above it", () => {
    expect(
      checkMassDelete({ selected: 20, listed: 100, referenced: 80 }, images),
    ).toEqual({ ok: true });
    const verdict = checkMassDelete(
      { selected: 21, listed: 100, referenced: 79 },
      images,
    );
    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringMatching(/20%/),
    });
  });

  it("names the --max-delete override in the refusal", () => {
    const verdict = checkMassDelete(
      { selected: 30, listed: 100, referenced: 70 },
      images,
    );
    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining("--max-delete 30"),
    });
  });

  it("--max-delete overrides the share and empty-reference rules up to N", () => {
    expect(
      checkMassDelete(
        { selected: 90, listed: 100, referenced: 0, maxDelete: 90 },
        images,
      ),
    ).toEqual({ ok: true });
    expect(
      checkMassDelete(
        { selected: 91, listed: 100, referenced: 5, maxDelete: 90 },
        images,
      ).ok,
    ).toBe(false);
  });

  it("a selection above N is refused even when it would pass the share rule", () => {
    expect(
      checkMassDelete(
        { selected: 5, listed: 100, referenced: 95, maxDelete: 4 },
        images,
      ).ok,
    ).toBe(false);
  });

  it("incoming: an absolute cap instead of a share (no reference set)", () => {
    expect(checkMassDelete({ selected: 100, listed: 100 }, incoming)).toEqual({
      ok: true,
    });
    expect(checkMassDelete({ selected: 101, listed: 101 }, incoming).ok).toBe(
      false,
    );
    expect(
      checkMassDelete({ selected: 101, listed: 101, maxDelete: 101 }, incoming),
    ).toEqual({ ok: true });
  });

  it("a listing count of zero with a selection is refused (inconsistent input)", () => {
    expect(
      checkMassDelete({ selected: 1, listed: 0, referenced: 3 }, images).ok,
    ).toBe(false);
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
