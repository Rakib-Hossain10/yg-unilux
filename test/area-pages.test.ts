// Phase 4b L5: the /areas index and /areas/<slug> listing on the real catalog
// layer (memory DB, next/cache as a JSON pass-through): tiles from the DB in
// admin order (with and without a photo), the area scope and its category
// facet, chips with category names, 404s, metadata (canonical, robots), no
// spec value or draft anywhere, the shared listing loader's query key, and
// the static guard (no session, request headers or restricted reader).

import { Types } from "mongoose";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AreaModel, CategoryModel, ProductModel } from "@/models";
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
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));
// connection() needs a request scope; outside Next it is a no-op here.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

import AreaPage, { generateMetadata } from "@/app/(site)/areas/[slug]/page";
import AreaNotFound from "@/app/(site)/areas/[slug]/not-found";
import AreasPage, {
  generateMetadata as areasMetadata,
} from "@/app/(site)/areas/page";
import { rawListingQuery } from "@/components/site/listing/listing-load";
import { areaListingPath } from "@/components/site/listing/listing-urls";

setupMemoryDb("yg_area_pages_l5");

const tok = (key: SpecKey, where: string) => `TOK~${key}~${where}~`;
const specsAt = (where: string): SpecValues =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, [tok(key, where)]]));
const anyToken = (text: string): string[] =>
  SPEC_KEYS.filter((key) => text.includes(`TOK~${key}~`));

const ids = {
  spot: new Types.ObjectId(),
  spotRecessed: new Types.ObjectId(),
  down: new Types.ObjectId(),
  retail: new Types.ObjectId(),
  office: new Types.ObjectId(),
  healthcare: new Types.ObjectId(),
};
const SITE = "https://www.example.com";
const RETAIL_IMAGE = testPublicId(3, String(ids.retail), "area");
const RETAIL_SPOTS = 25; // > 24: two pages

beforeAll(async () => {
  await CategoryModel.create([
    {
      _id: ids.spot,
      name: "Spot Lights",
      slug: "spot-lights",
      parent: null,
      order: 0,
    },
    {
      _id: ids.spotRecessed,
      name: "Recessed",
      slug: "recessed",
      parent: ids.spot,
      order: 0,
    },
    {
      _id: ids.down,
      name: "Downlights",
      slug: "downlights",
      parent: null,
      order: 1,
    },
  ]);
  // Office first in admin order, though "Retail" sorts later by name.
  await AreaModel.create([
    {
      _id: ids.retail,
      name: "Retail",
      slug: "retail",
      order: 1,
      bwImage: RETAIL_IMAGE,
    },
    { _id: ids.office, name: "Office", slug: "office", order: 0 },
    { _id: ids.healthcare, name: "Healthcare", slug: "healthcare", order: 2 },
  ]);
  const spots = Array.from({ length: RETAIL_SPOTS }, (_, i) => ({
    status: "published" as const,
    name: `Shop Spot ${String(i + 1).padStart(2, "0")}`,
    slug: `shop-spot-${i + 1}`,
    modelCode: `SS-${i + 1}`,
    mainCategory: ids.spotRecessed,
    areas: [ids.retail],
    specs: { ...specsAt(`S${i}`), cct: [i % 2 ? "4000K" : "3000K"] },
    filters: { cctK: [i % 2 ? 4000 : 3000] },
    variants: [{ modelNo: `SS-${i + 1}A`, specs: specsAt(`SV${i}`) }],
  }));
  await ProductModel.create([
    ...spots,
    {
      status: "published" as const,
      name: "Shop Down",
      slug: "shop-down",
      mainCategory: ids.down,
      areas: [ids.retail, ids.office],
      specs: specsAt("DOWN"),
      filters: { cctK: [3000] },
      variants: [{ modelNo: "SD-1", specs: {} }],
    },
    {
      status: "published" as const,
      name: "Desk Only",
      slug: "desk-only",
      mainCategory: ids.down,
      areas: [ids.office],
      specs: specsAt("DESK"),
      variants: [{ modelNo: "DK-1", specs: {} }],
    },
    {
      status: "draft" as const,
      name: "Retail Draft",
      slug: "retail-draft",
      mainCategory: ids.spotRecessed,
      areas: [ids.retail],
      specs: specsAt("DRAFT"),
      variants: [{ modelNo: "RD-1", specs: {} }],
    },
  ]);
});

beforeEach(() => {
  vi.stubEnv("SITE_URL", SITE);
  vi.stubEnv("CLOUDINARY_URL", "cloudinary://123456:secretvalue@demo-cloud");
});

type Query = Record<string, string | string[] | undefined>;
const props = (slug: string, query: Query = {}) => ({
  params: Promise.resolve({ slug }),
  searchParams: Promise.resolve(query),
});
const render = async (slug: string, query: Query = {}) =>
  renderToStaticMarkup(await AreaPage(props(slug, query)));

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  String((error as { digest?: unknown }).digest).endsWith(";404");

async function expect404(slug: string, query: Query = {}) {
  const error = await AreaPage(props(slug, query)).then(
    () => null,
    (e: unknown) => e,
  );
  expect(isNotFound(error), JSON.stringify({ slug, query })).toBe(true);
  const meta = await generateMetadata(props(slug, query));
  expect(meta.robots).toEqual({ index: false });
}

const cardSlugs = (html: string): string[] =>
  [...html.matchAll(/<a [^>]*data-product-card="[^"]+"[^>]*>/g)].map(
    (m) => /href="\/product\/([^"]+)"/.exec(m[0])?.[1] ?? "",
  );

describe("/areas index", () => {
  it("lists every area from the DB in admin order, as linked tiles", async () => {
    const html = renderToStaticMarkup(await AreasPage());
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain(">Applications</h1>");
    const hrefs = [...html.matchAll(/data-area-tile="[^"]+"/g)].length;
    expect(hrefs).toBe(3);
    const order = ["/areas/office", "/areas/retail", "/areas/healthcare"].map(
      (href) => html.indexOf(`href="${href}"`),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Retail has a photo (greyscale), Office has none (name field instead).
    expect(html).toContain(
      encodeURIComponent(
        `res.cloudinary.com/demo-cloud/image/upload/${RETAIL_IMAGE}`,
      ),
    );
    expect(html).toContain("grayscale");
    expect(html.match(/<img /g)).toHaveLength(1);
  });

  it("metadata: title, description, canonical", () => {
    const meta = areasMetadata();
    expect(meta.title).toBe("Applications");
    expect(meta.alternates?.canonical).toBe(`${SITE}/areas`);
    expect(meta.robots).toBeUndefined();
  });
});

describe("area pages: rendering", () => {
  it("lists the area's published products, header, breadcrumb, area links", async () => {
    const html = await render("retail");
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain(">Retail</h1>");
    expect(html).toContain(`${RETAIL_SPOTS + 1} products`);
    expect(cardSlugs(html)).toHaveLength(24);
    expect(html).toContain('href="/areas/retail?page=2"');
    expect(html).not.toContain("Retail Draft");
    expect(html).not.toContain("Desk Only");
    // Breadcrumb Applications › Retail; the other areas as links.
    expect(html).toMatch(/href="\/areas"[^>]*>Applications</);
    expect(html).toContain('href="/areas/office"');
    expect(html).toMatch(/aria-current="page"[^>]*href="\/areas\/retail"/);
    // The bw cover, smart-cropped to the header frame, in greyscale.
    expect(html).toContain(
      encodeURIComponent(
        `res.cloudinary.com/demo-cloud/image/upload/c_fill,g_auto,ar_3:2,w_2400,q_auto/${RETAIL_IMAGE}`,
      ),
    );
    // The cover image keeps both its fill and its greyscale class.
    const cover = /<img [^>]*c_fill[^>]*>/.exec(html)?.[0] ?? "";
    expect(cover).toMatch(/class="object-cover grayscale"/);
    expect(anyToken(html)).toEqual([]);
  });

  it("an area without a photo still renders its header", async () => {
    const html = await render("office");
    expect(html).toContain(">Office</h1>");
    expect(html).not.toContain("c_fill");
    expect(cardSlugs(html).sort()).toEqual(["desk-only", "shop-down"]);
  });

  it("an area with no product shows the empty state", async () => {
    const html = await render("healthcare");
    expect(html).toContain("Nothing here yet");
    expect(html).toContain('href="/products"');
  });

  it("the category facet lists main categories with counts and narrows the list", async () => {
    const all = await render("retail");
    expect(all).toContain('name="cat" value="spot-lights"');
    expect(all).toContain('name="cat" value="downlights"');

    const down = await render("retail", { cat: "downlights" });
    expect(down).toContain(`1 of ${RETAIL_SPOTS + 1} products`);
    expect(cardSlugs(down)).toEqual(["shop-down"]);
    // The chip shows the category name and removes the filter.
    expect(down).toContain('aria-label="Remove filter Category Downlights"');
    expect(down).toContain('href="/areas/retail"');

    const spots = await render("retail", { cat: "spot-lights", cct: "3000" });
    expect(spots).toContain(`13 of ${RETAIL_SPOTS + 1} products`);
    expect(anyToken(spots)).toEqual([]);
  });

  it("an unknown category slug is dropped", async () => {
    const html = await render("retail", { cat: "nope" });
    expect(html).toContain(`${RETAIL_SPOTS + 1} products`);
    expect(html).not.toContain("Remove filter");
  });
});

describe("area pages: 404", () => {
  it.each(["no-such-area", "BAD SLUG", "x".repeat(500), "spot-lights"])(
    "%j is a 404 with noindex metadata",
    async (slug) => {
      await expect404(slug);
    },
  );

  it("a page past the end is a 404", async () => {
    await expect404("retail", { page: "3" });
    await expect404("office", { page: "2" });
    expect(await render("retail", { page: "2" })).toContain("Shop Spot");
  });

  it("the area 404 page offers a way back", () => {
    const html = renderToStaticMarkup(createElement(AreaNotFound));
    expect(html).toContain('href="/areas"');
    expect(html).toContain('href="/products"');
  });
});

describe("area pages: metadata", () => {
  const meta = (slug: string, query: Query = {}) =>
    generateMetadata(props(slug, query));

  it("indexable: title, description, canonical, cover", async () => {
    const result = await meta("retail");
    expect(result.title).toBe("Retail – Applications");
    expect(result.description).toContain("Retail lighting");
    expect(result.alternates?.canonical).toBe(`${SITE}/areas/retail`);
    expect(result.robots).toBeUndefined();
    expect(JSON.stringify(result.openGraph)).toContain(RETAIL_IMAGE);
  });

  it("page 2 is canonical to itself", async () => {
    const result = await meta("retail", { page: "2" });
    expect(result.title).toBe("Retail – Applications – page 2");
    expect(result.alternates?.canonical).toBe(`${SITE}/areas/retail?page=2`);
  });

  it.each<Query>([{ cat: "downlights" }, { cct: "3000" }, { sort: "name" }])(
    "%j is noindex, follow with the clean canonical",
    async (query) => {
      const result = await meta("retail", query);
      expect(result.robots).toEqual({ index: false, follow: true });
      expect(result.alternates?.canonical).toBe(`${SITE}/areas/retail`);
      expect(anyToken(JSON.stringify(result))).toEqual([]);
    },
  );

  it("junk and the track filter are ignored on an area page", async () => {
    const result = await meta("retail", { foo: "bar", track: "10" });
    expect(result.robots).toBeUndefined();
  });
});

describe("shared listing helpers", () => {
  it("rawListingQuery keeps only own listing keys, bounded, in canonical order", () => {
    const query = Object.create({ cct: "3000" }) as Query;
    Object.assign(query, {
      page: "2",
      foo: "bar",
      ip: ["65", "20"],
      cat: "spot-lights",
      w: Array.from({ length: 40 }, (_, i) => String(i)),
    });
    const raw = new URLSearchParams(rawListingQuery(query));
    expect([...new Set(raw.keys())]).toEqual(["cat", "w", "ip", "page"]);
    expect(raw.getAll("w")).toHaveLength(16);
    expect(raw.has("cct")).toBe(false);
  });

  it("areaListingPath encodes the slug", () => {
    expect(areaListingPath({ slug: "retail" })).toBe("/areas/retail");
    expect(areaListingPath({ slug: "a b" })).toBe("/areas/a%20b");
  });
});

describe("area modules (static guard)", () => {
  const FILES = [
    ...sourceFiles(`${SRC}/app/(site)/areas`),
    ...sourceFiles(`${SRC}/components/site/areas`),
  ];
  const forbidden = (edge: ImportEdge): boolean =>
    /next\/headers|better-auth/.test(edge.spec) ||
    (edge.file !== null &&
      /lib[\\/](permissions|auth|session-cookie)\.ts$|lib[\\/]catalog[\\/]restricted\.ts$/.test(
        edge.file,
      ));

  it("finds the modules", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(4);
    expect(
      reachingChains(`${SRC}/app/(site)/areas/[slug]/page.tsx`, (edge) =>
        /lib[\\/]catalog[\\/]listing\.ts$/.test(edge.file ?? ""),
      ),
    ).not.toEqual([]);
    expect(
      importEdges(`${SRC}/app/(site)/areas/page.tsx`).length,
    ).toBeGreaterThan(3);
  });

  it("never reach the session, request headers or the restricted reader", () => {
    expect(FILES.flatMap((file) => reachingChains(file, forbidden))).toEqual(
      [],
    );
  }, 60_000);
});
