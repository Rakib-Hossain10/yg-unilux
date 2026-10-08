// Phase 4b gate-A fixes on the REAL Next.js cache (next-cache-harness):
//  - L-2: a zero-hit Atlas answer is never cached (the index may still be
//    BUILDING), while an answer with hits is.
//  - I-2: the published-count per category behind category search is
//    cached and expires with `products` (publishing a product in an empty
//    category makes it a search hit after the write's tag).
// Atlas is simulated by intercepting the `$search` aggregation (the memory
// MongoDB has no `$search`); every other query runs for real.

import "./helpers/next-als";

import { Types, type PipelineStage } from "mongoose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  categoriesWithPublished,
  listPublishedCategoryCounts,
} from "@/lib/catalog/category-counts";
import { searchCatalog } from "@/lib/catalog/search";
import { revalidateCatalogInAction } from "@/lib/revalidate";
import { CategoryModel, ProductModel } from "@/models";

import { setupMemoryDb } from "./helpers/memory-db";
import { createNextCacheHarness, nextTick } from "./helpers/next-cache-harness";
import { testPublicId } from "./helpers/public-ids";

setupMemoryDb("yg_search_cache_gate_a_fixes");

const harness = createNextCacheHarness();
const oid = () => new Types.ObjectId();
const cat = { main: oid(), sub: oid(), empty: oid(), emptySub: oid() };
const productId = oid();

beforeAll(async () => {
  await CategoryModel.create([
    { _id: cat.main, name: "Linear Lights", slug: "linear", parent: null },
    { _id: cat.sub, name: "Linear Pendant", slug: "pendant", parent: cat.main },
    {
      _id: cat.empty,
      name: "Nova Lights",
      slug: "nova",
      parent: null,
      order: 1,
    },
    {
      _id: cat.emptySub,
      name: "Nova Spot",
      slug: "nova-spot",
      parent: cat.empty,
    },
  ]);
  await ProductModel.create({
    _id: productId,
    name: "Lumo Pendant",
    slug: "lumo-lp-1",
    family: "Lumo",
    modelCode: "LP-1",
    status: "published",
    mainCategory: cat.sub,
    images: [{ publicId: testPublicId(1), order: 0, kind: "gallery" }],
    variants: [{ modelNo: "LP-1A" }],
  });
  // A draft in the "empty" line: must never make it a search hit.
  await ProductModel.create({
    name: "Nova Draft",
    slug: "nova-draft",
    modelCode: "ND-1",
    status: "draft",
    mainCategory: cat.empty,
    extraCategories: [cat.emptySub],
    images: [{ publicId: testPublicId(3), order: 0, kind: "gallery" }],
    variants: [{ modelNo: "ND-1A" }],
  });
});

/* Atlas answers: what `$search` returns for the next calls (in turn). */
let atlasAnswers: unknown[][] = [];
let atlasCalls = 0;
beforeEach(() => {
  harness.reset();
  atlasAnswers = [];
  atlasCalls = 0;
  const real = ProductModel.aggregate.bind(ProductModel);
  vi.spyOn(ProductModel, "aggregate").mockImplementation(((
    pipeline?: PipelineStage[],
  ) => {
    if (pipeline?.[0] && "$search" in pipeline[0]) {
      const answer =
        atlasAnswers[Math.min(atlasCalls, atlasAnswers.length - 1)];
      atlasCalls += 1;
      return Promise.resolve(answer ?? []);
    }
    return real(pipeline);
  }) as unknown as typeof ProductModel.aggregate);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const hitDoc = {
  _id: productId,
  name: "Lumo Pendant",
  slug: "lumo-lp-1",
  family: "Lumo",
  modelCode: "LP-1",
  images: [],
  variantCount: 1,
  variants: [{ modelNo: "LP-1A" }],
};

describe("L-2: zero-hit Atlas answers are not cached", () => {
  it("an empty answer (index still building) is asked again; the first hit is then cached", async () => {
    atlasAnswers = [[], [hitDoc], []];
    const first = await harness.inRequest(() => searchCatalog("lumo"));
    expect(first.products).toEqual([]);
    await nextTick();
    // The index became READY: the next request asks Atlas again.
    const second = await harness.inRequest(() => searchCatalog("lumo"));
    expect(second.products.map((p) => p.slug)).toEqual(["lumo-lp-1"]);
    expect(atlasCalls).toBe(2);
    await nextTick();
    // An answer with hits is cached: Atlas is not asked a third time.
    const third = await harness.inRequest(() => searchCatalog("lumo"));
    expect(third.products.map((p) => p.slug)).toEqual(["lumo-lp-1"]);
    expect(atlasCalls).toBe(2);
  });

  it("a zero-hit answer does not log the fallback warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    atlasAnswers = [[]];
    await harness.inRequest(() => searchCatalog("nothing-here"));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("I-2: categories with no published product are hidden", () => {
  it("hides an empty subtree, shows a parent through its child, and follows `products`", async () => {
    atlasAnswers = [[]];
    const before = await harness.inRequest(() => searchCatalog("lights"));
    expect(before.categories.map((c) => c.slug)).toEqual(["linear"]);
    expect(
      (await harness.inRequest(() => searchCatalog("nova"))).categories,
    ).toEqual([]);

    // Publish a product in the empty sub-category (direct write, no tag yet).
    await ProductModel.create({
      name: "Nova Spot One",
      slug: "nova-ns-1",
      modelCode: "NS-1",
      status: "published",
      mainCategory: cat.emptySub,
      images: [{ publicId: testPublicId(2), order: 0, kind: "gallery" }],
      variants: [{ modelNo: "NS-1A" }],
    });
    try {
      await nextTick();
      // Cached: still hidden until the write's tag expires the counts.
      expect(
        (await harness.inRequest(() => searchCatalog("nova"))).categories,
      ).toEqual([]);

      await harness.inServerAction(() =>
        revalidateCatalogInAction(["products"]),
      );
      await nextTick();
      expect(
        (await harness.inRequest(() => searchCatalog("nova"))).categories.map(
          (c) => c.slug,
        ),
      ).toEqual(["nova-spot", "nova"]); // both name prefixes: tree order
    } finally {
      await ProductModel.deleteOne({ slug: "nova-ns-1" });
    }
  });

  it("a draft does not count", async () => {
    const counts = await harness.inRequest(() => listPublishedCategoryCounts());
    expect(counts).toEqual([[cat.sub.toHexString(), 1]]);
  });
});

describe("categoriesWithPublished (pure)", () => {
  const view = (id: string, parentId: string | null) => ({
    id,
    name: id,
    slug: id,
    parentId,
    order: 0,
    icon: null,
    coverImage: null,
    description: null,
  });

  it("marks a category and all its ancestors, ignores zero counts and unknown ids", () => {
    const tree = [
      view("a", null),
      view("b", "a"),
      view("c", "b"),
      view("d", null),
    ];
    expect(
      [
        ...categoriesWithPublished(tree, [
          ["c", 2],
          ["d", 0],
          ["zz", 5],
        ]),
      ].sort(),
    ).toEqual(["a", "b", "c"]);
  });

  it("survives a cycle in a broken tree", () => {
    const tree = [view("a", "b"), view("b", "a")];
    expect([...categoriesWithPublished(tree, [["a", 1]])].sort()).toEqual([
      "a",
      "b",
    ]);
  });
});
