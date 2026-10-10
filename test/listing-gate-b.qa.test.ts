// QA gate B (Phase 4b, L4-L6): the request-side listing loader, the header
// menu, the sitemap paths and the listing readers with the REAL Next.js
// 16.3.8 unstable_cache / updateTag (test/helpers/next-cache-harness.ts) on an
// in-memory MongoDB. Every spec column (all 28, product and variant level)
// holds a unique token.
//
//  1. Nothing the L4-L6 code puts in the data cache (menu, counts, areas,
//     cards, facets) holds a spec value of ANY column, a variant label or a
//     draft, whatever the visibility.
//  2. Cache expiry after the real admin services (category update, area
//     update, product unpublish/publish) + the shared revalidation helper:
//     menu, sitemap paths and listings follow on the next read.
//  3. A junk-parameter flood through rawListingQuery + readListing writes no
//     new data-cache entry; rawListingQuery itself is bounded.
//  4. Facets follow a column flip restricted <-> public through
//     saveColumnVisibility (the real service) at once.
//  5. Static guards: the L4-L6 server modules never reach the session,
//     request headers or the restricted reader; the L6 client modules never
//     reach server code (server-only, env, Mongoose, catalog readers).

import "./helpers/next-als";

import { readFileSync } from "node:fs";

import { Types } from "mongoose";
import ts from "typescript";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  rawListingQuery,
  readListing,
} from "@/components/site/listing/listing-load";
import { loadSiteMenu } from "@/components/site/menu/site-menu";
import { catalogSitemapPaths } from "@/components/site/sitemap-paths";
import { updateArea } from "@/lib/admin/areas";
import { updateCategory } from "@/lib/admin/categories";
import { publishProduct, unpublishProduct } from "@/lib/admin/products";
import { saveColumnVisibility } from "@/lib/admin/settings";
import { listPublicAreas } from "@/lib/catalog/areas";
import { listPublicCategories } from "@/lib/catalog/categories";
import { listPublishedCategoryCounts } from "@/lib/catalog/category-counts";
import { getCatalogVisibility } from "@/lib/catalog/listing";
import type { ListingScope } from "@/lib/catalog/listing-scope";
import { revalidateCatalogInAction, type CatalogTag } from "@/lib/revalidate";
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

import { testActor } from "./helpers/admin-actor";
import { setupMemoryDb } from "./helpers/memory-db";
import {
  type ImportEdge,
  norm,
  reachingChains,
  resolveSpecifier,
  sourceFiles,
  SRC,
} from "./helpers/module-graph";
import { createNextCacheHarness, nextTick } from "./helpers/next-cache-harness";
import { testPublicId } from "./helpers/public-ids";

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: (await import("./helpers/admin-actor")).fakeSessionFromDb,
}));

setupMemoryDb("yg_listing_gate_b_qa");

const harness = createNextCacheHarness();
const admin = testActor();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const token = (key: SpecKey, where: string) => `QGBX${key}${where}Z`;
const specsAt = (where: string): SpecValues =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, [token(key, where)]]));
const PLACES = ["p1", "p1v1", "p1v2", "p2", "p2v1", "d", "dv1"];
const SPEC_TOKENS = PLACES.flatMap((w) => SPEC_KEYS.map((k) => token(k, w)));
const LABELS = ["QGBXLABELONEZ", "QGBXLABELTWOZ"];
const DRAFT = {
  name: "Qgbxdraftprod",
  slug: "qgbxprod-draft",
  modelNo: "QGBXDRAFT-1",
  cat: "Qgbxdraftcat",
};
const NEVER = [
  ...SPEC_TOKENS,
  ...LABELS,
  DRAFT.name,
  DRAFT.slug,
  DRAFT.modelNo,
  DRAFT.cat,
];
const leaksOf = (value: unknown) => {
  const text = JSON.stringify(value) ?? "";
  return NEVER.filter((t) => text.includes(t));
};

const ids = {
  main: new Types.ObjectId(),
  sub: new Types.ObjectId(),
  draftCat: new Types.ObjectId(),
  soloMain: new Types.ObjectId(),
  area: new Types.ObjectId(),
  p1: new Types.ObjectId(),
  p2: new Types.ObjectId(),
  solo: new Types.ObjectId(),
  draft: new Types.ObjectId(),
};
const FILTERS = {
  cctK: [6123],
  cri: [83],
  beamDeg: [37],
  ugr: [17],
  wattage: [47],
  ip: [66],
};

const every = (v: SpecVisibility) =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, v])) as Record<
    SpecKey,
    SpecVisibility
  >;
const DEFAULTS = {
  ...every("public"),
  batchNo: "restricted",
  chipType: "restricted",
  holder: "restricted",
  chipEfficiency: "restricted",
  driver: "restricted",
} as Record<SpecKey, SpecVisibility>;

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

beforeAll(async () => {
  await CategoryModel.create([
    { _id: ids.main, name: "Gbmain", slug: "gbmain", parent: null, order: 0 },
    { _id: ids.sub, name: "Gbsub", slug: "gbsub", parent: ids.main, order: 0 },
    {
      _id: ids.draftCat,
      name: DRAFT.cat,
      slug: "qgbx-draftcat",
      parent: ids.main,
      order: 1,
    },
    {
      _id: ids.soloMain,
      name: "Gbsolo",
      slug: "gbsolo",
      parent: null,
      order: 1,
    },
  ]);
  await AreaModel.create([
    { _id: ids.area, name: "Gbhall", slug: "gbhall", order: 0 },
  ]);
  const base = {
    mainCategory: ids.sub,
    status: "published" as const,
    areas: [ids.area],
    filters: FILTERS,
  };
  await ProductModel.create([
    {
      ...base,
      _id: ids.p1,
      name: "Gbone",
      slug: "gb-one",
      family: "Gbfam",
      images: [{ publicId: testPublicId(1), order: 0, kind: "gallery" }],
      specs: specsAt("p1"),
      variants: [
        { modelNo: "GB-1A", label: LABELS[0], specs: specsAt("p1v1") },
        { modelNo: "GB-1B", label: LABELS[1], specs: specsAt("p1v2") },
      ],
    },
    {
      ...base,
      _id: ids.p2,
      name: "Gbtwo",
      slug: "gb-two",
      family: "Gbfam",
      images: [{ publicId: testPublicId(2), order: 0, kind: "gallery" }],
      specs: specsAt("p2"),
      variants: [{ modelNo: "GB-2A", specs: specsAt("p2v1") }],
    },
    {
      // The only product of "Gbsolo": unpublishing it hides that category.
      ...base,
      _id: ids.solo,
      mainCategory: ids.soloMain,
      name: "Gbsoloprod",
      slug: "gb-solo",
      images: [{ publicId: testPublicId(3), order: 0, kind: "gallery" }],
      variants: [{ modelNo: "GB-S1" }],
    },
    {
      ...base,
      _id: ids.draft,
      status: "draft" as const,
      extraCategories: [ids.draftCat],
      name: DRAFT.name,
      slug: DRAFT.slug,
      images: [{ publicId: testPublicId(4), order: 0, kind: "gallery" }],
      specs: specsAt("d"),
      variants: [{ modelNo: DRAFT.modelNo, specs: specsAt("dv1") }],
    },
  ]);
});

beforeEach(async () => {
  harness.reset();
  await setVisibilityRaw(null);
});

const SUB_SCOPE: ListingScope = {
  kind: "category",
  ids: [ids.sub.toHexString()],
};
const AREA_SCOPE: ListingScope = {
  kind: "area",
  areaId: ids.area.toHexString(),
};
const ALL_SCOPE: ListingScope = { kind: "all" };

async function read(scope: ListingScope, query = "", cat = false) {
  const visibility = await getCatalogVisibility();
  return readListing(scope, query, visibility, { track: false, cat });
}

async function sitemapPaths() {
  const [tree, counts, areas] = await Promise.all([
    listPublicCategories(),
    listPublishedCategoryCounts(),
    listPublicAreas(),
  ]);
  return catalogSitemapPaths(tree, counts, areas);
}

/** Every body the real data cache is asked to store, from now on. */
function recordWrites(): string[] {
  const written: string[] = [];
  const set = harness.cache.set.bind(harness.cache);
  vi.spyOn(harness.cache, "set").mockImplementation(async (key, data, ctx) => {
    written.push(
      `${key} ${String((data as { data?: { body?: string } }).data?.body)}`,
    );
    return set(key, data, ctx);
  });
  return written;
}

async function expire(tags: CatalogTag[]) {
  await nextTick();
  await harness.inServerAction(() => revalidateCatalogInAction(tags));
  await nextTick();
}

// ---------------------------------------------------------------------------
// 1. Data-cache bytes
// ---------------------------------------------------------------------------

describe("what L4-L6 put in the data cache", () => {
  it.each<[string, Record<SpecKey, SpecVisibility> | null]>([
    ["default visibility", null],
    ["every column public", every("public")],
    ["every column restricted", every("restricted")],
  ])(
    "%s: no spec value of any column, no label, no draft (menu, counts, areas, cards, facets)",
    async (_label, visibility) => {
      await setVisibilityRaw(visibility);
      const written = recordWrites();
      const menu = await loadSiteMenu();
      expect(menu).not.toBeNull();
      const reads = await Promise.all([
        read(ALL_SCOPE),
        read(SUB_SCOPE),
        read(SUB_SCOPE, "sort=name&page=1"),
        read(AREA_SCOPE, "", true),
        read(AREA_SCOPE, `cat=gbmain`, true),
        sitemapPaths(),
      ]);
      // The grep works: names and model codes are cached.
      const blob = written.join("\n");
      expect(blob).toContain("Gbone");
      expect(written.length).toBeGreaterThan(5);
      // The cached category TREE holds every category (the draft-only one
      // too; the published counts filter it later): server-side only.
      expect(NEVER.filter((t) => t !== DRAFT.cat && blob.includes(t))).toEqual(
        [],
      );
      // And nothing reaches the rendered data either.
      expect(leaksOf(menu)).toEqual([]);
      expect(leaksOf(reads)).toEqual([]);
      // Drafts never counted.
      expect(reads[1].result.total).toBe(2);
      expect(reads[3].result.total).toBe(3);
    },
  );

  it("the menu, its counts and the sitemap hide a category whose only product is a draft", async () => {
    const menu = await loadSiteMenu();
    const main = menu?.categories.find((c) => c.name === "Gbmain");
    expect(main?.children.map((c) => c.name)).toEqual(["Gbsub"]);
    expect(menu?.areas.map((a) => a.href)).toEqual(["/areas/gbhall"]);
    const paths = await sitemapPaths();
    expect(paths).toEqual(
      expect.arrayContaining(["/products/gbmain", "/products/gbmain/gbsub"]),
    );
    expect(paths.some((p) => p.includes("draftcat"))).toBe(false);
    expect(paths.every((p) => !p.includes("?"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Expiry after the real admin services
// ---------------------------------------------------------------------------

describe("cache expiry after admin writes (real services + revalidation helper)", () => {
  it("category update: menu, sitemap paths and listing breadcrumbs follow", async () => {
    expect(
      (await loadSiteMenu())?.categories
        .find((c) => c.id === ids.main.toHexString())
        ?.children.map((c) => c.href),
    ).toEqual(["/products/gbmain/gbsub"]);
    const result = await updateCategory(admin, ids.sub.toHexString(), {
      name: "Gbsub renamed",
      slug: "gbsub-renamed",
      parent: ids.main.toHexString(),
      description: "",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    try {
      // Not expired yet: the cached menu is still served.
      expect(JSON.stringify(await loadSiteMenu())).not.toContain("renamed");
      await expire(result.tags);
      const menu = await loadSiteMenu();
      const child = menu?.categories.find(
        (c) => c.id === ids.main.toHexString(),
      )?.children[0];
      expect(child).toMatchObject({
        name: "Gbsub renamed",
        href: "/products/gbmain/gbsub-renamed",
      });
      const paths = await sitemapPaths();
      expect(paths).toContain("/products/gbmain/gbsub-renamed");
      expect(paths).not.toContain("/products/gbmain/gbsub");
    } finally {
      const back = await updateCategory(admin, ids.sub.toHexString(), {
        name: "Gbsub",
        slug: "gbsub",
        parent: ids.main.toHexString(),
        description: "",
      });
      expect(back.ok).toBe(true);
    }
  });

  it("area update: menu areas and sitemap follow", async () => {
    await loadSiteMenu();
    await sitemapPaths();
    const result = await updateArea(admin, ids.area.toHexString(), {
      name: "Gbatrium",
      slug: "gbatrium",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    try {
      await expire(result.tags);
      expect((await loadSiteMenu())?.areas).toEqual([
        expect.objectContaining({ name: "Gbatrium", href: "/areas/gbatrium" }),
      ]);
      expect(await sitemapPaths()).toContain("/areas/gbatrium");
    } finally {
      expect(
        (
          await updateArea(admin, ids.area.toHexString(), {
            name: "Gbhall",
            slug: "gbhall",
          })
        ).ok,
      ).toBe(true);
    }
  });

  it("product unpublish/publish: listing totals, facet counts, menu and sitemap follow", async () => {
    const before = await read(ALL_SCOPE);
    expect(before.result.total).toBe(3);
    expect(JSON.stringify(await loadSiteMenu())).toContain("Gbsolo");
    const down = await unpublishProduct(admin, ids.solo.toHexString());
    expect(down.ok, JSON.stringify(down)).toBe(true);
    try {
      await expire(down.tags);
      expect((await read(ALL_SCOPE)).result.total).toBe(2);
      const cct = (await read(ALL_SCOPE)).facets.groups.find(
        (g) => g.param === "cct",
      );
      expect(cct?.options).toEqual([
        expect.objectContaining({ value: "6123", count: 2 }),
      ]);
      expect(JSON.stringify(await loadSiteMenu())).not.toContain("Gbsolo");
      expect(await sitemapPaths()).not.toContain("/products/gbsolo");
    } finally {
      const up = await publishProduct(admin, ids.solo.toHexString());
      expect(up.ok, JSON.stringify(up)).toBe(true);
      await expire(up.tags);
    }
    expect((await read(ALL_SCOPE)).result.total).toBe(3);
    expect(await sitemapPaths()).toContain("/products/gbsolo");
  });
});

// ---------------------------------------------------------------------------
// 3. Junk-parameter flood
// ---------------------------------------------------------------------------

describe("junk-parameter flood", () => {
  it("rawListingQuery reads own listing keys only, bounded, in canonical order", () => {
    const query = Object.assign(Object.create({ cct: "3000" }) as object, {
      zz: "1",
      utm_source: "x",
      page: "2",
      cct: Array.from({ length: 100 }, (_, i) => String(3000 + i)),
      constructor: "x",
      __proto__: { ip: "65" },
    }) as Record<string, string | string[]>;
    const out = new URLSearchParams(rawListingQuery(query));
    expect([...new Set(out.keys())]).toEqual(["cct", "page"]);
    expect(out.getAll("cct")).toHaveLength(16);
    // Key order of the request does not change the loader key.
    expect(rawListingQuery({ page: "2", sort: "name", cct: "3000" })).toBe(
      rawListingQuery({ cct: "3000", sort: "name", page: "2" }),
    );
    // Non-string entries are skipped, never stringified.
    expect(
      rawListingQuery({
        cct: [{} as unknown as string, "3000"],
      }),
    ).toBe("cct=3000");
  });

  it("writes no new data-cache entry for 600 junk queries over 3 scopes", async () => {
    // Warm the clean listings first.
    for (const [scope, cat] of [
      [SUB_SCOPE, false],
      [AREA_SCOPE, true],
      [ALL_SCOPE, false],
    ] as const) {
      await read(scope, "", cat);
    }
    const written = recordWrites();
    const junk: string[] = [];
    for (let i = 0; i < 200; i++) {
      const r = Math.random().toString(36).slice(2, 8);
      junk.push(
        `utm_${r}=1&cct=${1000 + i}&cri=${(i % 100) + 0.5}&page=${r}`,
        `cct=${7000 + i}&cct=${7100 + i}&beam=${200 + i}&w=${r}&ip=${90 + (i % 9)}&sort=${r}`,
        `cat=${r}&ugr=${30 + (i % 10)}&track=${i}&cct=${"9".repeat(30)}&page=-${i}`,
      );
    }
    for (const [index, query] of junk.entries()) {
      const scope = [SUB_SCOPE, AREA_SCOPE, ALL_SCOPE][index % 3]!;
      const { result } = await read(scope, query, scope.kind === "area");
      expect(result.page).toBe(1);
    }
    expect(written).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 4. Facets follow a visibility flip at once
// ---------------------------------------------------------------------------

describe("facets follow restricted <-> public through saveColumnVisibility", () => {
  it("each filter column: offered when public, gone (and its param ignored) when restricted, back when public", async () => {
    const cases: [SpecKey, string, string][] = [
      ["cct", "cct", "6123"],
      ["cri", "cri", "83"],
      ["beamAngle", "beam", "37"],
      ["ugr", "ugr", "17"],
      ["wattage", "w", "41+"],
      ["ipRating", "ip", "66"],
    ];
    await setVisibilityRaw(DEFAULTS);
    for (const [key, param, value] of cases) {
      const saved = await ProductModel.find({}, { filters: 1 }).lean();
      const offered = async () =>
        (await read(SUB_SCOPE)).facets.groups
          .find((g) => g.param === param)
          ?.options.map((o) => o.value) ?? [];
      expect(await offered(), key).toContain(value);

      const down = await saveColumnVisibility(admin, {
        ...DEFAULTS,
        [key]: "restricted",
      });
      expect(down.ok, key).toBe(true);
      await expire(down.tags);
      expect(await offered(), key).toEqual([]);
      const filtered = await read(SUB_SCOPE, `${param}=${value}`);
      expect(filtered.result.params[param as "cct"], key).toEqual([]);
      expect(filtered.result.total, key).toBe(2);

      // Put the filter numbers back (the save removed them), then public.
      for (const doc of saved) {
        await ProductModel.collection.updateOne(
          { _id: doc._id },
          { $set: { filters: doc.filters } },
        );
      }
      const up = await saveColumnVisibility(admin, DEFAULTS);
      expect(up.ok, key).toBe(true);
      await expire(up.tags);
      expect(await offered(), key).toContain(value);
      expect(
        (await read(SUB_SCOPE, `${param}=${value}`)).result.total,
        key,
      ).toBe(2);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. Static guards
// ---------------------------------------------------------------------------

describe("static guards (real TypeScript resolver)", () => {
  const isSessionOrRestricted = (edge: ImportEdge): boolean =>
    /^next\/headers$|^better-auth/.test(edge.spec) ||
    (edge.file !== null &&
      /lib[\\/](permissions|auth|session-cookie)\.ts$|lib[\\/]catalog[\\/]restricted\.ts$/.test(
        edge.file,
      ));

  const SERVER_FILES = [
    ...sourceFiles(`${SRC}/app/(site)/areas`),
    ...sourceFiles(`${SRC}/app/(site)/search`),
    ...sourceFiles(`${SRC}/components/site/menu`),
    ...sourceFiles(`${SRC}/components/site/search`),
    ...sourceFiles(`${SRC}/components/site/areas`),
    `${SRC}/app/(site)/layout.tsx`,
    `${SRC}/app/(account)/layout.tsx`,
    `${SRC}/app/sitemap.ts`,
    `${SRC}/components/site/sitemap-paths.ts`,
    `${SRC}/components/site/site-header.tsx`,
    `${SRC}/components/site/site-shell.tsx`,
    `${SRC}/components/site/cloudinary-image.ts`,
    `${SRC}/components/site/cloudinary-delivery.ts`,
  ];

  it("finds the modules", () => {
    expect(SERVER_FILES.length).toBeGreaterThan(14);
    expect(
      reachingChains(`${SRC}/app/(site)/layout.tsx`, (e) =>
        /lib[\\/]catalog[\\/]categories\.ts$/.test(e.file ?? ""),
      ),
    ).not.toEqual([]);
  });

  it("L5/L6 pages, layouts, menu, search UI and sitemap never reach the session, headers or the restricted reader", () => {
    expect(
      SERVER_FILES.flatMap((file) =>
        reachingChains(file, isSessionOrRestricted),
      ),
    ).toEqual([]);
  }, 60_000);

  /*
   * The L6 browser modules and what they load at runtime. Type-only imports
   * are erased by the compiler, so only value imports are followed.
   */
  const L6_CLIENT_FILES = [
    `${SRC}/components/site/search/search-overlay.tsx`,
    `${SRC}/components/site/search/search-launcher.tsx`,
    `${SRC}/components/site/search/search-links.ts`,
    `${SRC}/components/site/menu/mega-menu.tsx`,
    `${SRC}/components/site/mobile-menu.tsx`,
    `${SRC}/components/site/cloudinary-delivery.ts`,
    ...sourceFiles(`${SRC}/components/site/listing`).filter((file) =>
      /^\s*["']use client["']/.test(readFileSync(file, "utf8")),
    ),
  ];

  function valueImports(file: string): string[] {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const specs: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const typeOnly =
          clause?.isTypeOnly === true ||
          (clause !== undefined &&
            clause.name === undefined &&
            named !== undefined &&
            ts.isNamedImports(named) &&
            named.elements.length > 0 &&
            named.elements.every((e) => e.isTypeOnly));
        if (!typeOnly) specs.push(node.moduleSpecifier.text);
      } else if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specs.push(node.moduleSpecifier.text);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        specs.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return specs;
  }

  const SERVER_PACKAGE =
    /^(server-only|mongoose|mongodb|next\/headers|next\/cache|zod)$|^better-auth/;

  function serverChains(start: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: [string, string[]][] = [[start, [norm(start)]]];
    while (stack.length > 0) {
      const next = stack.pop();
      if (!next) break;
      const [file, trail] = next;
      if (seen.has(norm(file))) continue;
      seen.add(norm(file));
      for (const spec of valueImports(file)) {
        const resolved = resolveSpecifier(spec, file);
        const local =
          resolved && !resolved.includes("node_modules") ? resolved : null;
        if (
          SERVER_PACKAGE.test(spec) ||
          // Pure lib modules with no import (e.g. lib/slug.ts) are fine;
          // models and readers pull in mongoose, which is flagged above.
          (local !== null &&
            /lib[\\/](env|db|auth|permissions)\.ts$|lib[\\/]catalog[\\/]/.test(
              local,
            ))
        ) {
          out.push([...trail, local ? norm(local) : spec].join(" -> "));
        }
        if (local && !/\.d\.ts$/.test(local)) {
          stack.push([local, [...trail, norm(local)]]);
        }
      }
    }
    return out;
  }

  it("the L6 client modules load no server code, Zod or catalog reader (bundle)", () => {
    expect(L6_CLIENT_FILES.length).toBeGreaterThan(7);
    // Sanity: the walker sees the overlay's lazy chunk.
    expect(
      valueImports(`${SRC}/components/site/search/search-launcher.tsx`),
    ).toContain("./search-overlay");
    expect(L6_CLIENT_FILES.flatMap(serverChains)).toEqual([]);
  }, 60_000);
});
