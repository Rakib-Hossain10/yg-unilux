// QA gate A (Phase 4a): the catalog cache with the REAL Next.js 16.3.8
// unstable_cache / updateTag / revalidateTag (no next/cache mock), on an
// in-memory MongoDB. Proves: entries are really cached, every write path's
// tags expire the right entries through src/lib/revalidate.ts, a visibility
// change never leaves stale restricted values, and documents the fill/expiry
// race (finding M-1, fixed: the visibility is part of the cache key).

import "./helpers/next-als";

import { Types } from "mongoose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { updateArea } from "@/lib/admin/areas";
import { updateCategory } from "@/lib/admin/categories";
import { tagsFor } from "@/lib/admin/products";
import { saveColumnVisibility } from "@/lib/admin/settings";
import { getBreadcrumb } from "@/lib/catalog/categories";
import { getFamilyProducts } from "@/lib/catalog/family";
import { getPublicProduct, listPublishedSlugs } from "@/lib/catalog/product";
import { getRelatedProducts } from "@/lib/catalog/related";
import {
  CATALOG_TAGS,
  productTag,
  revalidateCatalogFromRoute,
  revalidateCatalogInAction,
  type CatalogTag,
} from "@/lib/revalidate";
import { SETTINGS_KEYS } from "@/lib/schemas/settings";
import {
  AreaModel,
  CategoryModel,
  ProductModel,
  SiteContentModel,
} from "@/models";
import {
  SPEC_KEYS,
  type SpecKey,
  type SpecValues,
  type SpecVisibility,
} from "@/models/spec-columns";

import { setupMemoryDb } from "./helpers/memory-db";
import { createNextCacheHarness, nextTick } from "./helpers/next-cache-harness";
import { testPublicId } from "./helpers/public-ids";

setupMemoryDb("yg_catalog_gate_a_cache");

const harness = createNextCacheHarness();
const ACTOR = new Types.ObjectId().toHexString();

const token = (key: SpecKey) => `QA-${key}-VALUE`;
const ALL_SPECS: SpecValues = Object.fromEntries(
  SPEC_KEYS.map((key) => [key, [token(key)]]),
);
const every = (v: SpecVisibility) =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, v])) as Record<
    SpecKey,
    SpecVisibility
  >;

const ids = {
  main: new Types.ObjectId(),
  sub: new Types.ObjectId(),
  area: new Types.ObjectId(),
  p1: new Types.ObjectId(),
  p2: new Types.ObjectId(),
  p3: new Types.ObjectId(),
};
const SLUG = "qa-cache-001";

beforeAll(async () => {
  await CategoryModel.create([
    { _id: ids.main, name: "Main", slug: "main", parent: null },
    { _id: ids.sub, name: "Sub", slug: "sub", parent: ids.main },
  ]);
  await AreaModel.create([
    { _id: ids.area, name: "Office", slug: "office", order: 0 },
  ]);
  const base = {
    mainCategory: ids.sub,
    status: "published" as const,
    areas: [ids.area],
    images: [{ publicId: testPublicId(7), order: 0, kind: "gallery" as const }],
  };
  await ProductModel.create([
    {
      ...base,
      _id: ids.p1,
      name: "Cache One",
      slug: SLUG,
      family: "Cachefam",
      specs: ALL_SPECS,
      variants: [{ modelNo: "QA-001A", specs: ALL_SPECS }],
    },
    {
      ...base,
      _id: ids.p2,
      name: "Cache Two",
      slug: "qa-cache-002",
      family: "Cachefam",
      variants: [{ modelNo: "QA-002A" }],
    },
    {
      ...base,
      _id: ids.p3,
      name: "Cache Three",
      slug: "qa-cache-003",
      family: "Other",
      variants: [{ modelNo: "QA-003A" }],
    },
  ]);
});

async function setVisibilityRaw(v: Record<SpecKey, SpecVisibility> | null) {
  const key = SETTINGS_KEYS.columnVisibility;
  if (v === null) await SiteContentModel.deleteOne({ key });
  else
    await SiteContentModel.updateOne(
      { key },
      { $set: { value: v }, $setOnInsert: { key } },
      { upsert: true },
    );
}

beforeEach(async () => {
  harness.reset();
  await setVisibilityRaw(null);
  await ProductModel.updateOne(
    { _id: ids.p1 },
    { $set: { name: "Cache One" } },
  );
});

const leaks = (value: unknown, key: SpecKey) =>
  JSON.stringify(value).includes(token(key));

describe("harness sanity: the real unstable_cache is in play", () => {
  it("serves the second read from the cache (no DB read)", async () => {
    const first = await getPublicProduct(SLUG);
    expect(first?.name).toBe("Cache One");
    // Change the DB behind the cache's back, no tag expired.
    await ProductModel.updateOne({ _id: ids.p1 }, { $set: { name: "Behind" } });
    const spy = vi.spyOn(ProductModel, "findOne");
    expect((await getPublicProduct(SLUG))?.name).toBe("Cache One");
    expect(spy).not.toHaveBeenCalled();
  });

  it("the bytes written to the data cache hold no restricted value (all readers)", async () => {
    const written: string[] = [];
    const set = harness.cache.set.bind(harness.cache);
    vi.spyOn(harness.cache, "set").mockImplementation(
      async (key, data, ctx) => {
        // The persisted payload is the FETCH entry's JSON body.
        written.push(String((data as { data?: { body?: string } }).data?.body));
        return set(key, data, ctx);
      },
    );
    const view = await getPublicProduct(SLUG);
    if (!view) throw new Error("fixture");
    await Promise.all([
      listPublishedSlugs(),
      getFamilyProducts(view.family, view.id),
      getRelatedProducts(view),
      getBreadcrumb(view),
    ]);
    expect(written.length).toBe(5);
    const blob = written.join("\n");
    expect(blob).toContain(token("cct")); // public value is cached...
    for (const key of [
      "batchNo",
      "chipType",
      "holder",
      "chipEfficiency",
      "driver",
    ] as const) {
      expect(blob.includes(token(key)), key).toBe(false); // ...restricted never
    }
    // The datasheet id / status / filters never reach the entry either.
    expect(blob).not.toMatch(/datasheetId|"status"|"filters"|sourceSha256/);
  });
});

/** Every path an admin write takes, with the tags its service returns. */
async function expireLikeAction(tags: CatalogTag[]) {
  await nextTick();
  await harness.inServerAction(() => revalidateCatalogInAction(tags));
  await nextTick();
}
async function expireLikeRoute(tags: CatalogTag[], immediate = false) {
  await nextTick();
  await harness.inRouteHandler(() =>
    revalidateCatalogFromRoute(tags, { immediate }),
  );
  await nextTick();
}

describe("tag expiry with the real Next cache (Server Action path, updateTag)", () => {
  it.each<[string, CatalogTag[], boolean]>([
    ["products", [CATALOG_TAGS.products], true],
    ["settings:columns", [CATALOG_TAGS.settingsColumns], true],
    ["areas", [CATALOG_TAGS.areas], true],
    // ADR 0063: no product:<id> tag on slug-keyed entries; a product write
    // ALWAYS sends `products` too (tagsFor/productTags), so this is by design.
    ["product:<id> alone", [productTag(ids.p1.toHexString())], false],
    ["categories", [CATALOG_TAGS.categories], false],
    ["datasheets", [CATALOG_TAGS.datasheets], false],
  ])(
    "getPublicProduct after %s expired: refreshed=%s",
    async (_l, tags, refreshed) => {
      await getPublicProduct(SLUG);
      await ProductModel.updateOne(
        { _id: ids.p1 },
        { $set: { name: "Edited" } },
      );
      await expireLikeAction(tags);
      expect((await getPublicProduct(SLUG))?.name).toBe(
        refreshed ? "Edited" : "Cache One",
      );
    },
  );

  it("slugs, family and related strips expire on products", async () => {
    const view = await getPublicProduct(SLUG);
    if (!view) throw new Error("fixture");
    const before = await Promise.all([
      listPublishedSlugs(),
      getFamilyProducts(view.family, view.id),
      getRelatedProducts(view),
    ]);
    expect(before[1].map((c) => c.slug)).toEqual(["qa-cache-002"]);
    await ProductModel.updateOne(
      { _id: ids.p2 },
      { $set: { status: "draft" } },
    );
    try {
      // Not yet expired: still the old lists (cached).
      expect((await getFamilyProducts(view.family, view.id)).length).toBe(1);
      await expireLikeAction([
        CATALOG_TAGS.products,
        productTag(ids.p2.toHexString()),
      ]);
      expect(await getFamilyProducts(view.family, view.id)).toEqual([]);
      expect((await listPublishedSlugs()).map((s) => s.slug)).not.toContain(
        "qa-cache-002",
      );
    } finally {
      await ProductModel.updateOne(
        { _id: ids.p2 },
        { $set: { status: "published" } },
      );
    }
  });

  it("breadcrumb expires on categories (rename / move)", async () => {
    expect(
      (await getBreadcrumb({ mainCategoryId: ids.sub.toHexString() })).map(
        (c) => c.name,
      ),
    ).toEqual(["Main", "Sub"]);
    await CategoryModel.updateOne(
      { _id: ids.main },
      { $set: { name: "Renamed" } },
    );
    try {
      expect(
        (await getBreadcrumb({ mainCategoryId: ids.sub.toHexString() }))[0]
          ?.name,
      ).toBe("Main");
      await expireLikeAction([CATALOG_TAGS.categories]);
      expect(
        (await getBreadcrumb({ mainCategoryId: ids.sub.toHexString() }))[0]
          ?.name,
      ).toBe("Renamed");
    } finally {
      await CategoryModel.updateOne(
        { _id: ids.main },
        { $set: { name: "Main" } },
      );
    }
  });

  it("area rename reaches the product view through the areas tag", async () => {
    await getPublicProduct(SLUG);
    await AreaModel.updateOne(
      { _id: ids.area },
      { $set: { name: "Workplace" } },
    );
    try {
      await expireLikeAction([CATALOG_TAGS.areas]);
      expect((await getPublicProduct(SLUG))?.areas[0]?.name).toBe("Workplace");
    } finally {
      await AreaModel.updateOne(
        { _id: ids.area },
        { $set: { name: "Office" } },
      );
    }
  });

  it("updateTag refuses to run outside a Server Action (route must use revalidateTag)", async () => {
    await expect(
      harness.inRouteHandler(() =>
        revalidateCatalogInAction([CATALOG_TAGS.products]),
      ),
    ).rejects.toThrow(
      /updateTag can only be called from within a Server Action/,
    );
  });
});

describe("visibility changes never serve stale restricted-ness (real cache)", () => {
  it.each(
    SPEC_KEYS.filter(
      (k) =>
        !["batchNo", "chipType", "holder", "chipEfficiency", "driver"].includes(
          k,
        ),
    ),
  )(
    "making %s restricted through the real settings service + action helper hides it at once",
    async (key) => {
      await setVisibilityRaw(every("public"));
      const before = await getPublicProduct(SLUG);
      expect(leaks(before, key)).toBe(true);
      const result = await saveColumnVisibility(ACTOR, {
        ...every("public"),
        [key]: "restricted",
      });
      expect(result.ok).toBe(true);
      await expireLikeAction(result.tags);
      const after = await getPublicProduct(SLUG);
      expect(leaks(after, key)).toBe(false);
      // and inside a request store (the page-render path) too
      const inRequest = await harness.inRequest(() => getPublicProduct(SLUG));
      expect(leaks(inRequest, key)).toBe(false);
    },
  );

  it("route path: settings:columns is expired immediately, never stale-while-revalidate", async () => {
    await setVisibilityRaw(every("public"));
    await harness.inRequest(() => getPublicProduct(SLUG));
    await setVisibilityRaw({ ...every("public"), wattage: "restricted" });
    // Even if a caller passed ONLY the settings tag from a route handler:
    await expireLikeRoute([CATALOG_TAGS.settingsColumns]);
    const served = await harness.inRequest(() => getPublicProduct(SLUG));
    expect(leaks(served, "wattage")).toBe(false);
  });

  it("route path: `products` with 'max' serves the stale entry ONCE (documented SWR)", async () => {
    await harness.inRequest(() => getPublicProduct(SLUG));
    await ProductModel.updateOne({ _id: ids.p1 }, { $set: { name: "Edited" } });
    await expireLikeRoute([CATALOG_TAGS.products]);
    // A request after a "max" expiry gets the stale value, refreshed after.
    expect((await harness.inRequest(() => getPublicProduct(SLUG)))?.name).toBe(
      "Cache One",
    );
    expect((await harness.inRequest(() => getPublicProduct(SLUG)))?.name).toBe(
      "Edited",
    );
  });

  it("route path with immediate: no stale read even once", async () => {
    await harness.inRequest(() => getPublicProduct(SLUG));
    await ProductModel.updateOne(
      { _id: ids.p1 },
      { $set: { status: "draft" } },
    );
    try {
      await expireLikeRoute([CATALOG_TAGS.products], true);
      expect(await harness.inRequest(() => getPublicProduct(SLUG))).toBeNull();
    } finally {
      await ProductModel.updateOne(
        { _id: ids.p1 },
        { $set: { status: "published" } },
      );
    }
  });

  it("a cached null (unknown slug) lives until products is expired, then the new product appears", async () => {
    const slug = "qa-cache-new";
    expect(await getPublicProduct(slug)).toBeNull();
    const id = new Types.ObjectId();
    await ProductModel.create({
      _id: id,
      name: "Brand New",
      slug,
      mainCategory: ids.sub,
      status: "published",
      images: [{ publicId: testPublicId(8), order: 0, kind: "gallery" }],
      variants: [{ modelNo: "QA-NEW" }],
    });
    try {
      expect(await getPublicProduct(slug)).toBeNull();
      await expireLikeAction([CATALOG_TAGS.products, productTag(id)]);
      expect((await getPublicProduct(slug))?.name).toBe("Brand New");
    } finally {
      await ProductModel.deleteOne({ _id: id });
    }
  });

  /*
   * FINDING (L-1): fill / expiry race. A cache fill that read the OLD
   * visibility before the admin's save, and writes its entry AFTER the
   * tag was expired, is stored with a write time newer than the expiry, so
   * Next treats it as fresh: the newly restricted value is then served until
   * the next products/areas/settings expiry (indefinitely on a quiet catalog).
   * Fixed: the restricted keys are read outside the cache and are part of
   * the key, so the stale fill sits under the OLD key and is never served.
   */
  it("a fill that straddles a visibility save does not keep the old projection", async () => {
    await setVisibilityRaw(every("public"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atQuery = new Promise<void>((resolve) => (reached = resolve));
    const original = ProductModel.findOne.bind(ProductModel);
    const spy = vi.spyOn(ProductModel, "findOne").mockImplementationOnce(((
      ...args: Parameters<typeof original>
    ) => {
      const query = original(...args);
      return {
        lean: async () => {
          reached();
          await gate; // visibility already read (all public)
          return query.lean();
        },
      };
    }) as never);
    // A visitor's render starts filling the entry...
    const filling = getPublicProduct(SLUG);
    await atQuery;
    // ...the admin restricts Wattage and the action expires the tags...
    const result = await saveColumnVisibility(ACTOR, {
      ...every("public"),
      wattage: "restricted",
    });
    await expireLikeAction(result.tags);
    // ...then the slow fill finishes and is stored.
    release();
    await filling;
    spy.mockRestore();
    await nextTick();
    const later = await getPublicProduct(SLUG);
    expect(leaks(later, "wattage")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real admin services -> their returned tags -> the real cache
// (the "missed invalidation path" check for ADR 0063's no-product:<id> choice)
// ---------------------------------------------------------------------------

describe("real admin services expire what the catalog readers depend on", () => {
  it("area rename (updateArea) refreshes the product's Applications row", async () => {
    await getPublicProduct(SLUG);
    const result = await updateArea(ACTOR, ids.area.toHexString(), {
      name: "Workspace",
      slug: "",
      bwImage: "",
    });
    try {
      expect(result.ok).toBe(true);
      await expireLikeAction(result.tags);
      expect((await getPublicProduct(SLUG))?.areas[0]?.name).toBe("Workspace");
    } finally {
      await AreaModel.updateOne(
        { _id: ids.area },
        { $set: { name: "Office", slug: "office" } },
      );
    }
  });

  it("category reparent (updateCategory) refreshes the breadcrumb", async () => {
    const other = new Types.ObjectId();
    await CategoryModel.create({
      _id: other,
      name: "Linear",
      slug: "linear",
      parent: null,
    });
    const crumb = () =>
      getBreadcrumb({ mainCategoryId: ids.sub.toHexString() });
    expect((await crumb()).map((c) => c.name)).toEqual(["Main", "Sub"]);
    try {
      const result = await updateCategory(ACTOR, ids.sub.toHexString(), {
        name: "Sub",
        slug: "",
        parent: other.toHexString(),
        description: "",
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      await expireLikeAction(result.tags);
      expect((await crumb()).map((c) => c.name)).toEqual(["Linear", "Sub"]);
    } finally {
      await CategoryModel.updateOne(
        { _id: ids.sub },
        { $set: { parent: ids.main } },
      );
      await CategoryModel.deleteOne({ _id: other });
    }
  });

  it("product tag sets (admin save, images, delete, import commit) always include `products`", () => {
    const id = ids.p1.toHexString();
    for (const published of [true, false]) {
      expect(tagsFor(id, published)).toContain(CATALOG_TAGS.products);
    }
  });
});

// ---------------------------------------------------------------------------
// Cache key collisions with the real key derivation (fixed key + JSON args)
// ---------------------------------------------------------------------------

describe("cache keys do not collide", () => {
  it("family entries for different exclude ids / look-alike family names stay apart", async () => {
    const a = await getFamilyProducts("Cachefam", ids.p1.toHexString());
    const b = await getFamilyProducts("Cachefam", ids.p2.toHexString());
    expect(a.map((c) => c.slug)).toEqual(["qa-cache-002"]);
    expect(b.map((c) => c.slug)).toEqual([SLUG]);
    // A family name that would collide under a naive "join(',')" key.
    expect(
      await getFamilyProducts(
        `Cachefam","${ids.p2.toHexString()}`,
        ids.p1.toHexString(),
      ),
    ).toEqual([]);
    expect(
      (await getFamilyProducts("Cachefam", ids.p1.toHexString())).map(
        (c) => c.slug,
      ),
    ).toEqual(["qa-cache-002"]);
  });

  it("family and related wrappers never share an entry for the same arguments", async () => {
    const view = await getPublicProduct(SLUG);
    if (!view) throw new Error("fixture");
    const related = await getRelatedProducts(view);
    const family = await getFamilyProducts(view.family, view.id);
    expect(related.map((c) => c.slug)).toEqual(["qa-cache-003"]);
    expect(family.map((c) => c.slug)).toEqual(["qa-cache-002"]);
  });

  it("slug case variants never alias one entry (upper case is refused before the cache)", async () => {
    expect(await getPublicProduct(SLUG.toUpperCase())).toBeNull();
    expect((await getPublicProduct(SLUG))?.slug).toBe(SLUG);
  });
});
