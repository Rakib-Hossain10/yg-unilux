// Phase 4b L6: header product menu, search UI helpers, /search page, sitemap
// paths and the category icon URL helper.
//   - icon URLs always carry an explicit raster format (f_png / f_webp,
//     w_96,h_96,c_fit,q_auto), never f_auto (gate-A I-1 must-do);
//   - the menu hides categories with no published product, keeps tree order,
//     links via categoryListingPath, and falls back to null (plain links)
//     when the catalog cannot be read, silently without a database;
//   - search links: ?model=<matched model no.>, category paths, constants
//     pinned to the server's; the answer parser keeps only shown fields;
//   - /search renders results without JavaScript, never indexed;
//   - sitemap paths: no query strings, empty categories left out.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: (...args: never[]) => Promise<unknown>) =>
    async (...args: never[]) =>
      JSON.parse(JSON.stringify((await fn(...args)) ?? null)) as unknown,
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
}));

const readers = vi.hoisted(() => ({
  categories: vi.fn(),
  counts: vi.fn(),
  areas: vi.fn(),
  search: vi.fn(),
}));

vi.mock("@/lib/catalog/categories", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/catalog/categories")>()),
  listPublicCategories: readers.categories,
}));
vi.mock("@/lib/catalog/category-counts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/catalog/category-counts")>()),
  listPublishedCategoryCounts: readers.counts,
}));
vi.mock("@/lib/catalog/areas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/catalog/areas")>()),
  listPublicAreas: readers.areas,
}));
vi.mock("@/lib/catalog/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/catalog/search")>()),
  searchCatalog: readers.search,
}));

import SearchPage, { generateMetadata } from "@/app/(site)/search/page";
import { cloudinaryDeliveryUrl } from "@/components/site/cloudinary-delivery";
import {
  CLOUDINARY_TRANSFORMS,
  categoryIconUrl,
  cloudinaryImageUrl,
} from "@/components/site/cloudinary-image";
import { categoryListingPath } from "@/components/site/listing/listing-urls";
import type { SiteMenu } from "@/components/site/menu/menu-types";
import { buildSiteMenu, loadSiteMenu } from "@/components/site/menu/site-menu";
import { MODEL_PARAM } from "@/components/site/product/variant-selection";
import {
  parseSearchAnswer,
  resultSummary,
  SEARCH_INPUT_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  searchCategoryHref,
  searchPageHref,
  searchProductHref,
} from "@/components/site/search/search-links";
import { SiteHeader } from "@/components/site/site-header";
import { catalogSitemapPaths } from "@/components/site/sitemap-paths";
import type { PublicCategoryView } from "@/lib/catalog/categories";
import { EnvError } from "@/lib/env";
import {
  MAX_SEARCH_LENGTH,
  MIN_SEARCH_LENGTH,
  type SearchResult,
} from "@/lib/catalog/search";
import { SPEC_KEYS } from "@/models/spec-columns";

const CLOUD = "demo-cloud";

const cat = (
  id: string,
  name: string,
  slug: string,
  parentId: string | null,
  extra: Partial<PublicCategoryView> = {},
): PublicCategoryView => ({
  id,
  name,
  slug,
  parentId,
  order: 0,
  icon: null,
  coverImage: null,
  description: null,
  ...extra,
});

/* Spot (published through Recessed), Down (empty), Track (published directly). */
const TREE: PublicCategoryView[] = [
  cat("a", "Spot Lights", "spot", null, {
    icon: "yg/categories/a/icon",
    description: "  Accent light.\nFor retail.  ",
  }),
  cat("b", "Down Lights", "down", null, { icon: "yg/categories/b/icon" }),
  cat("c", "Track", "track", null),
  cat("a1", "Recessed", "recessed", "a"),
  cat("a2", "Surface", "surface", "a"),
  cat("b1", "Recessed", "recessed", "b"),
];
const COUNTS: [string, number][] = [
  ["a1", 3],
  ["c", 1],
  ["b1", 0],
];
const AREAS = [
  { id: "r1", name: "Retail", slug: "retail", bwImage: null },
  { id: "h1", name: "Hospitality", slug: "hospitality", bwImage: null },
];

// ---------------------------------------------------------------------------
// Category icon URL helper (gate-A I-1 must-do)
// ---------------------------------------------------------------------------

describe("categoryIconUrl", () => {
  it("delivers a 96 px PNG by default and WebP on request, never f_auto", () => {
    expect(categoryIconUrl(CLOUD, "yg/categories/a/icon")).toBe(
      "https://res.cloudinary.com/demo-cloud/image/upload/w_96,h_96,c_fit,f_png,q_auto/yg/categories/a/icon",
    );
    expect(categoryIconUrl(CLOUD, "yg/categories/a/icon", "webp")).toBe(
      "https://res.cloudinary.com/demo-cloud/image/upload/w_96,h_96,c_fit,f_webp,q_auto/yg/categories/a/icon",
    );
    expect(CLOUDINARY_TRANSFORMS.categoryIconPng).toBe(
      "w_96,h_96,c_fit,f_png,q_auto",
    );
    expect(CLOUDINARY_TRANSFORMS.categoryIconWebp).toBe(
      "w_96,h_96,c_fit,f_webp,q_auto",
    );
    for (const value of Object.values(CLOUDINARY_TRANSFORMS)) {
      expect(value).not.toMatch(/f_auto/);
    }
  });

  it("is null without a cloud name or an icon; encodes path segments", () => {
    expect(categoryIconUrl(null, "x")).toBeNull();
    expect(categoryIconUrl(CLOUD, null)).toBeNull();
    expect(categoryIconUrl(CLOUD, undefined)).toBeNull();
    expect(categoryIconUrl(CLOUD, "")).toBeNull();
    expect(categoryIconUrl(CLOUD, "a b/ç")).toContain("/a%20b/%C3%A7");
  });

  it("the client-safe builder and the server helper build the same URL", () => {
    expect(cloudinaryDeliveryUrl(CLOUD, "p/1")).toBe(
      cloudinaryImageUrl(CLOUD, "p/1"),
    );
    expect(cloudinaryDeliveryUrl(null, "p/1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Menu data
// ---------------------------------------------------------------------------

describe("buildSiteMenu", () => {
  const menu = buildSiteMenu(TREE, COUNTS, AREAS, CLOUD);

  it("hides categories with no published product in their subtree", () => {
    expect(menu.categories.map((c) => c.name)).toEqual([
      "Spot Lights",
      "Track",
    ]);
    expect(menu.categories[0]?.children.map((c) => c.name)).toEqual([
      "Recessed",
    ]);
  });

  it("links via categoryListingPath (parent in the path) and the areas", () => {
    const spot = menu.categories[0];
    expect(spot?.href).toBe(categoryListingPath([{ slug: "spot" }]));
    expect(spot?.children[0]?.href).toBe("/products/spot/recessed");
    expect(menu.categories[1]?.href).toBe("/products/track");
    expect(menu.areas).toEqual([
      { id: "r1", name: "Retail", href: "/areas/retail" },
      { id: "h1", name: "Hospitality", href: "/areas/hospitality" },
    ]);
  });

  it("raster icon URL, trimmed description, no icon = null", () => {
    expect(menu.categories[0]?.iconSrc).toBe(
      categoryIconUrl(CLOUD, "yg/categories/a/icon", "png"),
    );
    expect(menu.categories[0]?.description).toBe("Accent light.\nFor retail.");
    expect(menu.categories[1]?.iconSrc).toBeNull();
    expect(menu.categories[1]?.description).toBeNull();
    expect(
      buildSiteMenu(TREE, COUNTS, AREAS, null).categories[0]?.iconSrc,
    ).toBeNull();
  });

  it("holds no product field or spec key", () => {
    const json = JSON.stringify(menu);
    for (const key of SPEC_KEYS) expect(json).not.toContain(`"${key}"`);
    expect(json).not.toMatch(/"(specs|variants|filters|status)"/);
  });

  it("is empty with nothing published", () => {
    expect(buildSiteMenu(TREE, [], [], CLOUD)).toEqual({
      categories: [],
      areas: [],
    });
  });
});

describe("loadSiteMenu", () => {
  beforeEach(() => {
    readers.categories.mockReset();
    readers.counts.mockReset();
    readers.areas.mockReset();
  });

  it("builds the menu from the cached readers", async () => {
    readers.categories.mockResolvedValue(TREE);
    readers.counts.mockResolvedValue(COUNTS);
    readers.areas.mockResolvedValue(AREAS);
    const menu = await loadSiteMenu();
    expect(menu?.categories.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("falls back to null, silently when no database is configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readers.categories.mockRejectedValue(
      new EnvError("MongoDB", [{ kind: "missing", variable: "MONGODB_URI" }]),
    );
    readers.counts.mockResolvedValue([]);
    readers.areas.mockResolvedValue([]);
    expect(await loadSiteMenu()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back to null and logs the error name only on an outage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("connect ECONNREFUSED secret-host");
    error.name = "MongoServerSelectionError";
    readers.categories.mockResolvedValue(TREE);
    readers.counts.mockRejectedValue(error);
    readers.areas.mockResolvedValue([]);
    expect(await loadSiteMenu()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("MongoServerSelectionError");
    expect(line).not.toContain("secret-host");
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

describe("SiteHeader with a menu", () => {
  const menu: SiteMenu = buildSiteMenu(TREE, COUNTS, AREAS, CLOUD);

  it("server HTML: Product stays a link, the mobile menu nests categories", () => {
    const html = renderToStaticMarkup(SiteHeader({ menu }));
    // No-JS: the desktop item is a plain link until the button hydrates.
    expect(html).toContain('href="/products"');
    expect(html).toContain('data-slot="mobile-products"');
    expect(html).toContain('href="/products/spot/recessed"');
    expect(html).toContain('href="/areas/retail"');
    expect(html).not.toContain("Down Lights");
    // Search is a link to the results page until the overlay hydrates.
    expect(html).toMatch(/<a aria-label="Search"[^>]*href="\/search"/);
  });

  it("without a menu, Product is a plain link and nothing nests", () => {
    const html = renderToStaticMarkup(SiteHeader());
    expect(html).toContain('href="/products"');
    expect(html).not.toContain('data-slot="mobile-products"');
  });
});

// ---------------------------------------------------------------------------
// Search links and answer parsing
// ---------------------------------------------------------------------------

describe("search links", () => {
  it("constants match the server's", () => {
    expect(SEARCH_INPUT_MAX_LENGTH).toBe(MAX_SEARCH_LENGTH);
    expect(SEARCH_MIN_LENGTH).toBe(MIN_SEARCH_LENGTH);
  });

  it("a model-no. hit opens that variant with ?model=", () => {
    expect(
      searchProductHref({ slug: "arc-ar-013a", matchedModelNo: "AR-013A2" }),
    ).toBe(`/product/arc-ar-013a?${MODEL_PARAM}=AR-013A2`);
    expect(searchProductHref({ slug: "arc", matchedModelNo: "A/B 1&2" })).toBe(
      "/product/arc?model=A%2FB%201%262",
    );
    expect(searchProductHref({ slug: "arc", matchedModelNo: null })).toBe(
      "/product/arc",
    );
  });

  it("category hits use the listing path (sub slugs need the parent)", () => {
    expect(searchCategoryHref({ slugPath: ["spot", "recessed"] })).toBe(
      categoryListingPath([{ slug: "spot" }, { slug: "recessed" }]),
    );
    expect(searchCategoryHref({ slugPath: [] })).toBe("/products");
  });

  it("results page href", () => {
    expect(searchPageHref("  ar 013 ")).toBe("/search?q=ar%20013");
    expect(searchPageHref("  ")).toBe("/search");
  });

  it("summary line", () => {
    expect(resultSummary(0, 0)).toBe("No results");
    expect(resultSummary(1, 0)).toBe("1 product");
    expect(resultSummary(3, 1)).toBe("3 products and 1 category");
    expect(resultSummary(0, 2)).toBe("2 categories");
  });

  it("the parser keeps only the shown fields and rejects other shapes", () => {
    const answer = parseSearchAnswer({
      query: "ar",
      products: [
        {
          id: "1",
          slug: "arc",
          name: "Arc",
          family: "Arc",
          modelCode: "AR-013A",
          matchedModelNo: "AR-013A2",
          variantCount: 2,
          specs: { driver: ["SECRET"] },
          image: { publicId: "p/1", alt: null, order: 0, kind: "gallery" },
        },
        { id: "2", name: "No slug" },
        "junk",
      ],
      categories: [
        {
          id: "c",
          name: "Spot",
          slug: "spot",
          path: ["Spot"],
          slugPath: ["spot"],
        },
        { id: "d", name: "Bad", path: "x", slugPath: [] },
      ],
    });
    expect(answer?.products).toEqual([
      {
        id: "1",
        slug: "arc",
        name: "Arc",
        family: "Arc",
        modelCode: "AR-013A",
        matchedModelNo: "AR-013A2",
        image: { publicId: "p/1", alt: null },
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain("SECRET");
    expect(answer?.categories).toHaveLength(1);
    expect(parseSearchAnswer(null)).toBeNull();
    expect(parseSearchAnswer({ query: "x", products: {} })).toBeNull();
    expect(parseSearchAnswer({ message: "Invalid search query." })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /search page
// ---------------------------------------------------------------------------

const RESULT: SearchResult = {
  query: "ar-013a2",
  products: [
    {
      id: "p1",
      slug: "arc-ar-013a",
      name: "Arc",
      family: null,
      modelCode: "AR-013A",
      image: null,
      variantCount: 2,
      matchedModelNo: "AR-013A2",
    },
  ],
  categories: [
    {
      id: "c1",
      name: "Recessed",
      slug: "recessed",
      path: ["Spot Lights", "Recessed"],
      slugPath: ["spot", "recessed"],
    },
  ],
};

const pageProps = (q?: string | string[]) =>
  ({
    params: Promise.resolve({}),
    searchParams: Promise.resolve(q === undefined ? {} : { q }),
  }) as unknown as PageProps<"/search">;

describe("/search page", () => {
  beforeEach(() => readers.search.mockReset());

  it("renders hits as links: variant hit with ?model=, category path", async () => {
    readers.search.mockResolvedValue(RESULT);
    const html = renderToStaticMarkup(await SearchPage(pageProps("ar-013a2")));
    expect(readers.search).toHaveBeenCalledWith("ar-013a2");
    expect(html).toContain('href="/product/arc-ar-013a?model=AR-013A2"');
    expect(html).toContain("AR-013A2");
    expect(html).toContain('href="/products/spot/recessed"');
    expect(html).toContain("Spot Lights › Recessed");
    expect(html).toContain("1 product and 1 category for “ar-013a2”.");
    // A GET form with the bounded input: works without JavaScript.
    expect(html).toMatch(/<form[^>]*action="\/search"[^>]*method="get"/);
    expect(html).toContain('maxLength="64"');
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("no query: no search; prompt", async () => {
    const html = renderToStaticMarkup(await SearchPage(pageProps()));
    expect(readers.search).not.toHaveBeenCalled();
    expect(html).toContain("Type a product name, family or model number.");
  });

  it("no match: says so and links to all products", async () => {
    readers.search.mockResolvedValue({
      query: "zz",
      products: [],
      categories: [],
    });
    const html = renderToStaticMarkup(await SearchPage(pageProps("zz")));
    expect(html).toContain("No products or categories match “zz”.");
    expect(html).toContain('href="/products"');
  });

  it("first q only, cut to 64 characters before searching", async () => {
    readers.search.mockResolvedValue({
      query: "",
      products: [],
      categories: [],
    });
    await SearchPage(pageProps(["x".repeat(300), "second"]));
    expect(readers.search).toHaveBeenCalledWith("x".repeat(64));
  });

  it("is never indexed", async () => {
    const meta = await generateMetadata(pageProps("arc"));
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.title).toBe("Search: arc");
    expect((await generateMetadata(pageProps())).title).toBe("Search");
  });
});

// ---------------------------------------------------------------------------
// Sitemap paths
// ---------------------------------------------------------------------------

describe("catalogSitemapPaths", () => {
  it("listing root, published category paths, areas; no query strings", () => {
    const paths = catalogSitemapPaths(TREE, COUNTS, AREAS);
    expect(paths).toEqual([
      "/products",
      "/products/spot",
      "/products/spot/recessed",
      "/products/track",
      "/areas",
      "/areas/retail",
      "/areas/hospitality",
    ]);
    for (const path of paths) expect(path).not.toContain("?");
  });
});
