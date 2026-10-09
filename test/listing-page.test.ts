// Phase 4b L4: the listing pages on the real catalog layer (memory DB,
// next/cache as a JSON pass-through): path resolution and 404s, metadata
// (title, description, canonical, robots), cards without any spec value,
// facets and chips, the URL builders, and the static guard (no session,
// request headers or restricted reader anywhere in the listing modules).

import { Types } from "mongoose";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SETTINGS_KEYS } from "@/lib/schemas/settings";
import { MAX_SLUG_LENGTH } from "@/lib/slug";
import { CategoryModel, ProductModel, SiteContentModel } from "@/models";
import {
  SPEC_KEYS,
  type SpecKey,
  type SpecValues,
} from "@/models/spec-columns";

import { setupMemoryDb } from "./helpers/memory-db";
import {
  importEdges,
  reachingChains,
  sourceFiles,
  SRC,
  type ImportEdge,
} from "./helpers/module-graph";
import { testPublicId } from "./helpers/public-ids";

vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: (...args: never[]) => Promise<unknown>) =>
    async (...args: never[]) =>
      JSON.parse(JSON.stringify((await fn(...args)) ?? null)) as unknown,
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
}));
// The filter and sort forms are client leaves that call useRouter; outside
// the App Router there is no router, so give them an inert one.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

import ListingPage, {
  generateMetadata,
} from "@/app/(site)/products/[[...category]]/page";
import ListingNotFound from "@/app/(site)/products/[[...category]]/not-found";
import ProductPage from "@/app/(site)/product/[slug]/page";
import { formQuery } from "@/components/site/listing/form-query";
import {
  listingMetaDescription,
  listingMetaTitle,
} from "@/components/site/listing/listing-meta";
import {
  categoryListingPath,
  clearFiltersHref,
  filterChips,
  isRefinedListing,
  listingCanonicalPath,
  pageHref,
  paginationItems,
  withoutValueHref,
} from "@/components/site/listing/listing-urls";
import { toListingCards } from "@/components/site/listing/listing-view";
import {
  DEFAULT_LISTING_PARAMS,
  parseListingParams,
  serialiseListingParams,
  SPEC_FACET_PARAMS,
  type ListingParams,
} from "@/lib/catalog/listing-params";

setupMemoryDb("yg_listing_page_l4");

const tok = (key: SpecKey, where: string) => `TOK~${key}~${where}~`;
const specsAt = (where: string): SpecValues =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, [tok(key, where)]]));
/** Any spec token in `text`. */
const anyToken = (text: string): string[] =>
  SPEC_KEYS.filter((key) => text.includes(`TOK~${key}~`));

const ids = {
  spot: new Types.ObjectId(),
  spotRecessed: new Types.ObjectId(),
  spotSurface: new Types.ObjectId(),
  down: new Types.ObjectId(),
  downRecessed: new Types.ObjectId(),
};
const SITE = "https://www.example.com";
const COVER = testPublicId(7, String(ids.spot), "category");
const RECESSED_COUNT = 26; // > 24: two pages

beforeAll(async () => {
  await CategoryModel.create([
    {
      _id: ids.spot,
      name: "Spot Lights",
      slug: "spot-lights",
      parent: null,
      order: 0,
      description: "Precise accents.\nFor retail and galleries.",
      coverImage: COVER,
    },
    {
      _id: ids.spotRecessed,
      name: "Recessed",
      slug: "recessed",
      parent: ids.spot,
      order: 0,
    },
    {
      _id: ids.spotSurface,
      name: "Surface",
      slug: "surface",
      parent: ids.spot,
      order: 1,
    },
    {
      _id: ids.down,
      name: "Downlights",
      slug: "downlights",
      parent: null,
      order: 1,
    },
    // The same sub slug under another parent (Q1: paths, not slugs).
    {
      _id: ids.downRecessed,
      name: "Recessed",
      slug: "recessed",
      parent: ids.down,
      order: 0,
    },
  ]);
  const recessed = Array.from({ length: RECESSED_COUNT }, (_, i) => ({
    status: "published" as const,
    name: `Spot ${String(i + 1).padStart(2, "0")}`,
    slug: `spot-${i + 1}`,
    family: i < 3 ? "Arc" : undefined,
    modelCode: `SP-${i + 1}`,
    productNo: i + 1,
    mainCategory: ids.spotRecessed,
    images:
      i === 0
        ? [{ publicId: testPublicId(1), order: 0, kind: "gallery" as const }]
        : [],
    specs: { ...specsAt(`P${i}`), cct: [i % 2 ? "4000K" : "3000K"] },
    filters: { cctK: [i % 2 ? 4000 : 3000], ip: i < 5 ? [65] : [20] },
    variants:
      i === 0
        ? [
            { modelNo: "SP-1A", specs: specsAt("V1") },
            { modelNo: "SP-1B", specs: specsAt("V2") },
            { modelNo: "SP-1C", specs: specsAt("V3") },
          ]
        : [{ modelNo: `SP-${i + 1}A`, specs: {} }],
  }));
  await ProductModel.create([
    ...recessed,
    {
      status: "published" as const,
      name: "Down One",
      slug: "down-one",
      mainCategory: ids.downRecessed,
      specs: specsAt("DOWN"),
      variants: [{ modelNo: "DO-1", specs: {} }],
    },
    {
      // Main category Downlights, extra category Spot Lights › Surface (Q4).
      status: "published" as const,
      name: "Dual Home",
      slug: "dual-home",
      mainCategory: ids.down,
      extraCategories: [ids.spotSurface],
      specs: specsAt("DUAL"),
      variants: [{ modelNo: "DH-1", specs: {} }],
    },
    {
      status: "draft" as const,
      name: "Hidden Draft",
      slug: "hidden-draft",
      mainCategory: ids.spotRecessed,
      specs: specsAt("DRAFT"),
      variants: [{ modelNo: "HD-1", specs: {} }],
    },
  ]);
});

beforeEach(async () => {
  vi.stubEnv("SITE_URL", SITE);
  vi.stubEnv("CLOUDINARY_URL", "cloudinary://123456:secretvalue@demo-cloud");
  await setVisibility(null);
});

async function setVisibility(value: unknown | null): Promise<void> {
  const key = SETTINGS_KEYS.columnVisibility;
  if (value === null) await SiteContentModel.deleteOne({ key });
  else
    await SiteContentModel.collection.updateOne(
      { key },
      { $set: { key, value } },
      { upsert: true },
    );
}

type Query = Record<string, string | string[] | undefined>;
const props = (category: string[] | undefined, query: Query = {}) => ({
  params: Promise.resolve({ category }),
  searchParams: Promise.resolve(query),
});

async function render(category?: string[], query: Query = {}) {
  return renderToStaticMarkup(await ListingPage(props(category, query)));
}

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  String((error as { digest?: unknown }).digest).endsWith(";404");

async function expect404(category?: string[], query: Query = {}) {
  const error = await ListingPage(props(category, query)).then(
    () => null,
    (e: unknown) => e,
  );
  expect(isNotFound(error), JSON.stringify({ category, query })).toBe(true);
  const meta = await generateMetadata(props(category, query));
  expect(meta.robots).toEqual({ index: false });
}

/** The product cards on the page. */
const cardSlugs = (html: string): string[] =>
  [...html.matchAll(/<a [^>]*data-product-card="[^"]+"[^>]*>/g)].map(
    (m) => /href="\/product\/([^"]+)"/.exec(m[0])?.[1] ?? "",
  );

describe("listing pages: rendering", () => {
  it("/products lists every published product, one h1, main category links", async () => {
    const html = await render(undefined);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain(">Products</h1>");
    expect(html).toContain('href="/products/spot-lights"');
    expect(html).toContain('href="/products/downlights"');
    expect(html).toContain("28 products");
    expect(html).not.toContain("Hidden Draft");
    // Page 1 of 2: 24 cards and a link to page 2.
    expect(cardSlugs(html)).toHaveLength(24);
    expect(html).toContain('href="/products?page=2"');
    expect(anyToken(html)).toEqual([]);
  });

  it("a sub-category path lists its own products only (same slug elsewhere is separate)", async () => {
    const spot = await render(["spot-lights", "recessed"]);
    expect(spot).toContain(">Recessed</h1>");
    expect(spot).toContain(`${RECESSED_COUNT} products`);
    expect(spot).not.toContain("Down One");
    // Breadcrumb: Products › Spot Lights › Recessed (current).
    expect(spot).toContain('aria-label="Breadcrumb"');
    expect(spot).toMatch(/href="\/products"[^>]*>Products</);
    expect(spot).toMatch(/href="\/products\/spot-lights"[^>]*>Spot Lights</);
    // Sibling links under the parent, current marked.
    expect(spot).toMatch(
      /aria-current="page"[^>]*>Recessed<|href="\/products\/spot-lights\/recessed" aria-current="page"/,
    );
    expect(spot).toContain('href="/products/spot-lights/surface"');

    const down = await render(["downlights", "recessed"]);
    expect(down).toContain("Down One");
    expect(down).toContain("1 product");
    expect(down).not.toContain("Spot 01");
  });

  it("a main category includes its subtree and extra-category products (Q4)", async () => {
    const html = await render(["spot-lights"], { page: "2" });
    // 26 recessed + Dual Home (extra category Surface) = 27 → page 2 has 3.
    expect(html).toContain("27 products");
    expect(cardSlugs(html)).toHaveLength(3);
    expect(html).toContain("Dual Home");
  });

  it("cards: link, family eyebrow, base model code, n models; never a spec value", async () => {
    const html = await render(["spot-lights", "recessed"]);
    expect(html).toContain('href="/product/spot-1"');
    expect(html).toContain("SP-1");
    expect(html).toContain("3 models");
    expect(html).toContain("Arc");
    // One model: no "1 models".
    expect(html).not.toContain("1 models");
    // The first card's photo is delivered by next/image from our cloud.
    expect(html).toContain(encodeURIComponent("res.cloudinary.com/demo-cloud"));
    expect(anyToken(html)).toEqual([]);
  });

  it("the header shows the description with its line breaks and the smart-cropped cover", async () => {
    const html = await render(["spot-lights"]);
    expect(html).toContain("Precise accents.\nFor retail and galleries.");
    expect(html).toContain("whitespace-pre-line");
    expect(html).toContain(
      encodeURIComponent(
        `res.cloudinary.com/demo-cloud/image/upload/c_fill,g_auto,ar_3:2,w_2400,q_auto/${COVER}`,
      ),
    );
  });

  it("a category without cover or description still renders its header", async () => {
    const html = await render(["downlights"]);
    expect(html).toContain(">Downlights</h1>");
    expect(html).not.toContain("c_fill");
  });

  it("filters: facets with counts, chips, clear link; the result narrows", async () => {
    const html = await render(["spot-lights", "recessed"], { cct: "3000" });
    expect(html).toContain("13 of 26 products");
    expect(html).toContain('name="cct" value="3000"');
    expect(html).toContain('aria-label="Remove filter CCT 3000K"');
    // The chip removes the value; "Clear all" keeps nothing.
    expect(html).toContain('href="/products/spot-lights/recessed"');
    expect(html).toContain("Clear all");
    // Without JS: a visible Apply button submitting a GET form.
    expect(html).toContain('method="get"');
    expect(html).toContain("Apply filters");
    expect(anyToken(html)).toEqual([]);
  });

  it("an impossible filter value answers the empty state and keeps the chip", async () => {
    const html = await render(["spot-lights", "recessed"], { cct: "5000" });
    expect(html).toContain("No products match these filters");
    expect(html).toContain('aria-label="Remove filter CCT 5000K"');
    expect(html).toContain("Clear all filters");
  });

  it("a restricted facet is neither offered nor applied", async () => {
    await setVisibility({ cct: "restricted" });
    const html = await render(["spot-lights", "recessed"], { cct: "3000" });
    expect(html).not.toContain('name="cct"');
    expect(html).not.toContain("Remove filter CCT");
    expect(html).toContain("26 products");
    const meta = await generateMetadata(
      props(["spot-lights", "recessed"], { cct: "3000" }),
    );
    expect(meta.robots).toBeUndefined();
  });
});

describe("listing pages: 404", () => {
  it.each([
    [["no-such-category"]],
    [["recessed"]], // a sub slug is not a main category
    [["spot-lights", "nope"]],
    [["downlights", "surface"]], // a child of another parent
    [["spot-lights", "recessed", "extra"]],
    [["BAD SLUG"]],
    [["x".repeat(500)]],
  ])("%j is a 404 with noindex metadata", async (category) => {
    await expect404(category);
  });

  it("a page past the end is a 404; page 1 of an empty listing is not", async () => {
    await expect404(["spot-lights", "recessed"], { page: "3" });
    await expect404(["spot-lights", "recessed"], { cct: "5000", page: "2" });
    const html = await render(["spot-lights", "recessed"], { cct: "5000" });
    expect(html).toContain("No products match these filters");
  });

  it("the listing 404 page offers a way back", () => {
    const html = renderToStaticMarkup(createElement(ListingNotFound));
    expect(html).toContain("Page not found");
    expect(html).toContain('href="/products"');
  });
});

describe("listing pages: metadata", () => {
  const meta = (category?: string[], query: Query = {}) =>
    generateMetadata(props(category, query));

  it("indexable listings: title, description, canonical path", async () => {
    const root = await meta(undefined);
    expect(root.title).toBe("Products");
    expect(root.alternates?.canonical).toBe(`${SITE}/products`);
    expect(root.robots).toBeUndefined();

    const main = await meta(["spot-lights"]);
    expect(main.title).toBe("Spot Lights");
    expect(main.description).toBe("Precise accents. For retail and galleries.");
    expect(main.alternates?.canonical).toBe(`${SITE}/products/spot-lights`);
    expect(JSON.stringify(main.openGraph)).toContain("c_fill,g_auto");

    const sub = await meta(["spot-lights", "recessed"]);
    expect(sub.title).toBe("Recessed – Spot Lights");
    expect(sub.description).toBe(
      "Recessed in the YG UniLUX commercial lighting catalog.",
    );
  });

  it("page 2 is canonical to itself", async () => {
    const page2 = await meta(["spot-lights", "recessed"], { page: "2" });
    expect(page2.title).toBe("Recessed – Spot Lights – page 2");
    expect(page2.alternates?.canonical).toBe(
      `${SITE}/products/spot-lights/recessed?page=2`,
    );
    expect(page2.robots).toBeUndefined();
  });

  it.each<Query>([
    { cct: "3000" },
    { ip: "65,20" },
    { sort: "name" },
    { sort: "newest", page: "2" },
    // Unknown value: the uncached empty answer keeps it, still noindex.
    { cct: "5000" },
  ])("%j is noindex, follow with the clean canonical", async (query) => {
    const result = await meta(["spot-lights", "recessed"], query);
    expect(result.robots).toEqual({ index: false, follow: true });
    expect(String(result.alternates?.canonical)).not.toMatch(/cct|ip=|sort/);
  });

  it("junk params are ignored: indexable, canonical without them", async () => {
    const result = await meta(["spot-lights"], {
      cct: "abc",
      foo: "bar",
      page: "zero",
    });
    expect(result.robots).toBeUndefined();
    expect(result.alternates?.canonical).toBe(`${SITE}/products/spot-lights`);
  });

  it("metadata never holds a spec value", async () => {
    const result = await meta(["spot-lights", "recessed"], { cct: "3000" });
    expect(anyToken(JSON.stringify(result))).toEqual([]);
  });

  it("listingMetaDescription cuts long text at a word", () => {
    const long = `${"word ".repeat(60)}end`;
    const out = listingMetaDescription(long, "fallback");
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith("word…")).toBe(true);
    expect(listingMetaDescription("  ", "fallback")).toBe("fallback");
    expect(listingMetaTitle([], "Products", 1)).toBe("Products");
    expect(listingMetaTitle([{ name: "A" }], "Products", 3)).toBe("A – page 3");
  });
});

describe("product page breadcrumb", () => {
  it("links category steps to their listing paths", async () => {
    const html = renderToStaticMarkup(
      await ProductPage({
        params: Promise.resolve({ slug: "spot-1" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toMatch(/href="\/products\/spot-lights"[^>]*>Spot Lights</);
    expect(html).toMatch(
      /href="\/products\/spot-lights\/recessed"[^>]*>Recessed</,
    );
    expect(html).not.toContain("?category=");
  });
});

describe("listing cards hold no spec data", () => {
  it("toListingCards copies only card fields", () => {
    const cards = toListingCards(
      [
        {
          id: "a",
          slug: "a",
          name: "A",
          family: "F",
          modelCode: "M",
          variantCount: 2,
          image: { publicId: "p", alt: null, order: 0, kind: "gallery" },
          // A stray field must never be copied through.
          ...({ specs: { driver: ["TOK~driver~X~"] } } as object),
        },
      ],
      "demo-cloud",
    );
    expect(Object.keys(cards[0] ?? {}).sort()).toEqual([
      "family",
      "href",
      "id",
      "image",
      "modelCode",
      "name",
      "variantCount",
    ]);
    expect(JSON.stringify(cards)).not.toContain("TOK~");
  });
});

describe("listing URL builders", () => {
  const BASE = "/products/spot-lights";
  const params = (query: string): ListingParams =>
    parseListingParams(new URLSearchParams(query), {
      publicFacets: SPEC_FACET_PARAMS,
      track: true,
      cat: true,
    });

  it("category paths", () => {
    expect(categoryListingPath([])).toBe("/products");
    expect(categoryListingPath([{ slug: "a" }, { slug: "b" }])).toBe(
      "/products/a/b",
    );
  });

  it("removing a chip drops that value and the page, keeps the rest", () => {
    const p = params("cct=4000,3000&ip=65&sort=name&page=3");
    expect(withoutValueHref(BASE, p, "cct", "3000")).toBe(
      `${BASE}?cct=4000&ip=65&sort=name`,
    );
    expect(withoutValueHref(BASE, p, "ip", "65")).toBe(
      `${BASE}?cct=3000,4000&sort=name`,
    );
    // The input is never mutated.
    expect(p.cct).toEqual([3000, 4000]);
  });

  it("clear all keeps only the sort; page links keep everything", () => {
    const p = params("cct=3000&w=0-10&sort=newest&page=2");
    expect(clearFiltersHref(BASE, p)).toBe(`${BASE}?sort=newest`);
    expect(clearFiltersHref(BASE, params("cct=3000"))).toBe(BASE);
    expect(pageHref(BASE, p, 1)).toBe(`${BASE}?cct=3000&w=0-10&sort=newest`);
    expect(pageHref(BASE, p, 5)).toBe(
      `${BASE}?cct=3000&w=0-10&sort=newest&page=5`,
    );
  });

  it("chips are labelled and ordered like the query", () => {
    const p = params("ip=65&cct=3000&w=41%2B&track=10&cat=spot-lights");
    const chips = filterChips(
      BASE,
      p,
      new Map([["spot-lights", "Spot Lights"]]),
    );
    expect(chips.map((c) => c.label)).toEqual([
      "Spot Lights",
      "10 mm",
      "3000K",
      "Over 40 W",
      "IP65",
    ]);
    expect(chips.map((c) => c.facetLabel)).toEqual([
      "Category",
      "Track size",
      "CCT",
      "Wattage",
      "IP rating",
    ]);
  });

  it("refined = any filter or a non-default sort", () => {
    expect(isRefinedListing(params(""))).toBe(false);
    expect(isRefinedListing(params("page=4"))).toBe(false);
    expect(isRefinedListing(params("sort=name"))).toBe(true);
    expect(isRefinedListing(params("ugr=19"))).toBe(true);
    expect(listingCanonicalPath(BASE, 1)).toBe(BASE);
    expect(listingCanonicalPath(BASE, 2)).toBe(`${BASE}?page=2`);
  });

  it("pagination items: first, last, current ±1, gaps", () => {
    expect(paginationItems(1, 1)).toEqual([]);
    expect(paginationItems(1, 2)).toEqual([1, 2]);
    expect(paginationItems(1, 5)).toEqual([1, 2, "gap", 5]);
    expect(paginationItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(paginationItems(6, 12)).toEqual([1, "gap", 5, 6, 7, "gap", 12]);
    expect(paginationItems(12, 12)).toEqual([1, "gap", 11, 12]);
  });

  it("the client form query equals the server serialiser", () => {
    const cases: [string, string][][] = [
      [],
      [
        ["cct", "3000"],
        ["cct", "4000"],
        ["ip", "65"],
      ],
      [
        ["sort", "name"],
        ["w", "0-10"],
        ["w", "41+"],
        ["track", "5"],
      ],
      [
        ["sort", "catalog"],
        ["cri", "90"],
        ["cri", "90"],
        ["beam", "24"],
      ],
      [
        ["cat", "a-b"],
        ["ugr", "19"],
        ["ip", "20"],
        ["page", "4"],
      ],
    ];
    for (const entries of cases) {
      const server = serialiseListingParams({
        ...params(new URLSearchParams(entries).toString()),
        page: 1,
      });
      expect(formQuery(entries), JSON.stringify(entries)).toBe(server);
    }
    // Junk keys and values never reach the client query.
    expect(
      formQuery([
        ["foo", "1"],
        ["cct", "<script>"],
        ["cct", "3000"],
      ]),
    ).toBe("cct=3000");
    // The longest allowed category slug survives on both sides.
    const longSlug = "a".repeat(MAX_SLUG_LENGTH);
    expect(formQuery([["cat", longSlug]])).toBe(`cat=${longSlug}`);
    expect(
      serialiseListingParams({
        ...params(`cat=${longSlug}`),
        page: 1,
      }),
    ).toBe(`cat=${longSlug}`);
    expect(serialiseListingParams(DEFAULT_LISTING_PARAMS)).toBe("");
  });
});

describe("listing modules (static guard)", () => {
  const FILES = [
    ...sourceFiles(`${SRC}/app/(site)/products`),
    ...sourceFiles(`${SRC}/components/site/listing`),
  ];
  const forbidden = (edge: ImportEdge): boolean =>
    /next\/headers|better-auth/.test(edge.spec) ||
    (edge.file !== null &&
      /lib[\\/](permissions|auth|session-cookie)\.ts$|lib[\\/]catalog[\\/]restricted\.ts$/.test(
        edge.file,
      ));

  it("finds the modules", () => {
    expect(FILES.length).toBeGreaterThan(8);
    expect(
      importEdges(`${SRC}/app/(site)/products/[[...category]]/page.tsx`).length,
    ).toBeGreaterThan(5);
    expect(
      reachingChains(
        `${SRC}/app/(site)/products/[[...category]]/page.tsx`,
        (edge) => /lib[\\/]catalog[\\/]listing\.ts$/.test(edge.file ?? ""),
      ),
    ).not.toEqual([]);
  });

  it("never reach the session, request headers or the restricted reader", () => {
    expect(FILES.flatMap((file) => reachingChains(file, forbidden))).toEqual(
      [],
    );
  }, 60_000);
});
