// Phase 4b gate C (QA): search answers on the REAL Next.js cache
// (next-cache-harness). Gate A made zero-hit answers uncached, so a pure junk
// query adds no entry. Finding L-1 (fixed): a query that only ADDS junk to a
// real word still has hits (Atlas `autocomplete`/`text` match ANY token of a
// multi-word query, tokenOrder "any"), so caching per query let "lumo 1",
// "lumo 2", ... grow the data cache without bound. Product answers now skip
// the shared data cache entirely; the route's `private, max-age=30` remains.
//
// Atlas is simulated by intercepting the `$search` aggregation (the memory
// MongoDB has no `$search`): it answers the one product for every query, as
// Atlas would for any query containing "lumo".

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

import { MAX_PRODUCT_HITS, searchCatalog } from "@/lib/catalog/search";
import { CategoryModel, ProductModel } from "@/models";

import { setupMemoryDb } from "./helpers/memory-db";
import { createNextCacheHarness, nextTick } from "./helpers/next-cache-harness";
import { testPublicId } from "./helpers/public-ids";

setupMemoryDb("yg_search_cache_gate_c");

const harness = createNextCacheHarness();
const categoryId = new Types.ObjectId();
const productId = new Types.ObjectId();

beforeAll(async () => {
  await CategoryModel.create({
    _id: categoryId,
    name: "Pendants",
    slug: "pendants",
    parent: null,
  });
  await ProductModel.create({
    _id: productId,
    name: "Lumo Pendant",
    slug: "lumo-lp-1",
    family: "Lumo",
    modelCode: "LP-1",
    status: "published",
    mainCategory: categoryId,
    images: [{ publicId: testPublicId(1), order: 0, kind: "gallery" }],
    variants: [{ modelNo: "LP-1A" }],
  });
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

let atlasCalls = 0;
/* Each `$search` stage sent, serialised (to compare the normalised query). */
let atlasStages: string[] = [];
beforeEach(() => {
  harness.reset();
  atlasCalls = 0;
  atlasStages = [];
  const real = ProductModel.aggregate.bind(ProductModel);
  vi.spyOn(ProductModel, "aggregate").mockImplementation(((
    pipeline?: PipelineStage[],
  ) => {
    const stage = pipeline?.[0];
    if (stage && "$search" in stage) {
      atlasCalls += 1;
      atlasStages.push(JSON.stringify(stage.$search));
      return Promise.resolve([hitDoc]);
    }
    return real(pipeline);
  }) as unknown as typeof ProductModel.aggregate);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* How many of `queries` were stored: asked once, then asked again. */
async function storedEntries(queries: readonly string[]): Promise<number> {
  for (const q of queries) {
    await harness.inRequest(() => searchCatalog(q));
  }
  await nextTick();
  const afterFirst = atlasCalls;
  for (const q of queries) {
    await harness.inRequest(() => searchCatalog(q));
  }
  // Every query Atlas was NOT asked again for came from a cache entry.
  return queries.length - (atlasCalls - afterFirst);
}

describe("gate C: search cache growth", () => {
  it("a real query is never stored: Atlas answers every request, with one normalised key", async () => {
    expect(await storedEntries(["lumo", "LUMO", "  lumo  "])).toBe(0);
    expect(atlasCalls).toBe(6);
    // Case and spacing variants still send one and the same Atlas query.
    expect(new Set(atlasStages).size).toBe(1);
  });

  // L-1 (fixed): product answers no longer use the shared data cache (the
  // route's `private, max-age=30` is the only cache), so junk added to a
  // real word stores nothing at all.
  it("junk appended to a real word does not add one cache entry per variant", async () => {
    const queries = Array.from({ length: 50 }, (_, i) => `lumo zz${i}`);
    const stored = await storedEntries(queries);
    expect(stored).toBeLessThanOrEqual(MAX_PRODUCT_HITS);
    expect(stored).toBe(0);
  });
});
