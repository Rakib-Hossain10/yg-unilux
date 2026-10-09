// Tests for the catalog data layer on an in-memory MongoDB (ADR 0063): no
// restricted key in any cached result for three visibility sets, published
// only, family/related/breadcrumb, cache tags, and the getRestrictedSpecs matrix.

import { Types } from "mongoose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SETTINGS_KEYS } from "@/lib/schemas/settings";
import {
  AreaModel,
  CategoryModel,
  ProductModel,
  SiteContentModel,
} from "@/models";
import {
  DEFAULT_RESTRICTED_SPEC_KEYS,
  restrictedSpecKeys,
  SPEC_KEYS,
  type SpecKey,
  type SpecValues,
  type SpecVisibility,
} from "@/models/spec-columns";
import type { Product } from "@/models/product";
import { setupMemoryDb } from "../../../test/helpers/memory-db";
import { testPublicId } from "../../../test/helpers/public-ids";

// unstable_cache needs Next's incremental cache; here it is a pass-through
// that records each wrapper's key parts and tags.
const cacheCalls = vi.hoisted(
  () => [] as { keyParts: string[]; tags: string[] }[],
);
vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...args: never[]) => Promise<unknown>,
    keyParts: string[],
    options: { tags?: string[] },
  ) => {
    cacheCalls.push({ keyParts, tags: options.tags ?? [] });
    return fn;
  },
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
}));

const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: getSession,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { getBreadcrumb, listPublicCategories } from "./categories";
import { getFamilyProducts } from "./family";
import { getPublicProduct, listPublishedSlugs } from "./product";
import { getRelatedProducts } from "./related";
import { getRestrictedSpecs } from "./restricted";
import type { PublicProductView } from "./view";

setupMemoryDb("yg_catalog_layer_test");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/* Every spec value is a unique token, so a leak shows up in any JSON. */
const token = (key: SpecKey, where: string) => `TOKEN-${key}-${where}-`;
const specsAt = (where: string): SpecValues =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, [token(key, where)]]));
const ALL_SPECS = specsAt("P");

const ids = {
  main: new Types.ObjectId(),
  sub: new Types.ObjectId(),
  other: new Types.ObjectId(),
  office: new Types.ObjectId(),
  retail: new Types.ObjectId(),
  arc: new Types.ObjectId(),
  arcTwo: new Types.ObjectId(),
  arcDraft: new Types.ObjectId(),
  single: new Types.ObjectId(),
  neighbour: new Types.ObjectId(),
  elsewhere: new Types.ObjectId(),
  datasheet: new Types.ObjectId(),
};

const IMAGE_ID = testPublicId(1);

type ProductSeed = Partial<Product> & Pick<Product, "_id" | "name" | "slug">;

function product(fields: ProductSeed): ProductSeed {
  return {
    mainCategory: ids.sub,
    status: "published",
    images: [{ publicId: IMAGE_ID, order: 0, kind: "gallery" }],
    ...fields,
  };
}

beforeAll(async () => {
  await CategoryModel.create([
    { _id: ids.main, name: "Spot Lights", slug: "spot-lights", parent: null },
    { _id: ids.sub, name: "Recessed", slug: "recessed", parent: ids.main },
    { _id: ids.other, name: "Track", slug: "track", parent: null },
  ]);
  await AreaModel.create([
    { _id: ids.retail, name: "Retail", slug: "retail", order: 1 },
    { _id: ids.office, name: "Office", slug: "office", order: 0 },
  ]);
  await ProductModel.create([
    product({
      _id: ids.arc,
      name: "Arc",
      slug: "arc-ar-013a",
      family: "Arc",
      modelCode: "AR-013A",
      productNo: 76,
      areas: [ids.retail, ids.office],
      specs: ALL_SPECS,
      variants: [
        {
          modelNo: "AR-013A1",
          label: "Lens",
          specs: specsAt("V1"),
        },
        { modelNo: "AR-013A2", label: "Reflector", specs: {} },
      ],
      extraSpecs: [{ label: "Note", value: "Public extra" }],
      publicFiles: [{ label: "Guide", url: "https://example.com/g.pdf" }],
      datasheetId: ids.datasheet,
    }),
    product({
      _id: ids.arcTwo,
      name: "Arc Two",
      slug: "arc-ar-014a",
      family: "Arc",
      productNo: 77,
      areas: [ids.office],
      specs: ALL_SPECS,
      variants: [{ modelNo: "AR-014A1" }],
    }),
    product({
      _id: ids.arcDraft,
      name: "Arc Draft",
      slug: "arc-ar-015a",
      family: "Arc",
      status: "draft",
      areas: [ids.office],
      specs: ALL_SPECS,
      variants: [{ modelNo: "AR-015A1" }],
    }),
    product({
      _id: ids.single,
      name: "Solo",
      slug: "solo-so-001",
      family: "Solo",
      areas: [ids.office],
      specs: ALL_SPECS,
      variants: [{ modelNo: "SO-001", specs: { lens: ["PMMA"] } }],
    }),
    product({
      _id: ids.neighbour,
      name: "Neighbour",
      slug: "neighbour-ne-001",
      family: "Neighbour",
      areas: [ids.retail],
      variants: [{ modelNo: "NE-001" }],
    }),
    product({
      _id: ids.elsewhere,
      name: "Elsewhere",
      slug: "elsewhere-el-001",
      family: "Elsewhere",
      mainCategory: ids.other,
      areas: [ids.office],
      variants: [{ modelNo: "EL-001" }],
    }),
  ]);
});

async function setVisibility(
  visibility: Record<SpecKey, SpecVisibility> | null,
): Promise<void> {
  const key = SETTINGS_KEYS.columnVisibility;
  if (visibility === null) await SiteContentModel.deleteOne({ key });
  else
    await SiteContentModel.updateOne(
      { key },
      { $set: { value: visibility }, $setOnInsert: { key } },
      { upsert: true },
    );
}

const every = (v: SpecVisibility) =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, v])) as Record<
    SpecKey,
    SpecVisibility
  >;

const VISIBILITY_SETS: [string, Record<SpecKey, SpecVisibility> | null][] = [
  ["default", null],
  ["all public", every("public")],
  ["all restricted", every("restricted")],
];

/* Every key of every nested object, so "absent as a key" is checked deeply. */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      allKeys(inner, out);
    }
  }
  return out;
}

function expectNoRestricted(value: unknown, restricted: readonly SpecKey[]) {
  const json = JSON.stringify(value);
  const keys = allKeys(value);
  for (const key of restricted) {
    expect(keys.has(key), `key ${key}`).toBe(false);
    expect(json.includes(`TOKEN-${key}-`), `value of ${key}`).toBe(false);
  }
}

function signedInAs(fields: Record<string, unknown> | null) {
  getSession.mockResolvedValue(
    fields === null
      ? null
      : {
          session: { id: "s1" },
          user: {
            id: "u1",
            role: "customer",
            banned: false,
            banExpires: null,
            mustChangePassword: false,
            accessExpiresAt: null,
            ...fields,
          },
        },
  );
}

beforeEach(async () => {
  getSession.mockReset();
  await setVisibility(null);
});

// ---------------------------------------------------------------------------
// Cached readers
// ---------------------------------------------------------------------------

describe.each(VISIBILITY_SETS)(
  "no restricted key in cached results (%s visibility)",
  (_label, visibility) => {
    const restricted =
      visibility === null
        ? [...DEFAULT_RESTRICTED_SPEC_KEYS]
        : restrictedSpecKeys(visibility);
    const publicKeys = SPEC_KEYS.filter((key) => !restricted.includes(key));

    beforeEach(async () => {
      await setVisibility(visibility);
    });

    it("getPublicProduct (N variants) carries public values only", async () => {
      const view = await getPublicProduct("arc-ar-013a");
      expect(view).not.toBeNull();
      expectNoRestricted(view, restricted);
      for (const key of publicKeys) {
        expect(view?.specs[key]).toEqual([token(key, "P")]);
        // Variant 1 overrides every key; variant 2 inherits the product's.
        expect(view?.variants[0]?.specs[key]).toEqual([token(key, "V1")]);
        expect(view?.variants[1]?.specs[key]).toEqual([token(key, "P")]);
      }
    });

    it("getPublicProduct (1 variant) carries public values only", async () => {
      const view = await getPublicProduct("solo-so-001");
      expect(view?.variants).toHaveLength(1);
      expectNoRestricted(view, restricted);
    });

    it("strips, slugs and breadcrumb hold no spec value at all", async () => {
      const view = (await getPublicProduct("arc-ar-013a")) as PublicProductView;
      const results = await Promise.all([
        getFamilyProducts(view.family, view.id),
        getRelatedProducts(view),
        listPublishedSlugs(),
        getBreadcrumb(view),
      ]);
      expectNoRestricted(results, SPEC_KEYS);
    });
  },
);

describe("getPublicProduct", () => {
  it("returns plain data for a published product", async () => {
    const view = await getPublicProduct("arc-ar-013a");
    expect(view).toMatchObject({
      id: ids.arc.toHexString(),
      name: "Arc",
      family: "Arc",
      modelCode: "AR-013A",
      productNo: 76,
      mainCategoryId: ids.sub.toHexString(),
      hasDatasheet: true,
      extraSpecs: [{ group: null, label: "Note", value: "Public extra" }],
      publicFiles: [{ label: "Guide", url: "https://example.com/g.pdf" }],
    });
    expect(view?.variants.map((v) => [v.modelNo, v.label])).toEqual([
      ["AR-013A1", "Lens"],
      ["AR-013A2", "Reflector"],
    ]);
    // Areas resolved in display order (Office has order 0).
    expect(view?.areas.map((a) => a.slug)).toEqual(["office", "retail"]);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(JSON.stringify(view)).not.toContain(ids.datasheet.toHexString());
  });

  it("merges a single variant's own value over the product's", async () => {
    const view = await getPublicProduct("solo-so-001");
    expect(view?.variants[0]?.specs.lens).toEqual(["PMMA"]);
    expect(view?.variants[0]?.specs.cct).toEqual([token("cct", "P")]);
    expect(view?.hasDatasheet).toBe(false);
  });

  it("is null for a draft, an unknown slug and a malformed slug", async () => {
    expect(await getPublicProduct("arc-ar-015a")).toBeNull();
    expect(await getPublicProduct("no-such-product")).toBeNull();
    expect(await getPublicProduct("Arc AR-013A")).toBeNull();
    expect(await getPublicProduct("")).toBeNull();
    expect(await getPublicProduct("a".repeat(500))).toBeNull();
  });

  it("answers a draft or unknown slug from the slug list, without a product entry (L-3)", async () => {
    const findOne = vi.spyOn(ProductModel, "findOne");
    expect(await getPublicProduct("arc-ar-015a")).toBeNull();
    expect(await getPublicProduct("no-such-product-123")).toBeNull();
    expect(findOne).not.toHaveBeenCalled();
    findOne.mockRestore();
  });
});

describe("listPublishedSlugs", () => {
  it("lists published slugs only, sorted, with ISO dates", async () => {
    const slugs = await listPublishedSlugs();
    expect(slugs.map((s) => s.slug)).toEqual([
      "arc-ar-013a",
      "arc-ar-014a",
      "elsewhere-el-001",
      "neighbour-ne-001",
      "solo-so-001",
    ]);
    expect(slugs.every((s) => !Number.isNaN(Date.parse(s.updatedAt)))).toBe(
      true,
    );
  });
});

describe("getFamilyProducts", () => {
  it("excludes the product itself and drafts", async () => {
    const cards = await getFamilyProducts("Arc", ids.arc.toHexString());
    expect(cards.map((c) => c.slug)).toEqual(["arc-ar-014a"]);
    expect(cards[0]?.image?.publicId).toBe(IMAGE_ID);
  });

  it("is empty for a blank family or a malformed id", async () => {
    expect(await getFamilyProducts(null, ids.arc.toHexString())).toEqual([]);
    expect(await getFamilyProducts("  ", ids.arc.toHexString())).toEqual([]);
    expect(await getFamilyProducts("Arc", "not-an-id")).toEqual([]);
  });
});

describe("getRelatedProducts", () => {
  it("same main category + shared area, not self, family or drafts", async () => {
    const view = (await getPublicProduct("arc-ar-013a")) as PublicProductView;
    const cards = await getRelatedProducts(view);
    // Arc Two is the same family, Elsewhere another category, Draft a draft.
    expect(cards.map((c) => c.slug)).toEqual([
      "neighbour-ne-001",
      "solo-so-001",
    ]);
  });

  it("uses the main category alone when the product has no areas", async () => {
    const view = (await getPublicProduct("arc-ar-013a")) as PublicProductView;
    const cards = await getRelatedProducts({ ...view, areas: [] });
    expect(cards.map((c) => c.slug)).toEqual([
      "neighbour-ne-001",
      "solo-so-001",
    ]);
  });
});

describe("listPublicCategories", () => {
  it("carries the icon, cover and description (null when unset)", async () => {
    const icon = testPublicId(1, ids.main.toHexString(), "category");
    const cover = testPublicId(2, ids.main.toHexString(), "category");
    await CategoryModel.updateOne(
      { _id: ids.main },
      { $set: { icon, coverImage: cover, description: "Narrow beams." } },
    );
    const tree = await listPublicCategories();
    expect(tree.find((c) => c.id === ids.main.toHexString())).toEqual({
      id: ids.main.toHexString(),
      name: "Spot Lights",
      slug: "spot-lights",
      parentId: null,
      order: 0,
      icon,
      coverImage: cover,
      description: "Narrow beams.",
    });
    expect(tree.find((c) => c.id === ids.sub.toHexString())).toMatchObject({
      icon: null,
      coverImage: null,
      description: null,
    });
  });
});

describe("getBreadcrumb", () => {
  it("goes from the main category down to the product's category", async () => {
    expect(
      await getBreadcrumb({ mainCategoryId: ids.sub.toHexString() }),
    ).toEqual([
      { id: ids.main.toHexString(), name: "Spot Lights", slug: "spot-lights" },
      { id: ids.sub.toHexString(), name: "Recessed", slug: "recessed" },
    ]);
  });

  it("is empty for a category that no longer exists", async () => {
    expect(
      await getBreadcrumb({
        mainCategoryId: new Types.ObjectId().toHexString(),
      }),
    ).toEqual([]);
  });
});

describe("cache wrappers", () => {
  const tagsOf = (name: string) =>
    cacheCalls.find((call) => call.keyParts.includes(name))?.tags;

  it("tags the product entry with products and settings:columns", () => {
    expect(tagsOf("public-product")).toEqual(
      expect.arrayContaining(["products", "settings:columns"]),
    );
  });

  it("tags lists and strips with products, the tree with categories", () => {
    expect(tagsOf("published-slugs")).toEqual(["products"]);
    expect(tagsOf("family-products")).toEqual(["products"]);
    expect(tagsOf("related-products")).toEqual(["products"]);
    expect(tagsOf("categories")).toEqual(["categories"]);
  });

  it("never wraps the restricted reader", () => {
    expect(
      cacheCalls.some((call) => call.keyParts.join().includes("restrict")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getRestrictedSpecs: the access matrix
// ---------------------------------------------------------------------------

describe("getRestrictedSpecs", () => {
  const arcId = ids.arc.toHexString();
  const DAY = 86_400_000;

  it.each<[string, Record<string, unknown> | null]>([
    ["a visitor", null],
    [
      "a customer whose access expired",
      { accessExpiresAt: new Date(Date.now() - 1000) },
    ],
    ["a customer whose access ends right now", { accessExpiresAt: new Date() }],
    ["a banned customer", { banned: true }],
    ["a banned admin", { role: "admin", banned: true }],
    ["a customer on a temporary password", { mustChangePassword: true }],
    ["a user with another role", { role: "staff" }],
  ])("is null for %s and reads no product", async (_label, fields) => {
    signedInAs(fields);
    const findOne = vi.spyOn(ProductModel, "findOne");
    expect(await getRestrictedSpecs(arcId)).toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ["an active customer with no expiry", {}],
    [
      "a customer whose access ends tomorrow",
      { accessExpiresAt: new Date(Date.now() + DAY) },
    ],
    [
      "a customer whose timed ban has ended",
      { banned: true, banExpires: new Date(Date.now() - DAY) },
    ],
    ["the admin", { role: "admin" }],
    [
      "the admin with a past expiry date",
      { role: "admin", accessExpiresAt: new Date(Date.now() - DAY) },
    ],
  ])("returns the restricted values for %s", async (_label, fields) => {
    signedInAs(fields);
    const view = await getRestrictedSpecs(arcId);
    expect(view?.keys).toEqual([...DEFAULT_RESTRICTED_SPEC_KEYS]);
    for (const key of DEFAULT_RESTRICTED_SPEC_KEYS) {
      expect(view?.specs[key]).toEqual([token(key, "P")]);
      expect(view?.variants[0]?.specs[key]).toEqual([token(key, "V1")]);
      expect(view?.variants[1]?.specs[key]).toEqual([token(key, "P")]);
    }
    expect(view?.variants.map((v) => v.modelNo)).toEqual([
      "AR-013A1",
      "AR-013A2",
    ]);
  });

  it("returns only restricted columns, following the current setting", async () => {
    signedInAs({});
    await setVisibility({ ...every("public"), wattage: "restricted" });
    const view = await getRestrictedSpecs(arcId);
    expect(view?.keys).toEqual(["wattage"]);
    expect(Object.keys(view?.specs ?? {})).toEqual(["wattage"]);
    const json = JSON.stringify(view);
    for (const key of SPEC_KEYS.filter((k) => k !== "wattage")) {
      expect(json.includes(`TOKEN-${key}-`)).toBe(false);
    }
  });

  it("returns no values when nothing is restricted", async () => {
    signedInAs({ role: "admin" });
    await setVisibility(every("public"));
    const view = await getRestrictedSpecs(arcId);
    expect(view).toEqual({
      productId: arcId,
      keys: [],
      specs: {},
      variants: [
        { modelNo: "AR-013A1", specs: {} },
        { modelNo: "AR-013A2", specs: {} },
      ],
    });
  });

  it("is null for a draft or unknown product, even for the admin", async () => {
    signedInAs({ role: "admin" });
    expect(await getRestrictedSpecs(ids.arcDraft.toHexString())).toBeNull();
    expect(
      await getRestrictedSpecs(new Types.ObjectId().toHexString()),
    ).toBeNull();
  });

  it("is null for a malformed id without reading the session", async () => {
    signedInAs({ role: "admin" });
    for (const bad of ["", "xyz", "z".repeat(24), `${arcId}0`, "{}"]) {
      expect(await getRestrictedSpecs(bad)).toBeNull();
    }
    expect(getSession).not.toHaveBeenCalled();
  });

  it("propagates a session read failure instead of answering", async () => {
    getSession.mockRejectedValue(new Error("db down"));
    await expect(getRestrictedSpecs(arcId)).rejects.toThrow("db down");
  });
});
