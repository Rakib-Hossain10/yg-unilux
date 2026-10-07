// Tests for src/lib/revalidate.ts with `next/cache` mocked: Server Actions
// expire tags with updateTag, other callers with revalidateTag(tag, "max")
// (settings:columns at once); tags are de-duplicated, forged ones refused.

import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nextCache = vi.hoisted(() => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("next/cache", () => nextCache);

import {
  CATALOG_TAGS,
  type CatalogTag,
  InvalidCatalogTagError,
  productTag,
  productTags,
  revalidateCatalogFromRoute,
  revalidateCatalogInAction,
  uniqueTags,
} from "./revalidate";

const ID = "65f0c0ffee0000000000abcd";
const OTHER_ID = "65f0c0ffee0000000000dcba";

beforeEach(() => {
  nextCache.updateTag.mockReset();
  nextCache.revalidateTag.mockReset();
});

describe("tag builders", () => {
  it("names the fixed tags exactly as ADR 0008 lists them", () => {
    expect(Object.values(CATALOG_TAGS).sort()).toEqual([
      "areas",
      "categories",
      "datasheets",
      "products",
      "settings:columns",
    ]);
  });

  it("builds product:<id> from a hex ObjectId, lowercased", () => {
    expect(productTag(ID)).toBe(`product:${ID}`);
    expect(productTag(ID.toUpperCase())).toBe(`product:${ID}`);
  });

  it("accepts a Mongoose ObjectId", () => {
    expect(productTag(new Types.ObjectId(ID))).toBe(`product:${ID}`);
  });

  it.each(["", "abc", `${ID}0`, "product:x", "zzzzzzzzzzzzzzzzzzzzzzzz"])(
    "refuses a product id that is not an ObjectId: %j",
    (bad) => {
      expect(() => productTag(bad)).toThrow(InvalidCatalogTagError);
    },
  );

  it("productTags gives the list tag plus the product's own tag", () => {
    expect(productTags(ID)).toEqual(["products", `product:${ID}`]);
  });
});

describe("uniqueTags", () => {
  it("drops repeats and keeps first-seen order", () => {
    expect(
      uniqueTags([
        CATALOG_TAGS.products,
        productTag(ID),
        CATALOG_TAGS.products,
        productTag(ID),
        CATALOG_TAGS.categories,
      ]),
    ).toEqual(["products", `product:${ID}`, "categories"]);
  });
});

describe("revalidateCatalogInAction", () => {
  it("calls updateTag once per distinct tag and never revalidateTag", () => {
    revalidateCatalogInAction([
      ...productTags(ID),
      ...productTags(OTHER_ID),
      CATALOG_TAGS.datasheets,
    ]);

    expect(nextCache.updateTag.mock.calls).toEqual([
      ["products"],
      [`product:${ID}`],
      [`product:${OTHER_ID}`],
      ["datasheets"],
    ]);
    expect(nextCache.revalidateTag).not.toHaveBeenCalled();
  });

  it("does nothing for an empty list", () => {
    revalidateCatalogInAction([]);
    expect(nextCache.updateTag).not.toHaveBeenCalled();
  });

  it("refuses a forged tag before expiring anything", () => {
    const forged = "products:everything" as CatalogTag;
    expect(() =>
      revalidateCatalogInAction([CATALOG_TAGS.products, forged]),
    ).toThrow(InvalidCatalogTagError);
    expect(nextCache.updateTag).not.toHaveBeenCalled();
  });

  it("lets an error from Next (e.g. not inside a Server Action) propagate", () => {
    nextCache.updateTag.mockImplementation(() => {
      throw new Error(
        "updateTag can only be called from within a Server Action",
      );
    });
    expect(() => revalidateCatalogInAction([CATALOG_TAGS.areas])).toThrow(
      /Server Action/,
    );
  });
});

describe("revalidateCatalogFromRoute", () => {
  it('calls revalidateTag(tag, "max") once per distinct tag and never updateTag', () => {
    revalidateCatalogFromRoute([
      CATALOG_TAGS.categories,
      CATALOG_TAGS.categories,
      productTag(ID),
      CATALOG_TAGS.products,
      productTag(ID),
    ]);

    expect(nextCache.revalidateTag.mock.calls).toEqual([
      ["categories", "max"],
      [`product:${ID}`, "max"],
      ["products", "max"],
    ]);
    expect(nextCache.updateTag).not.toHaveBeenCalled();
  });

  it("always expires settings:columns at once, so restricted values are never served stale", () => {
    revalidateCatalogFromRoute([
      CATALOG_TAGS.settingsColumns,
      CATALOG_TAGS.products,
    ]);

    expect(nextCache.revalidateTag.mock.calls).toEqual([
      ["settings:columns", { expire: 0 }],
      ["products", "max"],
    ]);
  });

  it("expires every tag at once when asked (writes that remove public data)", () => {
    revalidateCatalogFromRoute(productTags(ID), { immediate: true });

    expect(nextCache.revalidateTag.mock.calls).toEqual([
      ["products", { expire: 0 }],
      [`product:${ID}`, { expire: 0 }],
    ]);
  });

  it("does nothing for an empty list", () => {
    revalidateCatalogFromRoute([]);
    expect(nextCache.revalidateTag).not.toHaveBeenCalled();
  });

  it("refuses a forged product tag before revalidating anything", () => {
    const forged = "product:../../etc" as CatalogTag;
    expect(() =>
      revalidateCatalogFromRoute([CATALOG_TAGS.areas, forged]),
    ).toThrow(InvalidCatalogTagError);
    expect(nextCache.revalidateTag).not.toHaveBeenCalled();
  });

  it("lets an error from Next propagate instead of hiding a missed invalidation", () => {
    nextCache.revalidateTag.mockImplementation(() => {
      throw new Error("revalidateTag failed");
    });
    expect(() => revalidateCatalogFromRoute([CATALOG_TAGS.areas])).toThrow(
      "revalidateTag failed",
    );
  });
});
