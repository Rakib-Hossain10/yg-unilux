// Tests for the pure catalog view helpers: the variant merge rule, the spec
// allow-list copy, the projections built from column visibility and the
// lean-document mapping (plain data, no datasheet id, no restricted key).

import { Types } from "mongoose";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  restrictedSpecKeys,
  SPEC_KEYS,
  type SpecKey,
} from "@/models/spec-columns";

import {
  mergeVariantSpecs,
  pickSpecs,
  PRODUCT_CARD_PROJECTION,
  publicProductProjection,
  publicSpecKeys,
  toProductCardView,
  toPublicProductView,
  type ProductCardView,
  type PublicProductView,
} from "./view";

const ALL_PUBLIC = Object.fromEntries(
  SPEC_KEYS.map((key) => [key, "public"]),
) as Record<SpecKey, "public">;
const ALL_RESTRICTED = Object.fromEntries(
  SPEC_KEYS.map((key) => [key, "restricted"]),
) as Record<SpecKey, "restricted">;

describe("mergeVariantSpecs", () => {
  it("takes the variant's value when it has one, else the product's", () => {
    expect(
      mergeVariantSpecs(
        { cct: ["3000K", "4000K"], lens: ["PC"], wattage: ["10W"] },
        { lens: ["PMMA"], lumenOutput: ["900lm"] },
      ),
    ).toEqual({
      lens: ["PMMA"],
      cct: ["3000K", "4000K"],
      wattage: ["10W"],
      lumenOutput: ["900lm"],
    });
  });

  it("treats an empty variant list as 'not set' and keeps the product value", () => {
    expect(mergeVariantSpecs({ cri: ["Ra90"] }, { cri: [] })).toEqual({
      cri: ["Ra90"],
    });
  });

  it("leaves keys absent from both out, and handles missing objects", () => {
    expect(mergeVariantSpecs(undefined, undefined)).toEqual({});
    expect(mergeVariantSpecs(null, { ugr: ["<19"] })).toEqual({ ugr: ["<19"] });
    expect(Object.keys(mergeVariantSpecs({ ugr: [] }, {}))).toEqual([]);
  });

  it("returns keys in sheet order and copies the arrays", () => {
    const product = { warrantyPeriod: ["5 years"], housingMaterial: ["Al"] };
    const merged = mergeVariantSpecs(product, {});
    expect(Object.keys(merged)).toEqual(["housingMaterial", "warrantyPeriod"]);
    expect(merged.housingMaterial).not.toBe(product.housingMaterial);
  });
});

describe("pickSpecs", () => {
  it("copies only allowed keys with non-empty string values", () => {
    expect(
      pickSpecs({ driver: ["Lifud"], cct: ["3000K"], cri: [], lens: ["PC"] }, [
        "cct",
        "cri",
      ]),
    ).toEqual({ cct: ["3000K"] });
  });

  it("drops unknown keys and non-string entries", () => {
    const raw = { cct: ["3000K", 7, ""], secret: ["x"] } as unknown as Record<
      SpecKey,
      string[]
    >;
    expect(pickSpecs(raw, SPEC_KEYS)).toEqual({ cct: ["3000K"] });
  });
});

describe("projections from visibility", () => {
  it("lists exactly the public spec keys, at product and variant level", () => {
    const keys = publicSpecKeys({});
    const projection = publicProductProjection(keys);
    for (const key of SPEC_KEYS) {
      const isPublic = !restrictedSpecKeys({}).includes(key);
      expect(projection[`specs.${key}`] === 1).toBe(isPublic);
      expect(projection[`variants.specs.${key}`] === 1).toBe(isPublic);
    }
  });

  it("never loads a whole specs object, filters, status or admin fields", () => {
    const projection = publicProductProjection(publicSpecKeys(ALL_PUBLIC));
    for (const path of [
      "specs",
      "variants",
      "variants.specs",
      "filters",
      "status",
      "featured",
      "images",
      "images.sourceSha256",
    ]) {
      expect(projection).not.toHaveProperty([path]);
    }
    expect(Object.values(projection).every((v) => v === 1)).toBe(true);
  });

  it("has no spec path at all when every column is restricted", () => {
    const projection = publicProductProjection(publicSpecKeys(ALL_RESTRICTED));
    expect(Object.keys(projection).some((p) => p.includes("specs."))).toBe(
      false,
    );
  });

  it("gives cards no spec, variant or datasheet path", () => {
    expect(
      Object.keys(PRODUCT_CARD_PROJECTION).filter((path) =>
        /specs|variants|datasheet|filters/.test(path),
      ),
    ).toEqual([]);
  });
});

describe("toPublicProductView", () => {
  const id = new Types.ObjectId();
  const category = new Types.ObjectId();
  const doc = {
    _id: id,
    name: "Arc",
    slug: "arc-ar-013a",
    family: "Arc",
    mainCategory: category,
    extraCategories: [],
    areas: [],
    images: [
      { publicId: "p/b", order: 1, kind: "dimension" as const },
      { publicId: "p/a", order: 0, kind: "gallery" as const, alt: "Front" },
    ],
    specs: { cct: ["3000K"], driver: ["Lifud"] },
    variants: [
      { modelNo: "AR-013A1", specs: { lens: ["PC"], chipType: ["COB"] } },
    ],
    extraSpecs: [],
    publicFiles: [],
    datasheetId: new Types.ObjectId(),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
  };

  it("maps to plain data that survives a JSON round trip", () => {
    const view = toPublicProductView(doc, publicSpecKeys({}), []);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(view.id).toBe(id.toHexString());
    expect(view.mainCategoryId).toBe(category.toHexString());
    expect(view.updatedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(view.images.map((image) => image.publicId)).toEqual(["p/a", "p/b"]);
  });

  it("keeps only a datasheet boolean, never the id", () => {
    const view = toPublicProductView(doc, publicSpecKeys({}), []);
    expect(view.hasDatasheet).toBe(true);
    expect(JSON.stringify(view)).not.toContain(doc.datasheetId.toHexString());
    expect(
      toPublicProductView({ ...doc, datasheetId: null }, [], []).hasDatasheet,
    ).toBe(false);
  });

  it("drops restricted keys even if the document still had them", () => {
    const view = toPublicProductView(doc, publicSpecKeys({}), []);
    expect(view.specs).toEqual({ cct: ["3000K"] });
    expect(view.variants[0]?.specs).toEqual({ lens: ["PC"], cct: ["3000K"] });
  });

  it("picks the first gallery image for a card", () => {
    const card = toProductCardView(doc);
    expect(card.image?.publicId).toBe("p/a");
    expect(toProductCardView({ ...doc, images: [] }).image).toBeNull();
  });

  it("has no datasheet id, filters or status in its types", () => {
    expectTypeOf<PublicProductView>().not.toHaveProperty("datasheetId");
    expectTypeOf<PublicProductView>().not.toHaveProperty("filters");
    expectTypeOf<PublicProductView>().not.toHaveProperty("status");
    expectTypeOf<ProductCardView>().not.toHaveProperty("specs");
    expectTypeOf<ProductCardView>().not.toHaveProperty("variants");
  });
});
