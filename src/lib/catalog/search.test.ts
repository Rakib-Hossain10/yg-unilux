// Tests for catalog search (ADR 0006, 0066) on an in-memory MongoDB, which
// has no `$search`, so every product query exercises the regex fallback:
// model-no. hits in stored case, prefixes, ranking, escaping, caps, drafts,
// no spec value in any answer, category paths, cache key/tags, and the
// shape of the Atlas pipeline (a pure builder).

import { Types } from "mongoose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CategoryModel, ProductModel } from "@/models";
import {
  SPEC_KEYS,
  type SpecKey,
  type SpecValues,
} from "@/models/spec-columns";
import { setupMemoryDb } from "../../../test/helpers/memory-db";
import { testPublicId } from "../../../test/helpers/public-ids";

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

import { CATALOG_CACHE_VERSION } from "./cache-version";
import {
  buildAtlasSearchPipeline,
  buildFallbackPipeline,
  escapeRegex,
  MAX_CATEGORY_HITS,
  MAX_PRODUCT_HITS,
  MAX_SEARCH_LENGTH,
  matchedModelNoOf,
  normaliseSearchQuery,
  searchCatalog,
  type SearchResult,
} from "./search";
import { PRODUCT_SEARCH_INDEX_NAME } from "./search-index";

setupMemoryDb("yg_catalog_search_test");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/* A unique marker per spec column: none may ever appear in an answer. */
const marker = (key: SpecKey, where: string) => `SPECVAL-${key}-${where}`;
const specsAt = (where: string): SpecValues =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, [marker(key, where)]]));

const id = () => new Types.ObjectId();
const cat = { spot: id(), recessed: id(), down: id(), downRecessed: id() };
const prod = {
  arc: id(),
  arcMini: id(),
  bolt: id(),
  draft: id(),
  meta: id(),
};

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
      _id: cat.recessed,
      name: "Recessed",
      slug: "recessed",
      parent: cat.spot,
      order: 0,
    },
    {
      _id: cat.down,
      name: "Down Lights",
      slug: "down-lights",
      parent: null,
      order: 1,
    },
    {
      _id: cat.downRecessed,
      name: "Recessed Trimless",
      slug: "recessed",
      parent: cat.down,
      order: 0,
    },
  ]);
  const base = {
    mainCategory: cat.spot,
    status: "published" as const,
    images: [{ publicId: testPublicId(1), order: 0, kind: "gallery" as const }],
    specs: specsAt("P"),
    filters: { cctK: [3000], wattage: [12] },
    datasheetId: new Types.ObjectId(),
  };
  await ProductModel.create([
    {
      ...base,
      _id: prod.arc,
      name: "Arc Spot",
      slug: "arc-ar-013a",
      family: "Arc",
      modelCode: "AR-013A",
      type: "Recessed spot",
      variants: [
        { modelNo: "AR-013A1", label: "Lens", specs: specsAt("V1") },
        { modelNo: "AR-013A2", label: "Reflector", specs: specsAt("V2") },
      ],
    },
    {
      ...base,
      _id: prod.arcMini,
      name: "Arc Mini",
      slug: "arc-ar-013",
      family: "Arc",
      modelCode: "AR-013",
      variants: [{ modelNo: "AR-013", specs: specsAt("V3") }],
    },
    {
      ...base,
      _id: prod.bolt,
      name: "Bolt Linear",
      slug: "bolt-bl-200",
      family: "Bolt",
      modelCode: "BL-200",
      variants: [{ modelNo: "BL-200x" }],
    },
    {
      ...base,
      _id: prod.draft,
      status: "draft",
      name: "Arc Draft",
      slug: "arc-draft",
      family: "Arc",
      modelCode: "AR-999",
      variants: [{ modelNo: "AR-0139" }],
    },
    {
      ...base,
      _id: prod.meta,
      name: "Meta (a.b) [x] \\ star*",
      slug: "meta-mt-1",
      family: "Meta",
      variants: [{ modelNo: "MT.1+" }],
    },
  ]);
});

beforeEach(() => {
  cache.calls.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

const slugs = (result: SearchResult) => result.products.map((p) => p.slug);

// ---------------------------------------------------------------------------
// Normalisation and escaping (pure)
// ---------------------------------------------------------------------------

describe("normaliseSearchQuery", () => {
  it("applies NFKC, drops invisible characters, collapses and trims spaces", () => {
    expect(normaliseSearchQuery("  ＡＲ－013​  a1\t\n")).toBe("AR-013 a1");
  });

  it("answers '' below 2 or above 64 characters and for non-strings", () => {
    expect(normaliseSearchQuery("a")).toBe("");
    expect(normaliseSearchQuery("   a   ")).toBe("");
    expect(normaliseSearchQuery("ab")).toBe("ab");
    expect(normaliseSearchQuery("x".repeat(MAX_SEARCH_LENGTH))).toHaveLength(
      64,
    );
    expect(normaliseSearchQuery("x".repeat(MAX_SEARCH_LENGTH + 1))).toBe("");
    expect(normaliseSearchQuery(undefined)).toBe("");
    expect(normaliseSearchQuery(["ab"])).toBe("");
    expect(normaliseSearchQuery({ $ne: "" })).toBe("");
  });
});

describe("escapeRegex", () => {
  it.each([".*", "(", "[", "\\", "a+b?", "^$", "{2}", "a|b", "/x/"])(
    "%s matches only itself",
    (text) => {
      const re = new RegExp(`^${escapeRegex(text)}$`);
      expect(re.test(text)).toBe(true);
      expect(re.test(`${text}x`)).toBe(false);
    },
  );
});

describe("matchedModelNoOf", () => {
  it("prefers an exact match (case-insensitive) over a prefix, keeps stored case", () => {
    expect(matchedModelNoOf(["AR-013A1", "AR-013"], "ar-013")).toBe("AR-013");
    expect(matchedModelNoOf(["AR-013A1", "AR-013A2"], "ar-013a")).toBe(
      "AR-013A1",
    );
    expect(matchedModelNoOf(["AR-013A1"], "arc")).toBeNull();
    expect(matchedModelNoOf([null, 5], "ar")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Atlas pipeline (shape only: Atlas is not available here)
// ---------------------------------------------------------------------------

describe("buildAtlasSearchPipeline", () => {
  const pipeline = buildAtlasSearchPipeline("ar-013a");

  it("starts with $search on the named index, published filter, model-no. boosts", () => {
    expect(pipeline[0]).toEqual({
      $search: {
        index: PRODUCT_SEARCH_INDEX_NAME,
        compound: {
          filter: [{ equals: { path: "status", value: "published" } }],
          should: [
            {
              text: {
                query: "ar-013a",
                path: "variants.modelNo",
                score: { boost: { value: 10 } },
              },
            },
            {
              autocomplete: {
                query: "ar-013a",
                path: "variants.modelNo",
                score: { boost: { value: 5 } },
              },
            },
            {
              autocomplete: {
                query: "ar-013a",
                path: "name",
                score: { boost: { value: 3 } },
              },
            },
            {
              autocomplete: {
                query: "ar-013a",
                path: "family",
                score: { boost: { value: 2 } },
              },
            },
            { autocomplete: { query: "ar-013a", path: "type" } },
          ],
          minimumShouldMatch: 1,
        },
      },
    });
  });

  it("re-checks status, caps hits and projects card fields + model nos. only", () => {
    expect(pipeline[1]).toEqual({ $match: { status: "published" } });
    expect(pipeline[2]).toEqual({ $limit: MAX_PRODUCT_HITS });
    const project = (pipeline[3] as { $project: Record<string, unknown> })
      .$project;
    expect(Object.keys(project).sort()).toEqual(
      [
        "family",
        "images.alt",
        "images.kind",
        "images.order",
        "images.publicId",
        "modelCode",
        "name",
        "slug",
        "variantCount",
        "variants.modelNo",
      ].sort(),
    );
    expect(pipeline).toHaveLength(4);
  });

  it("never touches a spec, filter or datasheet path", () => {
    const json = JSON.stringify(pipeline);
    expect(json).not.toMatch(/specs|filters|datasheet|label/);
  });
});

describe("buildFallbackPipeline", () => {
  it("escapes the query in every regex", () => {
    const json = JSON.stringify(buildFallbackPipeline("a.*("));
    expect(json).toContain(JSON.stringify("^a\\.\\*\\("));
    expect(json).not.toContain('"a.*("');
  });
});

// ---------------------------------------------------------------------------
// searchCatalog on the memory DB (regex fallback)
// ---------------------------------------------------------------------------

describe("searchCatalog (fallback path)", () => {
  it("finds a variant model no. case-insensitively, with the stored casing", async () => {
    const result = await searchCatalog("ar-013a2");
    expect(slugs(result)).toEqual(["arc-ar-013a"]);
    expect(result.products[0]?.matchedModelNo).toBe("AR-013A2");
    expect(result.query).toBe("ar-013a2");
  });

  it("finds model-no. prefixes, exact model no. ranked first", async () => {
    const result = await searchCatalog("AR-013");
    // AR-013 is exact for Arc Mini; AR-013A1/2 are prefixes. Draft AR-0139 absent.
    expect(slugs(result)).toEqual(["arc-ar-013", "arc-ar-013a"]);
    expect(result.products.map((p) => p.matchedModelNo)).toEqual([
      "AR-013",
      "AR-013A1",
    ]);
  });

  it("does not match a model no. in the middle (anchored prefix)", async () => {
    expect(slugs(await searchCatalog("013A1"))).toEqual([]);
  });

  it("finds family and name hits with matchedModelNo null", async () => {
    const byFamily = await searchCatalog("arc");
    expect(slugs(byFamily).sort()).toEqual(["arc-ar-013", "arc-ar-013a"]);
    expect(byFamily.products.every((p) => p.matchedModelNo === null)).toBe(
      true,
    );
    expect(slugs(await searchCatalog("linear"))).toEqual(["bolt-bl-200"]);
    expect(slugs(await searchCatalog("recessed spot"))).toEqual([
      "arc-ar-013a",
    ]);
  });

  it("ranks a name prefix above a contains match, ties by name", async () => {
    await ProductModel.create(
      ["Alumina", "Lumen Star", "Blumen"].map((name, n) => ({
        mainCategory: cat.down,
        status: "published" as const,
        name,
        slug: `rank-${n}`,
      })),
    );
    try {
      expect(slugs(await searchCatalog("lum"))).toEqual([
        "rank-1", // "Lumen Star": name prefix
        "rank-0", // "Alumina": contains
        "rank-2", // "Blumen": contains
      ]);
    } finally {
      await ProductModel.deleteMany({ slug: /^rank-/ });
    }
  });

  it("treats regex metacharacters literally and safely", async () => {
    for (const q of [".*", "(", "[", "\\", "a|b", "^.", "${x}", ".+"]) {
      const padded = q.length < 2 ? `${q}${q}` : q;
      await expect(searchCatalog(padded), q).resolves.toBeDefined();
    }
    expect(slugs(await searchCatalog(".*"))).toEqual([]);
    expect(slugs(await searchCatalog("(a.b)"))).toEqual(["meta-mt-1"]);
    expect(slugs(await searchCatalog("[x]"))).toEqual(["meta-mt-1"]);
    expect(slugs(await searchCatalog("\\ star*"))).toEqual(["meta-mt-1"]);
    const plus = await searchCatalog("mt.1+");
    expect(slugs(plus)).toEqual(["meta-mt-1"]);
    expect(plus.products[0]?.matchedModelNo).toBe("MT.1+");
    // Unescaped, "m..1" would match "MT.1+" and "a|b" would match anything.
    expect(slugs(await searchCatalog("m..1"))).toEqual([]);
    expect(slugs(await searchCatalog("a|b"))).toEqual([]);
  });

  it("answers an empty result without a query outside 2..64 characters", async () => {
    for (const q of [
      "",
      "a",
      " a ",
      "a".repeat(65),
      "AR-013A1".padEnd(65, "x"),
    ]) {
      expect(await searchCatalog(q)).toEqual({
        query: "",
        products: [],
        categories: [],
      });
    }
    expect(cache.calls).toEqual([]);
  });

  it("never returns a draft", async () => {
    const all = [
      ...(await searchCatalog("arc draft")).products,
      ...(await searchCatalog("AR-0139")).products,
      ...(await searchCatalog("ar")).products,
    ];
    expect(all.map((p) => p.id)).not.toContain(prod.draft.toHexString());
  });

  it("caps product hits", async () => {
    await ProductModel.create(
      Array.from({ length: MAX_PRODUCT_HITS + 5 }, (_, n) => ({
        mainCategory: cat.down,
        status: "published" as const,
        name: `Zeta ${String(n).padStart(2, "0")}`,
        slug: `zeta-${n}`,
        variants: [{ modelNo: `ZT-${n}` }],
      })),
    );
    try {
      const result = await searchCatalog("zeta");
      expect(result.products).toHaveLength(MAX_PRODUCT_HITS);
      // Stable ties: name order.
      expect(result.products[0]?.name).toBe("Zeta 00");
    } finally {
      await ProductModel.deleteMany({ slug: /^zeta-/ });
    }
  });

  it("sends no spec key, spec value, filter, label or datasheet id", async () => {
    for (const q of ["ar", "AR-013A1", "arc", "recessed", "bolt", "mt.1+"]) {
      const result = await searchCatalog(q);
      const json = JSON.stringify(result);
      expect(json, q).not.toContain("SPECVAL-");
      for (const key of [
        ...SPEC_KEYS,
        "specs",
        "filters",
        "variants",
        "label",
        "datasheetId",
        "status",
      ]) {
        expect(json, `${q}: ${key}`).not.toContain(`"${key}"`);
      }
      for (const hit of result.products) {
        expect(Object.keys(hit).sort()).toEqual(
          [
            "family",
            "id",
            "image",
            "matchedModelNo",
            "modelCode",
            "name",
            "slug",
            "variantCount",
          ].sort(),
        );
      }
    }
  });

  it("returns the card fields and variant count", async () => {
    const [hit] = (await searchCatalog("AR-013A1")).products;
    expect(hit).toEqual({
      id: prod.arc.toHexString(),
      slug: "arc-ar-013a",
      name: "Arc Spot",
      family: "Arc",
      modelCode: "AR-013A",
      image: {
        publicId: testPublicId(1),
        alt: null,
        order: 0,
        kind: "gallery",
      },
      variantCount: 2,
      matchedModelNo: "AR-013A1",
    });
  });

  it("logs one warning per fallback, without the query text", async () => {
    const warn = vi.mocked(console.warn);
    await searchCatalog("secret-query-text");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/regex fallback/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-query-text");
  });
});

describe("category matches", () => {
  it("matches names case-insensitively with the main-first path", async () => {
    const { categories } = await searchCatalog("RECESSED");
    expect(categories).toEqual([
      {
        id: cat.recessed.toHexString(),
        name: "Recessed",
        slug: "recessed",
        path: ["Spot Lights", "Recessed"],
        slugPath: ["spot-lights", "recessed"],
      },
      {
        id: cat.downRecessed.toHexString(),
        name: "Recessed Trimless",
        slug: "recessed",
        path: ["Down Lights", "Recessed Trimless"],
        slugPath: ["down-lights", "recessed"],
      },
    ]);
  });

  it("puts name prefixes before contains matches, then tree order", async () => {
    const { categories } = await searchCatalog("lights");
    expect(categories.map((c) => c.name)).toEqual([
      "Spot Lights",
      "Down Lights",
    ]);
    await CategoryModel.create([
      { name: "Alpha Glow", slug: "alpha-glow", parent: null, order: 20 },
      { name: "Glow Strip", slug: "glow-strip", parent: null, order: 21 },
    ]);
    try {
      expect(
        (await searchCatalog("glow")).categories.map((c) => c.name),
      ).toEqual(["Glow Strip", "Alpha Glow"]);
    } finally {
      await CategoryModel.deleteMany({ slug: /glow/ });
    }
  });

  it(`caps category hits at ${MAX_CATEGORY_HITS}`, async () => {
    const extra = Array.from({ length: MAX_CATEGORY_HITS + 3 }, (_, n) => ({
      name: `Qux ${n}`,
      slug: `qux-${n}`,
      parent: null,
      order: 10 + n,
    }));
    await CategoryModel.create(extra);
    try {
      expect((await searchCatalog("qux")).categories).toHaveLength(
        MAX_CATEGORY_HITS,
      );
    } finally {
      await CategoryModel.deleteMany({ slug: /^qux-/ });
    }
  });
});

describe("caching", () => {
  it("wraps the Atlas search with the version, products + categories tags", () => {
    const wrapper = cache.wrappers.find(
      (w) => w.keyParts[1] === "search-products",
    );
    expect(wrapper).toEqual({
      keyParts: ["catalog", "search-products", CATALOG_CACHE_VERSION],
      tags: ["products", "categories"],
    });
  });

  it("keys the cache by the lowercased normalised query only", async () => {
    await searchCatalog("  ＡＲ-013A1  ");
    expect(cache.calls.filter((c) => c.name === "search-products")).toEqual([
      { name: "search-products", args: ["ar-013a1"] },
    ]);
  });
});
