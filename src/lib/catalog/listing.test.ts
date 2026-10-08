// Tests for the listing data layer on an in-memory MongoDB (ADR 0065): scope
// rule (main/extra/subtree), AND/OR filters, wattage buckets, restricted
// facets absent and their params ignored, drafts, pages, sorts, card shape,
// category paths (duplicate sub slugs, cycles), areas and cache keys.

import { Types } from "mongoose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SETTINGS_KEYS } from "@/lib/schemas/settings";
import {
  AreaModel,
  CategoryModel,
  ProductModel,
  SiteContentModel,
} from "@/models";
import type { Product, ProductFilters } from "@/models/product";
import {
  DEFAULT_RESTRICTED_SPEC_KEYS,
  SPEC_KEYS,
  type SpecKey,
  type SpecValues,
  type SpecVisibility,
} from "@/models/spec-columns";
import { setupMemoryDb } from "../../../test/helpers/memory-db";
import { testPublicId } from "../../../test/helpers/public-ids";

// unstable_cache as a pass-through that records each wrapper's key parts,
// tags and every call's arguments (the cache key's argument part).
const cache = vi.hoisted(() => ({
  wrappers: [] as { keyParts: string[]; tags: string[] }[],
  calls: [] as { name: string; args: unknown[] }[],
}));
vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    keyParts: string[],
    options: { tags?: string[] },
  ) => {
    cache.wrappers.push({ keyParts, tags: options.tags ?? [] });
    return (...args: unknown[]) => {
      cache.calls.push({ name: keyParts[1] ?? "", args });
      return fn(...args);
    };
  },
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
}));

import { getAreaBySlug, listPublicAreas } from "./areas";
import {
  categoryPathsIn,
  listCategoryPaths,
  resolveCategoryPath,
  resolveCategoryPathIn,
} from "./category-path";
import type { PublicCategoryView } from "./categories";
import { getFacets, type ListingFacets } from "./facets";
import {
  getCatalogVisibility,
  LISTING_PAGE_SIZE,
  listProducts,
} from "./listing";
import {
  DEFAULT_LISTING_PARAMS,
  parseListingParams,
  SPEC_FACET_PARAMS,
  type ListingParams,
} from "./listing-params";
import type { ListingScope } from "./listing-scope";
import type { VisibilityByKey } from "./view";

setupMemoryDb("yg_catalog_listing_test");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const token = (key: SpecKey, where: string) => `TOKEN-${key}-${where}-`;
const specsAt = (where: string): SpecValues =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, [token(key, where)]]));

const id = () => new Types.ObjectId();
const cat = {
  spot: id(),
  spotRecessed: id(),
  spotSurface: id(),
  down: id(),
  downRecessed: id(),
  track: id(),
  track10: id(),
  empty: id(),
  bulk: id(),
  cycleA: id(),
  cycleB: id(),
};
const area = { office: id(), retail: id(), hotel: id() };
const prod = {
  alpha: id(),
  bravo: id(),
  charlie: id(),
  delta: id(),
  echoDraft: id(),
  foxtrot: id(),
};

type Seed = Partial<Product> & Pick<Product, "_id" | "name" | "slug">;
function product(fields: Seed): Seed {
  return {
    status: "published",
    images: [{ publicId: testPublicId(1), order: 0, kind: "gallery" }],
    specs: specsAt("P"),
    ...fields,
  };
}
const variant = (modelNo: string) => ({ modelNo, specs: specsAt(modelNo) });
const BULK = 30;

beforeAll(async () => {
  await CategoryModel.create([
    {
      _id: cat.spot,
      name: "Spot Lights",
      slug: "spot-lights",
      parent: null,
      order: 0,
    },
    {
      _id: cat.spotRecessed,
      name: "Recessed",
      slug: "recessed",
      parent: cat.spot,
      order: 0,
    },
    {
      _id: cat.spotSurface,
      name: "Surface",
      slug: "surface",
      parent: cat.spot,
      order: 1,
    },
    {
      _id: cat.down,
      name: "Downlights",
      slug: "downlights",
      parent: null,
      order: 1,
    },
    // Same sub slug under another parent (unique among siblings only).
    {
      _id: cat.downRecessed,
      name: "Recessed",
      slug: "recessed",
      parent: cat.down,
      order: 0,
    },
    {
      _id: cat.track,
      name: "Magnetic Track",
      slug: "magnetic-track",
      parent: null,
      order: 2,
    },
    {
      _id: cat.track10,
      name: "10mm",
      slug: "10mm",
      parent: cat.track,
      order: 0,
    },
    { _id: cat.empty, name: "Empty", slug: "empty", parent: null, order: 3 },
    { _id: cat.bulk, name: "Bulk", slug: "bulk", parent: null, order: 4 },
    // Damaged data: a parent cycle unreachable from any main category.
    { _id: cat.cycleA, name: "Cycle A", slug: "cycle-a", parent: cat.cycleB },
    { _id: cat.cycleB, name: "Cycle B", slug: "cycle-b", parent: cat.cycleA },
  ]);
  await AreaModel.create([
    { _id: area.retail, name: "Retail", slug: "retail", order: 1 },
    { _id: area.office, name: "Office", slug: "office", order: 0 },
    { _id: area.hotel, name: "Hospitality", slug: "hospitality", order: 2 },
  ]);
  const filters = (f: ProductFilters) => f;
  await ProductModel.create([
    product({
      _id: prod.alpha,
      name: "Alpha",
      slug: "alpha",
      family: "Alpha",
      modelCode: "AL-1",
      productNo: 3,
      mainCategory: cat.spotRecessed,
      areas: [area.office],
      variants: [variant("AL-1A"), variant("AL-1B")],
      filters: filters({
        cctK: [3000, 4000],
        wattage: [7, 10],
        ip: [20],
        cri: [90],
        beamDeg: [24],
        ugr: [19],
      }),
    }),
    product({
      _id: prod.bravo,
      name: "Bravo",
      slug: "bravo",
      productNo: 1,
      mainCategory: cat.downRecessed,
      extraCategories: [cat.spotSurface],
      areas: [area.office, area.retail],
      variants: [variant("BR-1")],
      filters: filters({ cctK: [3000], wattage: [15], ip: [65], cri: [80] }),
    }),
    product({
      _id: prod.charlie,
      name: "charlie",
      slug: "charlie",
      mainCategory: cat.spotSurface,
      areas: [area.retail],
      filters: filters({ cctK: [2700], wattage: [40.5], ip: [65] }),
    }),
    product({
      _id: prod.delta,
      name: "Delta",
      slug: "delta",
      productNo: 2,
      mainCategory: cat.track10,
      trackSize: 10,
      areas: [area.office],
      variants: [variant("DE-1"), variant("DE-2"), variant("DE-3")],
      filters: filters({ cctK: [3000], wattage: [20] }),
    }),
    product({
      _id: prod.echoDraft,
      name: "Echo",
      slug: "echo",
      status: "draft",
      productNo: 1,
      mainCategory: cat.spotRecessed,
      trackSize: 5,
      areas: [area.office, area.hotel],
      filters: filters({ cctK: [5000], wattage: [100], ip: [44] }),
    }),
    product({
      _id: prod.foxtrot,
      name: "Foxtrot",
      slug: "foxtrot",
      productNo: 3,
      mainCategory: cat.down,
      extraCategories: [cat.spotRecessed],
      filters: filters({ cctK: [4000], wattage: [45] }),
    }),
    ...Array.from({ length: BULK }, (_, i) =>
      product({
        _id: id(),
        name: "Same Name",
        slug: `bulk-${i}`,
        mainCategory: cat.bulk,
      }),
    ),
  ]);
  // Deterministic creation dates for the "newest" sort.
  const dated: [Types.ObjectId, string][] = [
    [prod.alpha, "2026-01-01"],
    [prod.bravo, "2026-03-01"],
    [prod.charlie, "2026-02-01"],
    [prod.foxtrot, "2026-04-01"],
  ];
  for (const [_id, date] of dated) {
    await ProductModel.collection.updateOne(
      { _id },
      { $set: { createdAt: new Date(date) } },
    );
  }
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

const ALL_OPTIONS = { publicFacets: SPEC_FACET_PARAMS, track: true, cat: true };
const q = (query: string): ListingParams =>
  parseListingParams(new URLSearchParams(query), ALL_OPTIONS);

const ALL: ListingScope = { kind: "all" };
const hex = (oid: Types.ObjectId) => oid.toHexString();
const categoryScope = async (...slugs: string[]): Promise<ListingScope> => {
  const path = await resolveCategoryPath(slugs);
  if (!path) throw new Error(`no path ${slugs.join("/")}`);
  return { kind: "category", ids: path.subtreeIds };
};
const areaScope = (oid: Types.ObjectId): ListingScope => ({
  kind: "area",
  areaId: hex(oid),
});

let visibility: VisibilityByKey;
const slugsOf = async (scope: ListingScope, query = "") =>
  (await listProducts(scope, q(query), visibility)).cards.map((c) => c.slug);
/* Every slug across all pages (filters only, not the bulk products). */
const named = (slugs: string[]) => slugs.filter((s) => !s.startsWith("bulk-"));

beforeEach(async () => {
  cache.calls.length = 0;
  await setVisibility(null);
  visibility = await getCatalogVisibility();
});

/* Every key of every nested object. */
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

const groupOf = (facets: ListingFacets, param: string) =>
  facets.groups.find((group) => group.param === param);
const optionsOf = (facets: ListingFacets, param: string) =>
  groupOf(facets, param)?.options.map((o) => [o.value, o.count]);

// ---------------------------------------------------------------------------
// Scope rule
// ---------------------------------------------------------------------------

describe("scope rule (Q4)", () => {
  it("a main category lists main OR extra category anywhere in its subtree", async () => {
    expect(await slugsOf(await categoryScope("spot-lights"))).toEqual([
      "bravo", // NO. 1, extra category Spot Lights > Surface
      "alpha", // NO. 3, main Spot Lights > Recessed
      "foxtrot", // NO. 3, extra Spot Lights > Recessed
      "charlie", // no NO.: after the numbered ones
    ]);
  });

  it("a sub-category lists only its own products, per parent", async () => {
    expect(
      await slugsOf(await categoryScope("spot-lights", "recessed")),
    ).toEqual(["alpha", "foxtrot"]);
    expect(
      await slugsOf(await categoryScope("downlights", "recessed")),
    ).toEqual(["bravo"]);
    expect(await slugsOf(await categoryScope("downlights"))).toEqual([
      "bravo",
      "foxtrot",
    ]);
  });

  it("an area lists published products with that area", async () => {
    expect(await slugsOf(areaScope(area.office))).toEqual([
      "bravo",
      "delta",
      "alpha",
    ]);
    expect(await slugsOf(areaScope(area.hotel))).toEqual([]);
  });

  it("an unknown or malformed scope is empty without a query", async () => {
    const aggregate = vi.spyOn(ProductModel, "aggregate");
    const count = vi.spyOn(ProductModel, "countDocuments");
    for (const scope of [
      { kind: "category", ids: [] },
      { kind: "category", ids: ["nope", hex(id())] },
      { kind: "area", areaId: hex(id()) },
      { kind: "area", areaId: "x" },
      { kind: "other" } as unknown as ListingScope,
    ] as ListingScope[]) {
      const result = await listProducts(scope, q(""), visibility);
      expect(result).toMatchObject({ cards: [], total: 0, pageCount: 1 });
      expect((await getFacets(scope, visibility)).groups).toEqual([]);
    }
    expect(aggregate).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("filters: OR within a facet, AND across facets", () => {
  it("ORs the values of one facet", async () => {
    expect(named(await slugsOf(ALL, "cct=3000,4000"))).toEqual([
      "bravo",
      "delta",
      "alpha",
      "foxtrot",
    ]);
  });

  it("ANDs across facets", async () => {
    expect(await slugsOf(ALL, "cct=3000&ip=65")).toEqual(["bravo"]);
    expect(await slugsOf(ALL, "cct=2700,3000&ip=65")).toEqual([
      "bravo",
      "charlie",
    ]);
    expect(await slugsOf(ALL, "cct=4000&cri=80")).toEqual([]);
  });

  it("matches wattage buckets as ranges, one value inside one bucket", async () => {
    expect(await slugsOf(ALL, "w=0-10")).toEqual(["alpha"]);
    expect(await slugsOf(ALL, "w=11-20")).toEqual(["bravo", "delta"]);
    expect(await slugsOf(ALL, "w=21-40")).toEqual([]);
    expect(await slugsOf(ALL, "w=41%2B")).toEqual(["foxtrot", "charlie"]);
    expect(await slugsOf(ALL, "w=0-10,41%2B")).toEqual([
      "alpha",
      "foxtrot",
      "charlie",
    ]);
  });

  it("counts wattage facet options per bucket", async () => {
    const facets = await getFacets(ALL, visibility);
    expect(optionsOf(facets, "w")).toEqual([
      ["0-10", 1],
      ["11-20", 2],
      ["41+", 2],
    ]);
  });

  it("filters by track size only under Magnetic Track", async () => {
    const track = await categoryScope("magnetic-track");
    expect(await slugsOf(track, "track=10")).toEqual(["delta"]);
    expect(await slugsOf(track, "track=5")).toEqual([]);
    expect(optionsOf(await getFacets(track, visibility), "track")).toEqual([
      ["10", 1],
    ]);

    const spot = await categoryScope("spot-lights");
    const result = await listProducts(spot, q("track=10"), visibility);
    expect(result.params.track).toEqual([]);
    expect(result.total).toBe(4);
    expect(groupOf(await getFacets(spot, visibility), "track")).toBeUndefined();
    expect(groupOf(await getFacets(ALL, visibility), "track")).toBeUndefined();
  });

  it("filters an area by main category (cat), dropping unknown slugs", async () => {
    const office = areaScope(area.office);
    expect(await slugsOf(office, "cat=spot-lights")).toEqual([
      "bravo",
      "alpha",
    ]);
    expect(await slugsOf(office, "cat=magnetic-track,downlights")).toEqual([
      "bravo",
      "delta",
    ]);
    const unknown = await listProducts(office, q("cat=no-such"), visibility);
    expect(unknown.params.cat).toEqual([]);
    expect(unknown.total).toBe(3);
    // cat means nothing outside area pages.
    const spot = await listProducts(
      await categoryScope("spot-lights"),
      q("cat=downlights"),
      visibility,
    );
    expect(spot.params.cat).toEqual([]);
    expect(spot.total).toBe(4);
  });

  it("offers a category facet (main categories with counts) on area pages only", async () => {
    const facets = await getFacets(areaScope(area.office), visibility);
    expect(groupOf(facets, "cat")?.options).toEqual([
      { value: "spot-lights", label: "Spot Lights", count: 2 },
      { value: "downlights", label: "Downlights", count: 1 },
      { value: "magnetic-track", label: "Magnetic Track", count: 1 },
    ]);
    expect(groupOf(await getFacets(ALL, visibility), "cat")).toBeUndefined();
  });

  it("offers only values present in the scope, with counts", async () => {
    const facets = await getFacets(
      await categoryScope("spot-lights"),
      visibility,
    );
    expect(facets.total).toBe(4);
    expect(optionsOf(facets, "cct")).toEqual([
      ["2700", 1],
      ["3000", 2],
      ["4000", 2],
    ]);
    expect(groupOf(facets, "cct")?.options[0]?.label).toBe("2700K");
    expect(optionsOf(facets, "ip")).toEqual([
      ["20", 1],
      ["65", 2],
    ]);
    expect(optionsOf(facets, "ugr")).toEqual([["19", 1]]);
    expect(facets.groups.map((g) => g.param)).toEqual([
      "cct",
      "cri",
      "beam",
      "ugr",
      "w",
      "ip",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Restricted columns
// ---------------------------------------------------------------------------

const VISIBILITY_SETS: [string, Record<SpecKey, SpecVisibility> | null][] = [
  ["default", null],
  ["all public", every("public")],
  ["all restricted", every("restricted")],
  [
    "wattage + CCT restricted",
    { ...every("public"), wattage: "restricted", cct: "restricted" },
  ],
];

const FACET_COLUMN: Record<string, SpecKey> = {
  cct: "cct",
  cri: "cri",
  beam: "beamAngle",
  ugr: "ugr",
  w: "wattage",
  ip: "ipRating",
};

describe.each(VISIBILITY_SETS)(
  "restricted facets (%s visibility)",
  (_label, setting) => {
    beforeEach(async () => {
      await setVisibility(setting);
      visibility = await getCatalogVisibility();
    });
    const restricted = (): Set<SpecKey> =>
      new Set(
        setting === null
          ? DEFAULT_RESTRICTED_SPEC_KEYS
          : SPEC_KEYS.filter((key) => setting[key] !== "public"),
      );

    it("never computes or returns a restricted column's facet", async () => {
      const aggregate = vi.spyOn(ProductModel, "aggregate");
      const facets = await getFacets(ALL, visibility);
      const branches = Object.keys(
        (aggregate.mock.calls[0]?.[0] as { $facet?: object }[])[1]?.$facet ??
          {},
      );
      for (const [param, column] of Object.entries(FACET_COLUMN)) {
        const isRestricted = restricted().has(column);
        expect(branches.includes(param), `branch ${param}`).toBe(!isRestricted);
        expect(groupOf(facets, param) !== undefined, `group ${param}`).toBe(
          !isRestricted,
        );
      }
    });

    it("ignores a restricted column's filter param", async () => {
      for (const [param, column] of Object.entries(FACET_COLUMN)) {
        const value = {
          cct: "5000",
          cri: "99",
          beam: "99",
          ugr: "39",
          w: "21-40",
          ip: "11",
        }[param];
        // Every value above matches nothing, so a kept param empties the list.
        const result = await listProducts(
          ALL,
          q(`${param}=${value}`),
          visibility,
        );
        if (restricted().has(column)) {
          expect(result.total, param).toBe(5 + BULK);
          expect(result.params[param as keyof ListingParams], param).toEqual(
            [],
          );
        } else {
          expect(result.total, param).toBe(0);
        }
      }
    });

    it("puts the same key in the cache for a dropped param as for none", async () => {
      await listProducts(ALL, q(""), visibility);
      const plain = cache.calls.find((c) => c.name === "listing-count")?.args;
      cache.calls.length = 0;
      const dropped = SPEC_FACET_PARAMS.filter((p) =>
        restricted().has(FACET_COLUMN[p] as SpecKey),
      )
        .map((p) => `${p}=${p === "w" ? "0-10" : "65"}`)
        .join("&");
      await listProducts(ALL, q(dropped), visibility);
      expect(cache.calls.find((c) => c.name === "listing-count")?.args).toEqual(
        plain,
      );
    });
  },
);

// ---------------------------------------------------------------------------
// Drafts, pages, sorts, cards
// ---------------------------------------------------------------------------

describe("drafts", () => {
  it("are never listed, counted or offered as a facet value", async () => {
    const result = await listProducts(ALL, q(""), visibility);
    expect(result.total).toBe(5 + BULK);
    const page2 = await listProducts(ALL, q("page=2"), visibility);
    const slugs = [...result.cards, ...page2.cards].map((c) => c.slug);
    expect(slugs).not.toContain("echo");
    expect(slugs).toHaveLength(5 + BULK);

    const facets = await getFacets(ALL, visibility);
    expect(facets.total).toBe(5 + BULK);
    expect(optionsOf(facets, "cct")?.map(([v]) => v)).not.toContain("5000");
    expect(optionsOf(facets, "ip")?.map(([v]) => v)).not.toContain("44");
    expect(await slugsOf(ALL, "cct=5000")).toEqual([]);
    const office = await getFacets(areaScope(area.office), visibility);
    expect(office.total).toBe(3);
    const hotel = await listProducts(areaScope(area.hotel), q(""), visibility);
    expect(hotel.total).toBe(0);
  });
});

describe("pagination", () => {
  it(`pages by ${LISTING_PAGE_SIZE}, without overlap, in a stable order`, async () => {
    const scope = await categoryScope("bulk");
    const one = await listProducts(scope, q(""), visibility);
    const two = await listProducts(scope, q("page=2"), visibility);
    expect(one).toMatchObject({ total: BULK, page: 1, pageCount: 2 });
    expect(one.cards).toHaveLength(LISTING_PAGE_SIZE);
    expect(two.cards).toHaveLength(BULK - LISTING_PAGE_SIZE);
    const ids = [...one.cards, ...two.cards].map((c) => c.id);
    // Equal names and no NO.: `_id` decides, so the order is total.
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(BULK);
    // Same answer every time.
    const again = await listProducts(scope, q("page=2"), visibility);
    expect(again.cards.map((c) => c.id)).toEqual(two.cards.map((c) => c.id));
  });

  it("reports a page past the end (the route 404s) without reading cards", async () => {
    const scope = await categoryScope("bulk");
    const aggregate = vi.spyOn(ProductModel, "aggregate");
    const three = await listProducts(scope, q("page=3"), visibility);
    expect(three).toMatchObject({
      cards: [],
      total: BULK,
      page: 3,
      pageCount: 2,
    });
    expect(aggregate).not.toHaveBeenCalled();
    expect(cache.calls.map((c) => c.name)).not.toContain("listing-page");
  });

  it("treats page 1 of an empty listing as valid", async () => {
    const empty = await listProducts(
      await categoryScope("empty"),
      q(""),
      visibility,
    );
    expect(empty).toMatchObject({ cards: [], total: 0, page: 1, pageCount: 1 });
    const past = await listProducts(
      await categoryScope("empty"),
      q("page=2"),
      visibility,
    );
    expect(past.page > past.pageCount).toBe(true);
  });
});

describe("sort", () => {
  it("catalog: NO. ascending (missing last), then name, then id", async () => {
    expect(await slugsOf(await categoryScope("spot-lights"))).toEqual([
      "bravo",
      "alpha",
      "foxtrot",
      "charlie",
    ]);
  });

  it("name: case-insensitive A-Z", async () => {
    expect(
      await slugsOf(await categoryScope("spot-lights"), "sort=name"),
    ).toEqual(["alpha", "bravo", "charlie", "foxtrot"]);
  });

  it("newest: creation date descending", async () => {
    expect(
      await slugsOf(await categoryScope("spot-lights"), "sort=newest"),
    ).toEqual(["foxtrot", "bravo", "charlie", "alpha"]);
  });
});

describe("cards", () => {
  it("carry the card fields and the variant count, never a spec", async () => {
    const result = await listProducts(
      await categoryScope("spot-lights"),
      q(""),
      visibility,
    );
    const alpha = result.cards.find((c) => c.slug === "alpha");
    expect(alpha).toEqual({
      id: hex(prod.alpha),
      slug: "alpha",
      name: "Alpha",
      family: "Alpha",
      modelCode: "AL-1",
      image: {
        publicId: testPublicId(1),
        alt: null,
        order: 0,
        kind: "gallery",
      },
      variantCount: 2,
    });
    expect(result.cards.find((c) => c.slug === "charlie")?.variantCount).toBe(
      0,
    );

    const all = [
      result,
      await listProducts(
        await categoryScope("magnetic-track"),
        q(""),
        visibility,
      ),
      await listProducts(areaScope(area.office), q("cct=3000"), visibility),
    ];
    const keys = allKeys(all.map((r) => r.cards));
    for (const key of [
      ...SPEC_KEYS,
      "specs",
      "variants",
      "filters",
      "status",
      "datasheetId",
    ]) {
      expect(keys.has(key), key).toBe(false);
    }
    expect(JSON.stringify(all)).not.toContain("TOKEN-");
    expect(JSON.parse(JSON.stringify(all))).toEqual(all);
    for (const card of all.flatMap((r) => r.cards)) {
      expect(Object.keys(card).sort()).toEqual([
        "family",
        "id",
        "image",
        "modelCode",
        "name",
        "slug",
        "variantCount",
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// Cache keys and tags
// ---------------------------------------------------------------------------

describe("cache keys", () => {
  it("are built from the normalised params only", async () => {
    const raw = async (query: string) => {
      cache.calls.length = 0;
      await listProducts(
        ALL,
        parseListingParams(new URLSearchParams(query), ALL_OPTIONS),
        visibility,
      );
      return cache.calls.filter((c) => c.name.startsWith("listing-"));
    };
    const a = await raw("cct=4000,3000&junk=1&cat=office&track=10&page=1");
    const b = await raw("cct=3000&cct=4000&cct=3000&cct=bad");
    expect(a).toEqual(b);
    expect(a[0]?.args).toEqual([
      { kind: "all" },
      [...DEFAULT_RESTRICTED_SPEC_KEYS].join(","),
      "cct=3000,4000",
      [],
    ]);
  });

  it("hold known category ids only, sorted and lowercased", async () => {
    await listProducts(
      {
        kind: "category",
        ids: [hex(cat.spotSurface).toUpperCase(), hex(id()), hex(cat.spot)],
      },
      q(""),
      visibility,
    );
    const args = cache.calls.find((c) => c.name === "listing-count")?.args;
    expect(args?.[0]).toEqual({
      kind: "category",
      ids: [hex(cat.spot), hex(cat.spotSurface)].sort(),
    });
  });

  it("tag listings and facets with products, categories, areas and settings", () => {
    for (const name of ["listing-count", "listing-page", "listing-facets"]) {
      expect(
        cache.wrappers.find((w) => w.keyParts.includes(name))?.tags.sort(),
      ).toEqual(["areas", "categories", "products", "settings:columns"]);
    }
    expect(
      cache.wrappers.find((w) => w.keyParts.includes("areas"))?.tags,
    ).toEqual(["areas"]);
  });
});

// ---------------------------------------------------------------------------
// Category paths
// ---------------------------------------------------------------------------

describe("resolveCategoryPath", () => {
  it("resolves a main category with its subtree and children", async () => {
    const path = await resolveCategoryPath(["spot-lights"]);
    expect(path).toEqual({
      category: { id: hex(cat.spot), name: "Spot Lights", slug: "spot-lights" },
      path: [{ id: hex(cat.spot), name: "Spot Lights", slug: "spot-lights" }],
      subtreeIds: [
        hex(cat.spot),
        hex(cat.spotRecessed),
        hex(cat.spotSurface),
      ].sort(),
      children: [
        { id: hex(cat.spotRecessed), name: "Recessed", slug: "recessed" },
        { id: hex(cat.spotSurface), name: "Surface", slug: "surface" },
      ],
      isMagneticTrack: false,
    });
  });

  it("tells duplicate sub slugs apart by their parent", async () => {
    const a = await resolveCategoryPath(["spot-lights", "recessed"]);
    const b = await resolveCategoryPath(["downlights", "recessed"]);
    expect(a?.category.id).toBe(hex(cat.spotRecessed));
    expect(b?.category.id).toBe(hex(cat.downRecessed));
    expect(b?.path.map((p) => p.slug)).toEqual(["downlights", "recessed"]);
    expect(b?.subtreeIds).toEqual([hex(cat.downRecessed)]);
  });

  it("flags Magnetic Track paths", async () => {
    expect(
      (await resolveCategoryPath(["magnetic-track", "10mm"]))?.isMagneticTrack,
    ).toBe(true);
  });

  it("is null for unknown, misplaced, malformed or too-long paths", async () => {
    for (const slugs of [
      [],
      ["nope"],
      ["recessed"], // a sub slug is not a main category
      ["magnetic-track", "recessed"],
      ["spot-lights", "recessed", "deeper"],
      ["Spot Lights"],
      ["cycle-a"],
      ["a".repeat(200)],
    ]) {
      expect(await resolveCategoryPath(slugs), slugs.join("/")).toBeNull();
    }
  });

  it("lists every main and sub path, skipping cyclic orphans", async () => {
    expect(await listCategoryPaths()).toEqual([
      ["spot-lights"],
      ["spot-lights", "recessed"],
      ["spot-lights", "surface"],
      ["downlights"],
      ["downlights", "recessed"],
      ["magnetic-track"],
      ["magnetic-track", "10mm"],
      ["empty"],
      ["bulk"],
    ]);
  });
});

describe("category path on a damaged tree (pure)", () => {
  const node = (
    idValue: string,
    slug: string,
    parentId: string | null,
  ): PublicCategoryView => ({
    id: idValue,
    name: slug,
    slug,
    parentId,
    order: 0,
    icon: null,
    coverImage: null,
    description: null,
  });
  const M = "a".repeat(24);
  const A = "b".repeat(24);
  const B = "c".repeat(24);
  // M > A > B (too deep), and a duplicate of M recorded under A (a cycle).
  const tree = [
    node(M, "m", null),
    node(A, "a", M),
    node(B, "b", A),
    node(M, "m-again", A),
    node(A, "a-self", A),
  ];

  it("bounds the depth and never counts an ancestor or itself twice", () => {
    expect(resolveCategoryPathIn(tree, ["m"])?.subtreeIds).toEqual([M, A]);
    const sub = resolveCategoryPathIn(tree, ["m", "a"]);
    expect(sub?.subtreeIds).toEqual([A, B]);
    expect(sub?.children.map((c) => c.id)).toEqual([B]);
    expect(resolveCategoryPathIn(tree, ["m", "a", "b"])).toBeNull();
    expect(resolveCategoryPathIn(tree, ["m", "m-again"])).toBeNull();
  });

  it("lists paths without looping", () => {
    expect(categoryPathsIn(tree)).toEqual([["m"], ["m", "a"]]);
  });
});

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

describe("areas", () => {
  it("lists areas in display order as plain data", async () => {
    expect(await listPublicAreas()).toEqual([
      { id: hex(area.office), name: "Office", slug: "office", bwImage: null },
      { id: hex(area.retail), name: "Retail", slug: "retail", bwImage: null },
      {
        id: hex(area.hotel),
        name: "Hospitality",
        slug: "hospitality",
        bwImage: null,
      },
    ]);
  });

  it("finds an area by slug from the cached list only", async () => {
    const find = vi.spyOn(AreaModel, "find");
    expect((await getAreaBySlug("retail"))?.id).toBe(hex(area.retail));
    expect(await getAreaBySlug("nope")).toBeNull();
    expect(await getAreaBySlug("Bad Slug")).toBeNull();
    expect(await getAreaBySlug("x".repeat(500))).toBeNull();
    // Pass-through cache here: one list read per well-formed slug, none else.
    expect(find).toHaveBeenCalledTimes(2);
  });
});

// Keep the default params import meaningful (a canonical empty query).
it("parses an empty query to the defaults", () => {
  expect(q("")).toEqual(DEFAULT_LISTING_PARAMS);
});
