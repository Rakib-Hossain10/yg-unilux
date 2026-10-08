// Tests for the product form schema and publishCheck (src/lib/schemas/
// product.ts): normalisation, caps, https-only links, unique model nos,
// strictness against mass assignment, and each publish blocker.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_EXTRA_SPECS,
  MAX_FILTER_VALUES,
  MAX_PRODUCT_NAME_LENGTH,
  MAX_PUBLIC_FILES,
  MAX_SPEC_OPTIONS,
  MAX_SPEC_VALUE_LENGTH,
  MAX_VARIANTS,
} from "@/lib/constants";
import { SPEC_KEYS } from "@/models/spec-columns";
import { testPublicId } from "../../../test/helpers/public-ids";

import {
  productImagesInputSchema,
  productInputSchema,
  publishCheck,
} from "./product";

const CAT = "64b7f0c2a1b2c3d4e5f60718";
const IMG = testPublicId(0, CAT);
const CAT2 = "64b7f0c2a1b2c3d4e5f60719";
const base = { name: "Arc", mainCategory: CAT };

/** Issue paths of a failed parse, joined with dots. */
function paths(input: unknown): string[] {
  const result = productInputSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
}

describe("productInputSchema", () => {
  it("accepts the minimum (name + main category) and fills defaults", () => {
    expect(productInputSchema.parse(base)).toEqual({
      name: "Arc",
      slug: "",
      modelCode: null,
      family: null,
      productNo: null,
      type: null,
      description: null,
      mainCategory: CAT,
      extraCategories: [],
      areas: [],
      trackSize: null,
      specs: {},
      filters: {},
      variants: [],
      extraSpecs: [],
      publicFiles: [],
      datasheetId: null,
      status: "draft",
    });
  });

  it("parses a full product", () => {
    const parsed = productInputSchema.parse({
      name: " Arc ",
      slug: "Arc-AR-013A",
      modelCode: "AR-013A",
      family: "Arc",
      productNo: 76,
      type: "Spot",
      description: "A spot light",
      mainCategory: CAT.toUpperCase(),
      extraCategories: [CAT2],
      areas: [CAT2],
      trackSize: 10,
      specs: { cct: ["3000K", " 4000K ", ""], driver: ["Lifud"], lens: [] },
      filters: { cctK: [3000, 4000], cri: [], wattage: [12] },
      variants: [
        {
          modelNo: " AR-013A1 ",
          label: "Lens",
          specs: { beamAngle: ["20°"] },
          imagePublicId: IMG,
        },
        { modelNo: "AR-013A2" },
      ],
      extraSpecs: [{ group: "Install", label: "Method", value: "Recessed" }],
      publicFiles: [{ label: "Guide", url: "https://example.com/g.pdf" }],
      datasheetId: CAT,
      status: "published",
    });
    expect(parsed.name).toBe("Arc");
    expect(parsed.slug).toBe("arc-ar-013a");
    expect(parsed.mainCategory).toBe(CAT);
    expect(parsed.specs).toEqual({
      cct: ["3000K", "4000K"],
      driver: ["Lifud"],
    });
    expect(parsed.filters).toEqual({ cctK: [3000, 4000], wattage: [12] });
    expect(parsed.variants[0]).toEqual({
      modelNo: "AR-013A1",
      label: "Lens",
      specs: { beamAngle: ["20°"] },
      imagePublicId: IMG,
    });
    expect(parsed.variants[1]).toEqual({
      modelNo: "AR-013A2",
      label: null,
      specs: {},
      imagePublicId: null,
    });
    expect(parsed.trackSize).toBe(10);
    expect(parsed.datasheetId).toBe(CAT);
    expect(parsed.status).toBe("published");
  });

  it("accepts every one of the 28 spec keys, on product and variant", () => {
    expect(SPEC_KEYS).toHaveLength(28);
    const specs = Object.fromEntries(SPEC_KEYS.map((k) => [k, ["x"]]));
    const parsed = productInputSchema.parse({
      ...base,
      specs,
      variants: [{ modelNo: "A", specs }],
    });
    expect(Object.keys(parsed.specs)).toHaveLength(28);
    expect(Object.keys(parsed.variants[0]?.specs ?? {})).toHaveLength(28);
  });

  it("rejects missing or empty required fields", () => {
    expect(paths({ mainCategory: CAT })).toContain("name");
    expect(paths({ name: "  ", mainCategory: CAT })).toContain("name");
    expect(paths({ name: "Arc" })).toContain("mainCategory");
    expect(paths({ ...base, variants: [{ modelNo: " " }] })).toContain(
      "variants.0.modelNo",
    );
  });

  it("rejects bad ids, including 12-character strings", () => {
    expect(paths({ ...base, mainCategory: "abcdefghijkl" })).toContain(
      "mainCategory",
    );
    expect(paths({ ...base, areas: ["nope"] })).toContain("areas.0");
    expect(paths({ ...base, datasheetId: "zz" })).toContain("datasheetId");
    expect(
      paths({ ...base, extraCategories: [CAT, CAT.toUpperCase()] }),
    ).toContain("extraCategories");
  });

  it("allows only 5, 10 or 20 as trackSize, and null to clear", () => {
    expect(productInputSchema.parse({ ...base, trackSize: 20 }).trackSize).toBe(
      20,
    );
    expect(
      productInputSchema.parse({ ...base, trackSize: null }).trackSize,
    ).toBeNull();
    expect(paths({ ...base, trackSize: 7 })).toContain("trackSize");
    expect(paths({ ...base, trackSize: "10" })).toContain("trackSize");
  });

  it("validates productNo and filter numbers", () => {
    expect(paths({ ...base, productNo: 0 })).toContain("productNo");
    expect(paths({ ...base, productNo: 1.5 })).toContain("productNo");
    expect(paths({ ...base, filters: { cri: [-1] } })).toContain(
      "filters.cri.0",
    );
    expect(paths({ ...base, filters: { cri: [Number.NaN] } })).toContain(
      "filters.cri.0",
    );
    expect(paths({ ...base, filters: { cri: ["80"] } })).toContain(
      "filters.cri.0",
    );
    expect(paths({ ...base, filters: { cri: [Infinity] } })).toContain(
      "filters.cri.0",
    );
  });

  describe("variants", () => {
    it("refuses a repeated model no., case-insensitively, at the second row", () => {
      expect(
        paths({
          ...base,
          variants: [{ modelNo: "AR-013A1" }, { modelNo: "ar-013a1 " }],
        }),
      ).toEqual(["variants.1.modelNo"]);
    });

    it("uses the same key as the model and the index (full-width letters, ADR 0055)", () => {
      expect(
        paths({
          ...base,
          variants: [{ modelNo: "ＡＲ-013" }, { modelNo: "ar-013" }],
        }),
      ).toEqual(["variants.1.modelNo"]);
    });

    it("allows distinct model nos", () => {
      expect(
        productInputSchema.safeParse({
          ...base,
          variants: [{ modelNo: "A1" }, { modelNo: "A2" }],
        }).success,
      ).toBe(true);
    });
  });

  describe("public files", () => {
    const file = (url: string) => ({
      ...base,
      publicFiles: [{ label: "Guide", url }],
    });

    it("accepts https links", () => {
      expect(
        productInputSchema.safeParse(file("https://a.example/x.pdf")).success,
      ).toBe(true);
    });

    it.each([
      "http://a.example/x.pdf",
      "javascript:alert(1)",
      "data:text/html,hi",
      "//a.example/x",
      "ftp://a.example/x",
      "https://",
      "https://user:pw@a.example/x",
      "https://a b.example/x",
      "/relative.pdf",
    ])("rejects %s", (url) => {
      expect(paths(file(url))).toContain("publicFiles.0.url");
    });
  });

  describe("caps", () => {
    it("caps the name", () => {
      expect(
        productInputSchema.safeParse({
          ...base,
          name: "a".repeat(MAX_PRODUCT_NAME_LENGTH),
        }).success,
      ).toBe(true);
      expect(
        paths({ ...base, name: "a".repeat(MAX_PRODUCT_NAME_LENGTH + 1) }),
      ).toContain("name");
    });

    it("caps spec values and options", () => {
      expect(
        paths({
          ...base,
          specs: { cct: ["a".repeat(MAX_SPEC_VALUE_LENGTH + 1)] },
        }),
      ).toContain("specs.cct.0");
      expect(
        paths({
          ...base,
          specs: { cct: Array(MAX_SPEC_OPTIONS + 1).fill("3000K") },
        }),
      ).toContain("specs.cct");
    });

    it("caps list lengths", () => {
      expect(
        paths({
          ...base,
          filters: { cri: Array(MAX_FILTER_VALUES + 1).fill(80) },
        }),
      ).toContain("filters.cri");
      expect(
        paths({
          ...base,
          variants: Array.from({ length: MAX_VARIANTS + 1 }, (_, i) => ({
            modelNo: `M${i}`,
          })),
        }),
      ).toContain("variants");
      expect(
        paths({
          ...base,
          extraSpecs: Array(MAX_EXTRA_SPECS + 1).fill({
            label: "a",
            value: "b",
          }),
        }),
      ).toContain("extraSpecs");
      expect(
        paths({
          ...base,
          publicFiles: Array(MAX_PUBLIC_FILES + 1).fill({
            label: "a",
            url: "https://a.example/x",
          }),
        }),
      ).toContain("publicFiles");
    });

    it("requires label and value on extra specs", () => {
      expect(paths({ ...base, extraSpecs: [{ label: "a" }] })).toContain(
        "extraSpecs.0.value",
      );
      expect(paths({ ...base, extraSpecs: [{ value: "a" }] })).toContain(
        "extraSpecs.0.label",
      );
    });
  });

  describe("strictness (mass assignment)", () => {
    it.each([
      "images",
      "featured",
      "_id",
      "createdAt",
      "updatedAt",
      "__v",
      "role",
    ])("refuses a top-level %s", (key) => {
      expect(
        productInputSchema.safeParse({ ...base, [key]: "x" }).success,
      ).toBe(false);
    });

    it("refuses unknown keys inside specs, filters and list items", () => {
      expect(paths({ ...base, specs: { unknown: ["x"] } })).toEqual(["specs"]);
      expect(paths({ ...base, filters: { lumen: [1] } })).toEqual(["filters"]);
      expect(
        paths({ ...base, variants: [{ modelNo: "A", order: 1 }] }),
      ).toEqual(["variants.0"]);
      expect(
        paths({ ...base, extraSpecs: [{ label: "a", value: "b", x: 1 }] }),
      ).toEqual(["extraSpecs.0"]);
      expect(
        paths({
          ...base,
          publicFiles: [{ label: "a", url: "https://a.example", x: 1 }],
        }),
      ).toEqual(["publicFiles.0"]);
    });

    it("refuses an unknown status", () => {
      expect(paths({ ...base, status: "archived" })).toContain("status");
    });
  });
});

describe("publishCheck", () => {
  const ready = { mainCategory: CAT, variants: [{}], images: [{}] };

  it("returns no problems for a complete product", () => {
    expect(publishCheck(ready)).toEqual([]);
  });

  it("flags a missing variant", () => {
    expect(
      publishCheck({ ...ready, variants: [] }).map((p) => p.field),
    ).toEqual(["variants"]);
  });

  it("flags a missing main category", () => {
    expect(
      publishCheck({ ...ready, mainCategory: undefined }).map((p) => p.field),
    ).toEqual(["mainCategory"]);
    expect(
      publishCheck({ ...ready, mainCategory: null }).map((p) => p.field),
    ).toEqual(["mainCategory"]);
  });

  it("flags a missing image", () => {
    expect(publishCheck({ ...ready, images: [] }).map((p) => p.field)).toEqual([
      "images",
    ]);
  });

  it("lists every problem at once, in a stable order", () => {
    const problems = publishCheck({ variants: [], images: [] });
    expect(problems.map((p) => p.field)).toEqual([
      "variants",
      "mainCategory",
      "images",
    ]);
    expect(problems.every((p) => p.message.length > 0)).toBe(true);
  });
});

describe("client safety", () => {
  it("imports nothing server-only (db, the product model, server-only)", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/schemas/product.ts"),
      "utf8",
    );
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(specifiers).not.toContain("@/lib/db");
    expect(specifiers).not.toContain("@/models/product");
    expect(specifiers).not.toContain("server-only");
    expect(specifiers.every((s) => !s?.startsWith("@/lib/db"))).toBe(true);
  });
});

describe("variant imagePublicId (gate B L-C)", () => {
  it.each([
    ["free text", "products/ar-013a3"],
    ["a folder without owner and uuid", "yg/products/x/y"],
    ["uppercase", IMG.toUpperCase()],
    ["path traversal", `yg/products/${CAT}/../${CAT2}`],
    ["an extra segment", `${IMG}/x`],
    ["a URL", `https://res.cloudinary.com/demo/image/upload/${IMG}`],
  ])("refuses %s", (_label, imagePublicId) => {
    expect(
      paths({ ...base, variants: [{ modelNo: "A-1", imagePublicId }] }),
    ).toEqual(["variants.0.imagePublicId"]);
  });

  it("accepts our id shape and turns blank into null", () => {
    const parsed = productInputSchema.parse({
      ...base,
      variants: [
        { modelNo: "A-1", imagePublicId: ` ${IMG} ` },
        { modelNo: "A-2", imagePublicId: "" },
      ],
    });
    expect(parsed.variants.map((v) => v.imagePublicId)).toEqual([IMG, null]);
  });
});

describe("productImagesInputSchema", () => {
  const image = { publicId: IMG, alt: "Front view", kind: "gallery" };

  it("parses the ordered list and trims alt text", () => {
    expect(
      productImagesInputSchema.parse({
        productId: CAT,
        images: [{ ...image, alt: " Front view " }],
      }),
    ).toEqual({ productId: CAT, images: [image] });
  });

  it("accepts an empty list (remove every image of a draft)", () => {
    expect(
      productImagesInputSchema.parse({ productId: CAT, images: [] }).images,
    ).toEqual([]);
  });

  it.each([
    ["a missing alt", { ...image, alt: " " }, "images.0.alt"],
    ["an unknown kind", { ...image, kind: "hero" }, "images.0.kind"],
    ["a free-text id", { ...image, publicId: "x" }, "images.0.publicId"],
    ["an order key", { ...image, order: 3 }, "images.0"],
  ])("refuses %s", (_label, bad, path) => {
    const result = productImagesInputSchema.safeParse({
      productId: CAT,
      images: [bad],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain(path);
  });

  it("refuses the same image twice and more than the cap", () => {
    expect(
      productImagesInputSchema.safeParse({
        productId: CAT,
        images: [image, image],
      }).success,
    ).toBe(false);
    const many = Array.from({ length: 31 }, (_, n) => ({
      ...image,
      publicId: testPublicId(n, CAT),
    }));
    expect(
      productImagesInputSchema.safeParse({ productId: CAT, images: many })
        .success,
    ).toBe(false);
  });

  it("refuses a bad product id and unknown top-level keys", () => {
    expect(
      productImagesInputSchema.safeParse({ productId: "x", images: [] })
        .success,
    ).toBe(false);
    expect(
      productImagesInputSchema.safeParse({
        productId: CAT,
        images: [],
        status: "published",
      }).success,
    ).toBe(false);
  });
});
