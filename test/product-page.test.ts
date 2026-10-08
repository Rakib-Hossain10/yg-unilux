// Phase 4a P4: the product page shell on the real catalog layer (memory DB,
// next/cache as a JSON pass-through): panel/table/Models render, placement is
// read from SPEC_COLUMNS, and no restricted value reaches the HTML, the
// metadata, the JSON-LD or the sitemap; drafts and unknown slugs are 404.

import { Types } from "mongoose";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SETTINGS_KEYS } from "@/lib/schemas/settings";
import {
  AreaModel,
  CategoryModel,
  ProductModel,
  SiteContentModel,
} from "@/models";
import {
  DEFAULT_RESTRICTED_SPEC_KEYS,
  SPEC_KEYS,
  specColumnsFor,
  type SpecKey,
  type SpecValues,
  type SpecVisibility,
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

import ProductPage, {
  generateMetadata,
  generateStaticParams,
} from "@/app/(site)/product/[slug]/page";
import ProductNotFound from "@/app/(site)/product/[slug]/not-found";
import sitemap from "@/app/sitemap";

setupMemoryDb("yg_product_page_p4");

// Every value is a unique token, so a leak is a plain substring match.
const tok = (key: SpecKey, where: string) => `TOK~${key}~${where}~`;
const specsAt = (where: string): SpecValues =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, [tok(key, where)]]));

const ids = {
  main: new Types.ObjectId(),
  sub: new Types.ObjectId(),
  area: new Types.ObjectId(),
  hero: new Types.ObjectId(),
  sibling: new Types.ObjectId(),
  related: new Types.ObjectId(),
  draft: new Types.ObjectId(),
  single: new Types.ObjectId(),
};
const HERO = "arc-ar-013a";
const SITE = "https://www.example.com";

beforeAll(async () => {
  await CategoryModel.create([
    { _id: ids.main, name: "Spot Lights", slug: "spot-lights", parent: null },
    { _id: ids.sub, name: "Recessed", slug: "recessed", parent: ids.main },
  ]);
  await AreaModel.create([
    { _id: ids.area, name: "Hospitality", slug: "hospitality", order: 0 },
  ]);
  const base = {
    mainCategory: ids.sub,
    areas: [ids.area],
    images: [{ publicId: testPublicId(1), order: 0, kind: "gallery" as const }],
  };
  await ProductModel.create([
    {
      ...base,
      _id: ids.hero,
      status: "published",
      name: "Arc",
      slug: HERO,
      family: "Arc",
      modelCode: "AR-013A",
      productNo: 76,
      type: "Recessed spot",
      specs: {
        ...specsAt("P"),
        cct: ["3000K", "4000K"],
        // An empty column must be hidden, not shown blank.
        rotatingAngle: [],
      },
      variants: [
        {
          modelNo: "AR-013A1",
          label: "Regular lens",
          specs: {
            ...specsAt("V1"),
            cct: ["3000K", "4000K"],
            rotatingAngle: [],
          },
        },
        {
          modelNo: "AR-013A2",
          label: "Reflector",
          specs: { lumenOutput: ["1200lm"], driver: [tok("driver", "V2")] },
        },
      ],
      extraSpecs: [{ group: "Mounting", label: "Ceiling", value: "Plaster" }],
      publicFiles: [
        { label: "Installation guide", url: "https://example.com/g.pdf" },
      ],
      datasheetId: new Types.ObjectId(),
    },
    {
      ...base,
      _id: ids.sibling,
      status: "published",
      name: "Arc Mini",
      slug: "arc-ar-020a",
      family: "Arc",
      modelCode: "AR-020A",
      productNo: 77,
      specs: specsAt("SIB"),
      variants: [{ modelNo: "AR-020A1", specs: {} }],
    },
    {
      ...base,
      _id: ids.related,
      status: "published",
      name: "Halo",
      slug: "halo-ha-001",
      family: "Halo",
      modelCode: "HA-001",
      productNo: 78,
      specs: specsAt("REL"),
      variants: [{ modelNo: "HA-001A", specs: {} }],
    },
    {
      ...base,
      _id: ids.single,
      status: "published",
      name: "Solo",
      slug: "solo-so-001",
      images: [],
      specs: { cct: ["2700K"] },
      variants: [{ modelNo: "SO-001", specs: {} }],
    },
    {
      ...base,
      _id: ids.draft,
      status: "draft",
      name: "Secret",
      slug: "secret-se-001",
      specs: specsAt("DRAFT"),
      variants: [{ modelNo: "SE-001", specs: {} }],
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

const all = (v: SpecVisibility) =>
  Object.fromEntries(SPEC_KEYS.map((k) => [k, v]));

const props = (slug: string) => ({
  params: Promise.resolve({ slug }),
  searchParams: Promise.resolve({}),
});

async function renderPage(slug: string): Promise<string> {
  return renderToStaticMarkup(await ProductPage(props(slug)));
}

function jsonLdOf(html: string): Record<string, unknown> {
  const match =
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error("no JSON-LD");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

/** Every token of `keys` (any location) found in `text`. */
const leaked = (text: string, keys: readonly SpecKey[]): string[] =>
  keys.filter((key) => text.includes(`TOK~${key}~`));

/** The slice of the page between two markers. */
function between(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + 1);
  expect(from, start).toBeGreaterThanOrEqual(0);
  return html.slice(from, to === -1 ? undefined : to);
}

describe("product page: default visibility", () => {
  it("renders one h1, the breadcrumb and variant 1 in the panel", async () => {
    const html = await renderPage(HERO);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('href="/products?category=spot-lights"');
    expect(html).toContain('href="/products?category=recessed"');
    expect(html).toContain('aria-current="page"');
    const panel = between(
      html,
      'data-slot="quick-spec-panel"',
      'data-section="specifications"',
    );
    expect(panel).toContain('data-field="model-no"');
    expect(panel).toMatch(/data-field="model-no"[^>]*>AR-013A1</);
    // The pink keys (placement "quick") and nothing else from the specs.
    for (const column of specColumnsFor("quick")) {
      expect(panel).toContain(`data-spec="${column.key}"`);
    }
    for (const column of specColumnsFor("table")) {
      expect(panel).not.toContain(`data-spec="${column.key}"`);
    }
    // Options as a real list.
    expect(panel).toMatch(
      /<ul[^>]*><li[^>]*>3000K<\/li><li[^>]*>4000K<\/li><\/ul>/,
    );
    // Readout of variant 1 and the datasheet slot (visitor fallback).
    expect(panel).toContain(`data-field="lumenOutput"`);
    expect(panel).toContain(tok("lumenOutput", "V1"));
    expect(panel).toContain('data-slot="datasheet"');
    expect(panel).toContain("Sign in to download");
  });

  it("renders the spec table from placement 'table', grouped, empty hidden", async () => {
    const html = await renderPage(HERO);
    const table = between(
      html,
      'data-section="specifications"',
      'data-section="models"',
    );
    expect(table).toContain('<caption class="sr-only">');
    expect(table).toContain('<th scope="row"');
    expect(table).toContain("Housing and optics");
    expect(table).toContain("Electrical and output");
    // Empty column hidden; quick keys not repeated in the table.
    expect(table).not.toContain('data-spec="rotatingAngle"');
    expect(table).not.toContain('data-spec="cct"');
    // Extra specs as their own group; restricted slot reserved after the rows.
    expect(table).toContain("Mounting");
    expect(table).toContain("Plaster");
    expect(table).toContain('data-slot="restricted-specs"');
    // Variant 1's values, not the product's.
    expect(table).toContain(tok("lens", "V1"));
    expect(table).not.toContain(tok("lens", "P"));
  });

  it("lists every variant in the Models table with comparable columns", async () => {
    const html = await renderPage(HERO);
    const models = between(
      html,
      'data-section="models"',
      'data-section="downloads"',
    );
    expect(models).toContain("AR-013A1");
    expect(models).toContain("AR-013A2");
    expect(models).toContain("Regular lens");
    expect(models).toContain("1200lm");
    expect(models).toContain('data-variant-index="1"');
    expect(models).toContain('<th scope="row"');
  });

  it("shows downloads, applications and both strips", async () => {
    const html = await renderPage(HERO);
    expect(html).toContain('href="https://example.com/g.pdf"');
    expect(html).toContain('href="/areas/hospitality"');
    const family = between(
      html,
      'data-section="family"',
      'data-section="related"',
    );
    expect(family).toContain("More from Arc");
    expect(family).toContain('href="/product/arc-ar-020a"');
    expect(family).not.toContain(`href="/product/${HERO}"`);
    const related = html.slice(html.indexOf('data-section="related"'));
    expect(related).toContain('href="/product/halo-ha-001"');
    expect(html).not.toContain("secret-se-001");
  });

  it("puts no restricted value anywhere in the HTML", async () => {
    const html = await renderPage(HERO);
    expect(leaked(html, DEFAULT_RESTRICTED_SPEC_KEYS)).toEqual([]);
    // Public values do reach the page (positive control).
    expect(html).toContain(tok("housingMaterial", "V1"));
    // The datasheet id never reaches cached HTML.
    expect(html).not.toMatch(/datasheet[-_]?id/i);
  });

  it("builds JSON-LD with brand and one sku per variant, no price, nothing restricted", async () => {
    const html = await renderPage(HERO);
    const ld = jsonLdOf(html);
    expect(ld["@type"]).toBe("ProductGroup");
    expect(ld.brand).toEqual({ "@type": "Brand", name: "YG UniLUX" });
    expect(ld.url).toBe(`${SITE}/product/${HERO}`);
    const variants = ld.hasVariant as { sku: string; mpn: string }[];
    expect(variants.map((v) => v.sku)).toEqual(["AR-013A1", "AR-013A2"]);
    expect(variants.map((v) => v.mpn)).toEqual(["AR-013A1", "AR-013A2"]);
    const text = JSON.stringify(ld);
    expect(text).not.toMatch(/offers|price/i);
    expect(leaked(text, DEFAULT_RESTRICTED_SPEC_KEYS)).toEqual([]);
    expect(ld.image).toEqual([
      `https://res.cloudinary.com/demo-cloud/image/upload/${testPublicId(1)}`,
    ]);
  });

  it("builds metadata with title, canonical and no restricted value", async () => {
    const meta = await generateMetadata(props(HERO));
    expect(meta.title).toBe("Arc AR-013A");
    expect(meta.alternates?.canonical).toBe(`${SITE}/product/${HERO}`);
    const text = JSON.stringify(meta);
    expect(leaked(text, DEFAULT_RESTRICTED_SPEC_KEYS)).toEqual([]);
    expect(text).not.toContain("secretvalue");
  });

  it("lists only published products in the sitemap and static params", async () => {
    const entries = await sitemap();
    expect(entries.map((e) => e.url).sort()).toEqual(
      ["arc-ar-013a", "arc-ar-020a", "halo-ha-001", "solo-so-001"].map(
        (slug) => `${SITE}/product/${slug}`,
      ),
    );
    expect(leaked(JSON.stringify(entries), SPEC_KEYS)).toEqual([]);
    const params = await generateStaticParams();
    expect(params.map((p) => p.slug).sort()).toEqual([
      "arc-ar-013a",
      "arc-ar-020a",
      "halo-ha-001",
      "solo-so-001",
    ]);
  });

  it("omits canonical and JSON-LD url without SITE_URL, and still renders", async () => {
    vi.stubEnv("SITE_URL", "");
    const meta = await generateMetadata(props(HERO));
    expect(meta.alternates).toBeUndefined();
    const ld = jsonLdOf(await renderPage(HERO));
    expect(ld.url).toBeUndefined();
  });
});

describe("product page: visibility is followed", () => {
  it("hides every spec when every column is restricted", async () => {
    await setVisibility(all("restricted"));
    const html = await renderPage(HERO);
    expect(leaked(html, SPEC_KEYS)).toEqual([]);
    // Labels may hold optic values (ADR 0063 decision 9): model nos. instead.
    expect(html).not.toContain("Regular lens");
    const meta = JSON.stringify(await generateMetadata(props(HERO)));
    expect(leaked(meta, SPEC_KEYS)).toEqual([]);
    expect(leaked(JSON.stringify(jsonLdOf(html)), SPEC_KEYS)).toEqual([]);
  });

  it("shows a default-restricted column once the admin makes it public", async () => {
    await setVisibility(all("public"));
    const html = await renderPage(HERO);
    const table = between(
      html,
      'data-section="specifications"',
      'data-section="models"',
    );
    expect(table).toContain(tok("driver", "V1"));
    expect(table).toContain(tok("batchNo", "V1"));
  });
});

describe("product page: variant switcher (P5)", () => {
  it("renders a radio per variant, variant 1 checked, and Show buttons", async () => {
    const html = await renderPage(HERO);
    const switcher = between(
      html,
      'data-slot="variant-switcher"',
      'data-slot="datasheet"',
    );
    expect(switcher).toContain("<fieldset");
    expect(switcher.match(/type="radio"/g)).toHaveLength(2);
    expect(switcher).toMatch(/id="variant-option-0"[^>]*checked=""/);
    expect(switcher).toContain(">Regular lens<");
    expect(switcher).toContain('aria-live="polite"');
    const models = between(
      html,
      'data-section="models"',
      'data-section="downloads"',
    );
    // Variant 1's row is the one shown; the other offers "Show".
    expect(models).toMatch(/>Shown<span class="sr-only"> AR-013A1</);
    expect(models).toMatch(/>Show<span class="sr-only"> AR-013A2</);
    // The table caption names the shown model (variant 1).
    expect(html).toContain("Specifications of Arc AR-013A1: ");
  });
});

describe("product page: single variant, no photo", () => {
  it("hides the switcher slot and Models table and shows the placeholder", async () => {
    const html = await renderPage("solo-so-001");
    expect(html).not.toContain('data-slot="variant-switcher"');
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('data-section="models"');
    expect(html).toContain("Solo: photo not yet available");
    expect(html).toContain("Datasheet coming soon");
    const ld = jsonLdOf(html);
    expect(ld["@type"]).toBe("Product");
    expect(ld.sku).toBe("SO-001");
    expect(ld.image).toBeUndefined();
  });
});

describe("product page: 404", () => {
  const isNotFound = (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    String((error as { digest?: unknown }).digest).endsWith(";404");

  it.each(["secret-se-001", "no-such-product", "BAD SLUG", "x".repeat(500)])(
    "%s is a 404 with noindex metadata",
    async (slug) => {
      const error = await ProductPage(props(slug)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isNotFound(error)).toBe(true);
      const meta = await generateMetadata(props(slug));
      expect(meta.robots).toEqual({ index: false });
      expect(JSON.stringify(meta)).not.toContain("Secret");
    },
  );

  it("the product 404 page offers a way back", () => {
    const html = renderToStaticMarkup(createElement(ProductNotFound));
    expect(html).toContain("Product not found");
    expect(html).toContain('href="/products"');
  });
});

describe("product page modules (static guard)", () => {
  const PAGE_FILES = [
    ...sourceFiles(`${SRC}/app/(site)/product`),
    ...sourceFiles(`${SRC}/components/site/product`),
    `${SRC}/app/sitemap.ts`,
  ];
  const forbidden = (edge: ImportEdge): boolean =>
    /next\/headers|better-auth/.test(edge.spec) ||
    (edge.file !== null &&
      /lib[\\/](permissions|auth|session-cookie)\.ts$|lib[\\/]catalog[\\/]restricted\.ts$/.test(
        edge.file,
      ));

  it("finds the page modules", () => {
    expect(PAGE_FILES.length).toBeGreaterThan(8);
    expect(
      importEdges(`${SRC}/app/(site)/product/[slug]/page.tsx`).length,
    ).toBeGreaterThan(5);
    // Positive control: the walk does follow the page into the catalog.
    expect(
      reachingChains(`${SRC}/app/(site)/product/[slug]/page.tsx`, (edge) =>
        /lib[\\/]catalog[\\/]product\.ts$/.test(edge.file ?? ""),
      ),
    ).not.toEqual([]);
  });

  it("never reach the session, request headers or the restricted reader", () => {
    expect(
      PAGE_FILES.flatMap((file) => reachingChains(file, forbidden)),
    ).toEqual([]);
  }, 60_000);
});
