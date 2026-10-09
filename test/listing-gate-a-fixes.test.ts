// Phase 4b gate-A fix M-1 (+ I-3): listProducts drops filter values no
// product in the scope has before any cache key is built, or answers an
// empty, uncached result when a facet holds only such values; the facet
// pipeline checks "at most 2 decimals" before its sort/limit, and a value
// beyond the 50-option display cap is never wrongly dropped.
// `next/cache` is a recording pass-through (its arguments are the key).

import { Types } from "mongoose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CategoryModel, ProductModel } from "@/models";

import { setupMemoryDb } from "./helpers/memory-db";
import { testPublicId } from "./helpers/public-ids";

const rec = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown[] }[],
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

import {
  getFacets,
  MAX_FACET_OPTIONS,
  MAX_KNOWN_FACET_VALUES,
  numericBranch,
  type KnownFilterValues,
} from "@/lib/catalog/facets";
import {
  getCatalogVisibility,
  listProducts,
  narrowToKnownValues,
} from "@/lib/catalog/listing";
import {
  DEFAULT_LISTING_PARAMS,
  parseListingParams,
  publicSpecFacets,
  type ListingParams,
} from "@/lib/catalog/listing-params";
import type { ListingScope } from "@/lib/catalog/listing-scope";
import type { VisibilityByKey } from "@/lib/catalog/view";

setupMemoryDb("yg_listing_gate_a_fixes");

const oid = () => new Types.ObjectId();
const cat = { spot: oid(), many: oid(), track: oid(), track10: oid() };

/* 60 selectable CCT values: more than the 50 options shown. */
const MANY = Array.from({ length: 60 }, (_, i) => 2000 + i * 10);
/* 60 over-precise values BELOW every selectable one (I-3). */
const OVER_PRECISE = Array.from({ length: 60 }, (_, i) => 1000.001 + i);

const product = (n: number, extra: Record<string, unknown>) => ({
  name: `P${n}`,
  slug: `p-${n}`,
  modelCode: `P-${n}`,
  status: "published" as const,
  images: [{ publicId: testPublicId(n), order: 0, kind: "gallery" as const }],
  variants: [{ modelNo: `P-${n}A` }],
  ...extra,
});

beforeAll(async () => {
  await CategoryModel.create([
    { _id: cat.spot, name: "Spot", slug: "spot", parent: null },
    { _id: cat.many, name: "Many", slug: "many", parent: null, order: 1 },
    {
      _id: cat.track,
      name: "Magnetic Track",
      slug: "magnetic-track",
      parent: null,
      order: 2,
    },
    { _id: cat.track10, name: "10mm", slug: "10mm", parent: cat.track },
  ]);
  await ProductModel.create([
    product(1, {
      mainCategory: cat.spot,
      filters: { cctK: [3000, 4000], cri: [90], wattage: [12], ip: [20] },
    }),
    product(2, {
      mainCategory: cat.spot,
      filters: { cctK: [3000], cri: [80], wattage: [5], ip: [44] },
    }),
    // One product per selectable value, plus all over-precise values.
    ...MANY.map((value, i) =>
      product(100 + i, {
        mainCategory: cat.many,
        filters: { cctK: i === 0 ? [value, ...OVER_PRECISE] : [value] },
      }),
    ),
    product(3, {
      mainCategory: cat.track10,
      trackSize: 10,
      filters: { cctK: [3000] },
    }),
  ]);
});

let visibility: VisibilityByKey;
beforeEach(async () => {
  rec.calls.length = 0;
  visibility = await getCatalogVisibility();
});

const parse = (query: string, extra: { track?: boolean } = {}) =>
  parseListingParams(new URLSearchParams(query), {
    publicFacets: publicSpecFacets(visibility),
    ...extra,
  });
const keysOf = (name: string) =>
  new Set(
    rec.calls.filter((c) => c.name === name).map((c) => JSON.stringify(c.args)),
  );
const SPOT: ListingScope = { kind: "category", ids: [String(cat.spot)] };
const MANY_SCOPE: ListingScope = { kind: "category", ids: [String(cat.many)] };
const TRACK: ListingScope = {
  kind: "category",
  ids: [String(cat.track), String(cat.track10)],
};

describe("narrowToKnownValues (pure)", () => {
  const params = (over: Partial<ListingParams>): ListingParams => ({
    ...DEFAULT_LISTING_PARAMS,
    cct: [],
    cri: [],
    beam: [],
    ugr: [],
    ip: [],
    w: [],
    track: [],
    cat: [],
    ...over,
  });
  const known: KnownFilterValues = {
    numeric: {
      cct: { values: new Set([3000, 4000]), above: null },
      ip: { values: new Set([20]), above: 65 },
    },
    wattage: new Set(["0-10"]),
    track: new Set([10]),
  };

  it("drops unknown values when the facet keeps a known one", () => {
    const out = narrowToKnownValues(params({ cct: [3000, 3007.25] }), known);
    expect(out).toEqual({ params: params({ cct: [3000] }), impossible: false });
  });

  it("flags a facet with only unknown values and keeps them for the chips", () => {
    const out = narrowToKnownValues(
      params({ cct: [3007.25], ip: [20, 21] }),
      known,
    );
    expect(out.impossible).toBe(true);
    expect(out.params.cct).toEqual([3007.25]);
    expect(out.params.ip).toEqual([20]);
  });

  it("keeps values above a cut value list (beyond the known cap)", () => {
    const out = narrowToKnownValues(params({ ip: [66, 99] }), known);
    expect(out).toEqual({
      params: params({ ip: [66, 99] }),
      impossible: false,
    });
    expect(narrowToKnownValues(params({ ip: [64] }), known).impossible).toBe(
      true,
    );
  });

  it("applies the same rule to wattage buckets and track sizes", () => {
    expect(
      narrowToKnownValues(params({ w: ["0-10", "41+"] }), known).params.w,
    ).toEqual(["0-10"]);
    expect(narrowToKnownValues(params({ w: ["41+"] }), known).impossible).toBe(
      true,
    );
    expect(narrowToKnownValues(params({ track: [20] }), known).impossible).toBe(
      true,
    );
  });

  it("leaves params untouched when nothing is selected", () => {
    expect(narrowToKnownValues(params({ sort: "name" }), known)).toEqual({
      params: params({ sort: "name" }),
      impossible: false,
    });
  });
});

describe("listProducts with values no product has (M-1)", () => {
  it("an unknown value alone answers empty, uncached, and keeps the chip", async () => {
    const result = await listProducts(SPOT, parse("cct=3007.25"), visibility);
    expect(result).toMatchObject({ cards: [], total: 0, pageCount: 1 });
    expect(result.params.cct).toEqual([3007.25]);
    expect(keysOf("listing-count").size).toBe(0);
    expect(keysOf("listing-page").size).toBe(0);
  });

  it("an unknown value next to a known one is dropped: same key, same result", async () => {
    const plain = await listProducts(SPOT, parse("cct=4000"), visibility);
    const mixed = await listProducts(
      SPOT,
      parse("cct=4000,4321,5555.5"),
      visibility,
    );
    expect(mixed.total).toBe(plain.total);
    expect(mixed.total).toBe(1);
    expect(mixed.params.cct).toEqual([4000]);
    expect(keysOf("listing-count").size).toBe(1);
  });

  it("a flood of in-range junk across facets creates no new count entry", async () => {
    for (let i = 0; i < 100; i++) {
      await listProducts(
        SPOT,
        parse(`cct=3000,${5000 + i}&cri=${i % 79}&ip=${(i % 19) + 50}`),
        visibility,
      );
    }
    // cri/ip junk alone in its facet → empty; nothing but 1 key at most.
    expect(keysOf("listing-count").size).toBe(0);
    await listProducts(SPOT, parse("cct=3000,9999"), visibility);
    await listProducts(SPOT, parse("cct=3000,8888"), visibility);
    expect(keysOf("listing-count").size).toBe(1);
  });

  it("a value beyond the 50 shown options is not dropped", async () => {
    const facets = await getFacets(MANY_SCOPE, visibility);
    const cct = facets.groups.find((g) => g.param === "cct");
    expect(cct?.options).toHaveLength(MAX_FACET_OPTIONS);
    const last = MANY[MANY.length - 1];
    expect(cct?.options.map((o) => o.value)).not.toContain(String(last));
    const result = await listProducts(
      MANY_SCOPE,
      parse(`cct=${last}`),
      visibility,
    );
    expect(result.total).toBe(1);
    expect(result.params.cct).toEqual([last]);
  });

  it("track sizes no product has answer empty (Magnetic Track scope)", async () => {
    const ten = await listProducts(
      TRACK,
      parse("track=10", { track: true }),
      visibility,
    );
    expect(ten.total).toBe(1);
    rec.calls.length = 0;
    const twenty = await listProducts(
      TRACK,
      parse("track=20", { track: true }),
      visibility,
    );
    expect(twenty.total).toBe(0);
    expect(twenty.params.track).toEqual([20]);
    expect(keysOf("listing-count").size).toBe(0);
  });
});

describe("facet pipeline (I-3)", () => {
  it("checks 2 decimals and the range before $sort/$limit", () => {
    const stages = numericBranch("cct").map((stage) => Object.keys(stage)[0]);
    expect(stages).toEqual([
      "$project",
      "$unwind",
      "$match",
      "$group",
      "$sort",
      "$limit",
    ]);
    const match = numericBranch("cct")[2] as {
      $match: Record<string, unknown>;
    };
    expect(JSON.stringify(match.$match)).toContain('"$round":["$v",2]');
    const limit = numericBranch("cct")[5] as { $limit: number };
    expect(limit.$limit).toBe(MAX_KNOWN_FACET_VALUES + 1);
  });

  it("over-precise values never take an option's place", async () => {
    const facets = await getFacets(MANY_SCOPE, visibility);
    const values = facets.groups
      .find((g) => g.param === "cct")
      ?.options.map((o) => Number(o.value));
    expect(values).toEqual(MANY.slice(0, MAX_FACET_OPTIONS));
  });
});
