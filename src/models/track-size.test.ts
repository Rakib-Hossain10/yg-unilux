// Tests for the shared Magnetic Track rules (ADR 0041) in product-constants:
// which main category is Magnetic Track, and which subcategory slug implies a
// track size (Phase 3 import). Pure, no database.

import { describe, expect, it } from "vitest";

import {
  MAGNETIC_TRACK_SLUG,
  isMagneticTrackCategory,
  trackSizeFromSlug,
} from "./product-constants";

describe("isMagneticTrackCategory", () => {
  it("matches the slug or the name in any case", () => {
    expect(
      isMagneticTrackCategory({ slug: MAGNETIC_TRACK_SLUG, name: "Tracks" }),
    ).toBe(true);
    expect(
      isMagneticTrackCategory({ slug: "mt", name: " MAGNETIC track " }),
    ).toBe(true);
    expect(
      isMagneticTrackCategory({ slug: "spot-lights", name: "Spot Lights" }),
    ).toBe(false);
  });
});

describe("trackSizeFromSlug", () => {
  it.each([
    ["5mm", 5],
    ["10mm", 10],
    ["20mm", 20],
    ["10mm-track", 10],
    ["20mm-system", 20],
  ] as const)("%s → %i", (slug, size) => {
    expect(trackSizeFromSlug(slug)).toBe(size);
  });

  it.each(["15mm", "gobo", "linear", "5-mm", "50mm", "105mm", "mm5", "10mmx"])(
    "%s → null",
    (slug) => {
      expect(trackSizeFromSlug(slug)).toBeNull();
    },
  );
});
