// QA gate A (Phase 4b, L1-L2): the listing, facet and search readers and the
// GET /api/catalog/search route on an in-memory MongoDB (no Atlas, so search
// runs the escaped-regex fallback). `next/cache` is a recording pass-through:
// every cached reader call is logged with its arguments, which ARE the cache
// key's argument part, so cache-key bounding can be measured directly.
//
//  1. Leak matrix: every spec column (product + variant level) holds a unique
//     sentinel, restricted filter columns also hold unique filter numbers
//     ("damaged" data the admin save would have cleaned). For each visibility
//     set: no sentinel in cards / facets / search / route JSON, no restricted
//     facet group, a restricted filter param never changes a result (oracle).
//  2. Cache-key bounding under a junk-param flood; page > pageCount.
//  3. Drafts in listings, facets, counts, search and category search.
//  4. Regex injection / ReDoS in the fallback, route Zod + headers, no session.

import { Types } from "mongoose";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import { SETTINGS_KEYS } from "@/lib/schemas/settings";
import {
  AreaModel,
  CategoryModel,
  ProductModel,
  SiteContentModel,
} from "@/models";
import {
  FILTER_KEY_BY_SPEC,
  SPEC_KEYS,
  type SpecKey,
  type SpecValues,
  type SpecVisibility,
} from "@/models/spec-columns";

import { setupMemoryDb } from "./helpers/memory-db";
import { testPublicId } from "./helpers/public-ids";

const rec = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown[] }[],
  session: [] as string[],
}));
vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    keyParts: string[],
  ) => {
    return (...args: unknown[]) => {
      rec.calls.push({
        name: keyParts[1] ?? "",
        args: JSON.parse(JSON.stringify(args)) as unknown[],
      });
      return fn(...args);
    };
  },
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
}));
// Any session read is recorded (the route and readers must do none).
vi.mock("@/lib/auth", () => ({
  getSessionFromDb: () => {
    rec.session.push("getSessionFromDb");
    return null;
  },
}));
vi.mock("@/lib/permissions", () => ({
  getViewer: () => {
    rec.session.push("getViewer");
    return null;
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => {
    rec.session.push("headers");
    return new Headers();
  },
  cookies: async () => {
    rec.session.push("cookies");
    return new Map();
  },
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));

import { GET as searchRoute } from "@/app/api/catalog/search/route";
import { getFacets, type ListingFacets } from "@/lib/catalog/facets";
import {
  getCatalogVisibility,
  LISTING_PAGE_SIZE,
  listProducts,
  type ListingResult,
} from "@/lib/catalog/listing";
import {
  FACET_SPEC_KEY,
  parseListingParams,
  publicSpecFacets,
  SPEC_FACET_PARAMS,
  type RawListingQuery,
  type SpecFacetParam,
} from "@/lib/catalog/listing-params";
import type { ListingScope } from "@/lib/catalog/listing-scope";
import {
  buildFallbackPipeline,
  escapeRegex,
  MAX_SEARCH_LENGTH,
  searchCatalog,
  type SearchResult,
} from "@/lib/catalog/search";
import type { VisibilityByKey } from "@/lib/catalog/view";

setupMemoryDb("yg_listing_gate_a_qa");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/* Every spec value is unique and greppable: SENT<key>at<where>Z. */
const SENTINEL = "QXSENT";
const sentinel = (key: SpecKey, where: string) =>
  `${SENTINEL}${key}at${where}Z`;
const specsAt = (where: string): SpecValues =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, [sentinel(key, where)]]));

/*
 * Unique filter numbers ("damaged" data: the admin save would remove them
 * once a column is restricted, so the readers are the guard under test).
 * Wattage 77.7 sits in bucket "41+", which no other product uses.
 */
const SECRET_FILTERS = {
  cctK: [7777],
  cri: [87],
  beamDeg: [123],
  ugr: [13],
  wattage: [77.7],
  ip: [68],
};
const SECRET_PARAM: Record<SpecFacetParam, string> = {
  cct: "7777",
  cri: "87",
  beam: "123",
  ugr: "13",
  w: "41+",
  ip: "68",
};

const oid = () => new Types.ObjectId();
const cat = {
  spot: oid(),
  recessed: oid(),
  track: oid(),
  track10: oid(),
  hidden: oid(),
};
const area = { office: oid() };
const DRAFT_NAME = "Zephyrdraft Secret";
const DRAFT_MODEL = "ZD-990X";

beforeAll(async () => {
  await CategoryModel.create([
    { _id: cat.spot, name: "Spot Lights", slug: "spot-lights", parent: null },
    {
      _id: cat.recessed,
      name: "Recessed",
      slug: "recessed",
      parent: cat.spot,
    },
    {
      _id: cat.track,
      name: "Magnetic Track",
      slug: "magnetic-track",
      parent: null,
      order: 1,
    },
    { _id: cat.track10, name: "10mm", slug: "10mm", parent: cat.track },
    // Holds only a draft: what search does with it is a gate-A question.
    {
      _id: cat.hidden,
      name: "Zephyr Collection",
      slug: "zephyr-collection",
      parent: null,
      order: 2,
    },
  ]);
  await AreaModel.create({
    _id: area.office,
    name: "Office",
    slug: "office",
    order: 0,
  });
  const image = (n: number, alt?: string) => [
    { publicId: testPublicId(n), order: 0, kind: "gallery" as const, alt },
  ];
  await ProductModel.create([
    {
      name: "Arc Spot",
      slug: "arc-ar-013a",
      family: "Arc",
      modelCode: "AR-013A",
      type: "Downlight",
      productNo: 1,
      status: "published",
      mainCategory: cat.recessed,
      areas: [area.office],
      images: image(1, "Arc spot photo"),
      specs: specsAt("P1"),
      extraSpecs: [{ group: "x", label: "Extra", value: `${SENTINEL}extra` }],
      variants: [
        { modelNo: "AR-013A1", label: "Lens", specs: specsAt("V1a") },
        { modelNo: "AR-013A2", label: "Reflector", specs: specsAt("V1b") },
      ],
      filters: SECRET_FILTERS,
    },
    {
      name: "Bolt Track",
      slug: "bolt-bt-10",
      family: "Bolt",
      modelCode: "BT-10",
      productNo: 2,
      status: "published",
      mainCategory: cat.track10,
      trackSize: 10,
      areas: [area.office],
      images: image(2),
      specs: specsAt("P2"),
      variants: [{ modelNo: "BT-10A", specs: specsAt("V2") }],
      filters: { cctK: [3000], cri: [90], wattage: [12], ip: [20] },
    },
    {
      name: "Cove Linear",
      slug: "cove-cl-1",
      family: "Cove",
      modelCode: "CL-1",
      status: "published",
      mainCategory: cat.spot,
      extraCategories: [cat.track10],
      images: image(3),
      specs: specsAt("P3"),
      variants: [{ modelNo: "CL-1A", specs: specsAt("V3") }],
      filters: { cctK: [3000, 4000], beamDeg: [24], ugr: [19] },
    },
    {
      name: DRAFT_NAME,
      slug: "zephyrdraft-zd-990",
      family: "Zephyrdraft",
      modelCode: "ZD-990",
      status: "draft",
      mainCategory: cat.hidden,
      extraCategories: [cat.recessed, cat.track10],
      trackSize: 20,
      areas: [area.office],
      images: image(4),
      specs: specsAt("D"),
      variants: [{ modelNo: DRAFT_MODEL, specs: specsAt("VD") }],
      // Draft-only filter values: must never be offered or counted.
      filters: { cctK: [6543], cri: [55], wattage: [99], ip: [11] },
    },
  ]);
});

async function setVisibility(
  visibility: Partial<Record<SpecKey, SpecVisibility>> | null,
): Promise<VisibilityByKey> {
  const key = SETTINGS_KEYS.columnVisibility;
  if (visibility === null) await SiteContentModel.deleteOne({ key });
  else
    await SiteContentModel.updateOne(
      { key },
      { $set: { value: visibility }, $setOnInsert: { key } },
      { upsert: true },
    );
  return getCatalogVisibility();
}

const every = (v: SpecVisibility) =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, v])) as Record<
    SpecKey,
    SpecVisibility
  >;

const FILTER_SPEC_KEYS = Object.keys(FILTER_KEY_BY_SPEC) as SpecKey[];

/* [label, stored setting (null = none), the spec facets that must be absent]. */
const VISIBILITY_SETS: [
  string,
  Partial<Record<SpecKey, SpecVisibility>> | null,
  SpecFacetParam[],
][] = [
  ["default (no setting)", null, []],
  ["all public", every("public"), []],
  ["all restricted", every("restricted"), [...SPEC_FACET_PARAMS]],
  ...SPEC_FACET_PARAMS.map(
    (param): [string, Record<SpecKey, SpecVisibility>, SpecFacetParam[]] => [
      `only ${FACET_SPEC_KEY[param]} restricted (+ defaults public)`,
      { ...every("public"), [FACET_SPEC_KEY[param]]: "restricted" },
      [param],
    ],
  ),
  // A damaged setting value fails closed (restrictedSpecKeys).
  [
    "cct set to a junk value",
    { ...every("public"), cct: "RESTRICTED" as SpecVisibility },
    ["cct"],
  ],
];

const SCOPES: [string, ListingScope][] = [
  ["all", { kind: "all" }],
  [
    "category spot subtree",
    { kind: "category", ids: [String(cat.spot), String(cat.recessed)] },
  ],
  [
    "category magnetic track",
    { kind: "category", ids: [String(cat.track), String(cat.track10)] },
  ],
  ["area office", { kind: "area", areaId: String(area.office) }],
];

const parseFor = (
  query: RawListingQuery,
  visibility: VisibilityByKey,
  extra: { track?: boolean; cat?: boolean } = {},
) =>
  parseListingParams(query, {
    publicFacets: publicSpecFacets(visibility),
    ...extra,
  });

const getAll = (query: string) =>
  searchRoute(new Request(`https://example.test/api/catalog/search${query}`));

beforeEach(() => {
  rec.calls.length = 0;
  rec.session.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// 1. Leak matrix
// ---------------------------------------------------------------------------

describe.each(VISIBILITY_SETS)(
  "leak matrix: %s",
  (_label, setting, absentFacets) => {
    let visibility: VisibilityByKey;
    beforeAll(async () => {
      visibility = await setVisibility(setting);
    });

    it("listing cards (every scope, every page/sort) carry no spec value and no spec key", async () => {
      for (const [, scope] of SCOPES) {
        for (const sort of ["catalog", "name", "newest"]) {
          const params = parseFor({ sort }, visibility, {
            track: true,
            cat: true,
          });
          const result = await listProducts(scope, params, visibility);
          const json = JSON.stringify(result);
          expect(json).not.toContain(SENTINEL);
          for (const card of result.cards) {
            expect(Object.keys(card).sort()).toEqual(
              [
                "family",
                "id",
                "image",
                "modelCode",
                "name",
                "slug",
                "variantCount",
              ].sort(),
            );
          }
        }
      }
    });

    it("facets carry no sentinel, no restricted group and no restricted secret number", async () => {
      for (const [, scope] of SCOPES) {
        const facets: ListingFacets = await getFacets(scope, visibility);
        expect(JSON.stringify(facets)).not.toContain(SENTINEL);
        const params = facets.groups.map((group) => group.param);
        for (const param of absentFacets) {
          expect(params, `${param} offered`).not.toContain(param);
        }
        // A restricted column's secret number appears in no group at all.
        for (const param of absentFacets) {
          for (const group of facets.groups) {
            if (group.param === "cat" || group.param === "track") continue;
            expect(
              group.options.map((o) => o.value),
              `${param} secret leaked via ${group.param}`,
            ).not.toContain(SECRET_PARAM[param]);
          }
        }
      }
    });

    it("public facets DO offer the seeded secret value (positive control)", async () => {
      const facets = await getFacets({ kind: "all" }, visibility);
      const publicParams = SPEC_FACET_PARAMS.filter(
        (p) => !absentFacets.includes(p),
      );
      for (const param of publicParams) {
        const group = facets.groups.find((g) => g.param === param);
        expect(
          group?.options.map((o) => o.value),
          param,
        ).toContain(SECRET_PARAM[param]);
      }
    });

    it("a restricted filter param is no oracle: it never narrows a listing", async () => {
      const base = await listProducts(
        { kind: "all" },
        parseFor({}, visibility),
        visibility,
      );
      for (const param of absentFacets) {
        for (const value of [SECRET_PARAM[param], "1234", "0"]) {
          // Parsed as an attacker would send it, with every facet allowed.
          const forced = parseListingParams(
            { [param]: value },
            { publicFacets: SPEC_FACET_PARAMS },
          );
          const result = await listProducts(
            { kind: "all" },
            forced,
            visibility,
          );
          expect(result.total, `${param}=${value}`).toBe(base.total);
          expect(result.params[param]).toEqual([]);
          // And the cached readers never got the restricted filter in a key.
          for (const call of rec.calls.filter((c) =>
            c.name.startsWith("listing-"),
          )) {
            expect(String(call.args[2])).not.toMatch(
              new RegExp(`(^|&)${param.replace("+", "\\+")}=`),
            );
          }
        }
      }
    });

    it("search results and the route answer carry no spec value", async () => {
      for (const q of [
        "arc",
        "AR-013A1",
        "ar-013",
        "bolt",
        "spot",
        "cove",
        "track",
      ]) {
        const result = await searchCatalog(q);
        expect(JSON.stringify(result), q).not.toContain(SENTINEL);
        const response = await getAll(`?q=${encodeURIComponent(q)}`);
        expect(response.status).toBe(200);
        expect(await response.text(), q).not.toContain(SENTINEL);
      }
    });

    it("search is no oracle for spec values: a sentinel or secret number finds nothing", async () => {
      for (const q of [
        sentinel("driver", "P1"),
        sentinel("chipType", "V1a"),
        sentinel("batchNo", "P1"),
        `${SENTINEL}extra`,
        "7777",
        "77.7",
      ]) {
        const result = await searchCatalog(q);
        expect(result.products, q).toEqual([]);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// 2. Cache-key bounding
// ---------------------------------------------------------------------------

/* Distinct cache-key argument tuples per reader. */
function distinctKeys(name: string): Set<string> {
  return new Set(
    rec.calls.filter((c) => c.name === name).map((c) => JSON.stringify(c.args)),
  );
}

const JUNK_QUERIES: RawListingQuery[] = [
  { foo: "bar" },
  { utm_source: "x", fbclid: "y", gclid: "z" },
  JSON.parse(
    '{"__proto__":"1","constructor":"x","toString":"y"}',
  ) as RawListingQuery,
  { cct: "abc" },
  { cct: "-3000" },
  { cct: "3e3" },
  { cct: "0x0BB8" },
  { cct: "999999999" },
  { cct: "3000.001" },
  { cct: "Infinity" },
  { cct: "NaN" },
  { cri: "101" },
  { beam: "361" },
  { ugr: "41" },
  { ip: "100" },
  { w: "0-11" },
  { w: "50" },
  { track: "10" }, // dropped outside Magnetic Track
  { cat: "spot-lights" }, // dropped outside area pages
  { sort: "price" },
  { sort: "" },
  { page: "0" },
  { page: "-1" },
  { page: "1.5" },
  { page: "99999" },
  { page: "1e3" },
  { page: "abc" },
  { cct: "x".repeat(10_000) },
  { cct: Array.from({ length: 500 }, () => "junk") },
  { cct: `${"9".repeat(600)}` },
  { "cct[$ne]": "1", "cct[$gt]": "0" },
  { cct: "%00" },
  { cct: "3000\u0000" },
];

describe("cache-key bounding (junk-param flood)", () => {
  let visibility: VisibilityByKey;
  beforeAll(async () => {
    visibility = await setVisibility(null);
  });

  it("every junk query normalises to the default params (one key per reader per scope)", async () => {
    for (const query of JUNK_QUERIES) {
      const params = parseFor(query, visibility);
      expect(params, JSON.stringify(query).slice(0, 80)).toEqual(
        parseFor({}, visibility),
      );
      await listProducts({ kind: "all" }, params, visibility);
      await getFacets({ kind: "all" }, visibility);
    }
    expect(distinctKeys("listing-count").size).toBe(1);
    expect(distinctKeys("listing-page").size).toBe(1);
    expect(distinctKeys("listing-facets").size).toBe(1);
  });

  it("permutations, duplicates, repeated keys and comma lists of one valid set share one key", async () => {
    const variants: RawListingQuery[] = [
      { cct: "3000,4000", ip: "20" },
      { cct: "4000,3000", ip: "20" },
      { cct: ["4000", "3000", "3000"], ip: ["20", "20"] },
      {
        cct: " 4000 , 3000 ,,",
        ip: "20",
        foo: "x",
        sort: "catalog",
        page: "1",
      },
      { ip: "20", cct: "3000.00,4000.0" },
      new URLSearchParams("cct=3000&cct=4000&ip=20&ip=20&zzz=1"),
    ];
    for (const query of variants) {
      await listProducts(
        { kind: "all" },
        parseFor(query, visibility),
        visibility,
      );
    }
    expect(distinctKeys("listing-count").size).toBe(1);
  });

  it("huge lists are capped (12 per facet) before the key is built", async () => {
    const many = Array.from({ length: 2000 }, (_, i) => String(1000 + i)).join(
      ",",
    );
    const params = parseFor({ cct: many }, visibility);
    expect(params.cct.length).toBeLessThanOrEqual(12);
    await listProducts({ kind: "all" }, params, visibility);
    const [call] = rec.calls.filter((c) => c.name === "listing-count");
    expect(String(call?.args[2]).length).toBeLessThan(200);
  });

  it("unknown scope ids add no cache entry (no query either)", async () => {
    await listProducts(
      { kind: "category", ids: [String(oid()), "not-an-id", "$where"] },
      parseFor({}, visibility),
      visibility,
    );
    await listProducts(
      { kind: "area", areaId: String(oid()) },
      parseFor({}, visibility),
      visibility,
    );
    await getFacets({ kind: "area", areaId: "{$ne:null}" }, visibility);
    expect(rec.calls.filter((c) => c.name.startsWith("listing-")).length).toBe(
      0,
    );
  });

  it("page > pageCount: no page entry, page kept for the 404 signal (ADR 0065)", async () => {
    for (const page of ["2", "50", "1000"]) {
      const result: ListingResult = await listProducts(
        { kind: "all" },
        parseFor({ page }, visibility),
        visibility,
      );
      expect(result.pageCount).toBe(1);
      expect(result.page).toBe(Number(page));
      expect(result.page > result.pageCount).toBe(true);
      expect(result.cards).toEqual([]);
    }
    expect(distinctKeys("listing-page").size).toBe(0);
    // The count is shared by every page of one filter set: one key.
    expect(distinctKeys("listing-count").size).toBe(1);
  });

  it("a filter that matches nothing answers without a page entry", async () => {
    await listProducts(
      { kind: "all" },
      parseFor({ cct: "1000" }, visibility),
      visibility,
    );
    expect(distinctKeys("listing-page").size).toBe(0);
  });

  /*
   * FINDING M-1 (fixed): values outside the scope's facet values are dropped
   * (mixed with a known value) or answer an empty, uncached result (alone)
   * before any key is built.
   */
  it("in-range values that no product has do not create new count entries", async () => {
    for (let i = 0; i < 200; i++) {
      await listProducts(
        { kind: "all" },
        parseFor({ cct: String(1000 + i * 7 + 0.25) }, visibility),
        visibility,
      );
    }
    expect(distinctKeys("listing-count").size).toBeLessThanOrEqual(1);
  });

  it("search: product answers create no cache entry; case, width and spacing variants send one query", async () => {
    const aggregate = vi.spyOn(ProductModel, "aggregate");
    try {
      for (const q of [
        "arc spot",
        "ARC SPOT",
        "  arc   spot ",
        "ａｒｃ ｓｐｏｔ",
        "arc​ spot",
        "Arc\tSpot",
      ]) {
        await searchCatalog(q);
      }
      // Gate-C L-1: no per-query data-cache entry at all.
      expect(distinctKeys("search-products").size).toBe(0);
      const searchStages = aggregate.mock.calls
        .map(([pipeline]) => pipeline?.[0])
        .filter((stage) => stage !== undefined && "$search" in stage)
        .map((stage) => JSON.stringify(stage));
      expect(searchStages).toHaveLength(6);
      expect(new Set(searchStages).size).toBe(1);
    } finally {
      aggregate.mockRestore();
    }
  });

  it("search: too short / too long / non-string queries reach no reader", async () => {
    const aggregate = vi.spyOn(ProductModel, "aggregate");
    onTestFinished(() => aggregate.mockRestore());
    for (const q of [
      "",
      "a",
      " a ",
      "x".repeat(65),
      "x".repeat(10_000),
      42,
      null,
      { $ne: 1 },
      ["ar"],
    ]) {
      expect(await searchCatalog(q)).toEqual({
        query: "",
        products: [],
        categories: [],
      });
    }
    expect(distinctKeys("search-products").size).toBe(0);
    expect(aggregate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Drafts
// ---------------------------------------------------------------------------

describe("drafts never surface", () => {
  let visibility: VisibilityByKey;
  beforeAll(async () => {
    visibility = await setVisibility(every("public"));
  });

  it("not in any listing scope, page or sort; totals exclude it", async () => {
    const scopes: ListingScope[] = [
      ...SCOPES.map(([, scope]) => scope),
      { kind: "category", ids: [String(cat.hidden)] },
    ];
    for (const scope of scopes) {
      for (const sort of ["catalog", "name", "newest"]) {
        const result = await listProducts(
          scope,
          parseFor({ sort }, visibility, { track: true, cat: true }),
          visibility,
        );
        const json = JSON.stringify(result);
        expect(json).not.toContain("Zephyrdraft");
        expect(json).not.toContain(DRAFT_MODEL);
      }
    }
    const all = await listProducts(
      { kind: "all" },
      parseFor({}, visibility),
      visibility,
    );
    expect(all.total).toBe(3);
    const hidden = await listProducts(
      { kind: "category", ids: [String(cat.hidden)] },
      parseFor({}, visibility),
      visibility,
    );
    expect(hidden.total).toBe(0);
  });

  it("draft-only filter values are neither offered nor counted", async () => {
    for (const [, scope] of SCOPES) {
      const facets = await getFacets(scope, visibility);
      const values = facets.groups.flatMap((g) =>
        g.options.map((o) => `${g.param}=${o.value}`),
      );
      for (const leaked of ["cct=6543", "cri=55", "ip=11", "track=20"]) {
        expect(values).not.toContain(leaked);
      }
    }
    const all = await getFacets({ kind: "all" }, visibility);
    expect(all.total).toBe(3);
    const office = await getFacets(
      { kind: "area", areaId: String(area.office) },
      visibility,
    );
    expect(office.total).toBe(2);
    // The area's category facet counts the draft's categories as 0 → absent.
    const catGroup = office.groups.find((g) => g.param === "cat");
    expect(catGroup?.options.map((o) => o.value)).not.toContain(
      "zephyr-collection",
    );
    // The draft-only "41+"? No: Arc has 77.7. "track 20" only on the draft.
    const track = await getFacets(
      { kind: "category", ids: [String(cat.track), String(cat.track10)] },
      visibility,
    );
    expect(track.groups.find((g) => g.param === "track")?.options).toEqual([
      { value: "10", label: "10 mm", count: 1 },
    ]);
  });

  it("filtering by a draft-only value finds nothing", async () => {
    const result = await listProducts(
      { kind: "all" },
      parseFor({ cct: "6543" }, visibility),
      visibility,
    );
    expect(result.total).toBe(0);
  });

  it("search finds no draft by name, family, model no. or prefix", async () => {
    for (const q of [
      DRAFT_NAME,
      "zephyrdraft",
      DRAFT_MODEL,
      "zd-99",
      "ZD-990",
    ]) {
      const result = await searchCatalog(q);
      expect(result.products, q).toEqual([]);
      expect(JSON.stringify(result.categories)).not.toContain(DRAFT_MODEL);
    }
  });

  /*
   * I-2 (decided by the main session, fixed): a category whose subtree holds
   * only drafts (or nothing) is not a category hit, so an unreleased line's
   * name never surfaces in search.
   */
  it("a draft-only category is NOT returned by category search", async () => {
    const result = await searchCatalog("zephyr");
    expect(result.products).toEqual([]);
    expect(result.categories).toEqual([]);
    const response = await getAll("?q=zephyr");
    expect(await response.text()).not.toContain("Zephyr Collection");
  });

  it("a category with a published product (main or extra, or in its subtree) IS returned", async () => {
    // Recessed: Arc's main category; Spot Lights: its parent; 10mm: Cove's extra.
    expect(
      (await searchCatalog("recessed")).categories.map((c) => c.slug),
    ).toEqual(["recessed"]);
    expect((await searchCatalog("spot")).categories.map((c) => c.slug)).toEqual(
      ["spot-lights"],
    );
    expect((await searchCatalog("10mm")).categories.map((c) => c.slug)).toEqual(
      ["10mm"],
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Regex injection, ReDoS, route contract
// ---------------------------------------------------------------------------

describe("search: regex injection and bounds", () => {
  beforeAll(async () => {
    await setVisibility(null);
  });

  it.each([
    ".*",
    "^",
    "$",
    "a|b",
    "(a)",
    "[a-z]+",
    "\\",
    "a{1,99}",
    "(?i)",
    "(a+)+$",
    "/.*/",
    "?",
    "+",
  ])(
    "metacharacters are literal: %j matches nothing in the catalog",
    async (q) => {
      const padded = q.length < 2 ? `${q}${q}` : q;
      const result = await searchCatalog(padded);
      expect(result.products).toEqual([]);
    },
  );

  it("escapeRegex makes every metacharacter literal (round trip through RegExp)", () => {
    const nasty = ".*+?^${}()|[]\\/-#&~ \t";
    expect(new RegExp(`^${escapeRegex(nasty)}$`).test(nasty)).toBe(true);
    expect(new RegExp(escapeRegex(".*")).test("anything")).toBe(false);
  });

  it("the fallback pipeline holds only escaped strings (no operator object from input)", () => {
    const pipeline = JSON.stringify(buildFallbackPipeline("(a+)+$"));
    expect(pipeline).toContain("\\\\(a\\\\+\\\\)\\\\+\\\\$");
    expect(pipeline).not.toContain('"(a+)+$"');
  });

  it("a catastrophic-backtracking shape at the length cap answers fast", async () => {
    const evil = `${"a".repeat(MAX_SEARCH_LENGTH - 1)}!`;
    const started = performance.now();
    const result = await searchCatalog(evil);
    expect(result.products).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("a real model-no. hit still works (escape keeps '-' literal)", async () => {
    const result = await searchCatalog("ar-013a2");
    expect(result.products.map((p) => [p.slug, p.matchedModelNo])).toEqual([
      ["arc-ar-013a", "AR-013A2"],
    ]);
  });
});

describe("GET /api/catalog/search contract", () => {
  beforeAll(async () => {
    await setVisibility(null);
  });

  it("200 answers are `private, max-age=30`, never s-maxage, no session read", async () => {
    for (const q of ["?q=arc", "?q=a", "?q=", "", "?q=zzzz"]) {
      const response = await getAll(q);
      expect(response.status).toBe(200);
      const cc = response.headers.get("Cache-Control") ?? "";
      expect(cc).toBe("private, max-age=30");
      expect(cc).not.toMatch(/s-maxage|public|stale-while/);
    }
    expect(rec.session).toEqual([]);
  });

  it.each([
    ["65 characters", `?q=${"x".repeat(65)}`],
    ["257 raw characters (spaces)", `?q=${"%20".repeat(257)}`],
    ["a repeated q", "?q=arc&q=bolt"],
    [
      "65 astral code points",
      `?q=${encodeURIComponent("\u{1F4A1}".repeat(65))}`,
    ],
  ])(
    "rejects %s with 400 `private, no-store` and a generic body",
    async (_n, q) => {
      const response = await getAll(q);
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const text = await response.text();
      expect(text).toBe(JSON.stringify({ message: "Invalid search query." }));
      expect(rec.session).toEqual([]);
    },
  );

  it("bracket / operator style params are just strings or ignored", async () => {
    for (const q of [
      "?q[$ne]=1",
      "?q[$regex]=.*",
      "?q=%7B%22%24ne%22%3A1%7D",
    ]) {
      const response = await getAll(q);
      expect(response.status).toBe(200);
      const body = (await response.json()) as SearchResult;
      expect(body.products).toEqual([]);
    }
  });

  it("64 code points after NFKC expansion still answer 200 (normalised away, never a 500)", async () => {
    // U+FDFA expands to 18 characters under NFKC.
    const response = await getAll(`?q=${encodeURIComponent("ﷺ".repeat(10))}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      query: "",
      products: [],
      categories: [],
    });
  });

  it("listing and facet readers read no session either", async () => {
    const visibility = await getCatalogVisibility();
    await listProducts({ kind: "all" }, parseFor({}, visibility), visibility);
    await getFacets({ kind: "area", areaId: String(area.office) }, visibility);
    await searchCatalog("arc");
    expect(rec.session).toEqual([]);
  });
});

describe("sanity of the fixture", () => {
  it("restricted filter columns exist for every facet param", () => {
    for (const param of SPEC_FACET_PARAMS) {
      expect(FILTER_SPEC_KEYS).toContain(FACET_SPEC_KEY[param]);
    }
    expect(LISTING_PAGE_SIZE).toBe(24);
  });
});
