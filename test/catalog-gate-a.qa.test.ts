// QA gate A (Phase 4a, tasks P2 + P3): adversarial tests of the catalog data
// layer against rule 9 / ADR 0002 / 0063. next/cache is a pass-through here
// (the REAL cache is exercised in catalog-gate-a-cache.qa.test.ts).
//  - leak matrix: 28 keys x {default, all public, all restricted, every single
//    key, every single public key, 60 seeded random subsets, damaged stored
//    settings} x every cached reader;
//  - hostile documents inserted raw (unknown spec keys, odd types, admin
//    fields, other statuses) never reach a view;
//  - exact view shapes (no filters / datasheetId / status / sourceSha256);
//  - malformed / operator-injection inputs return empty WITHOUT a query;
//  - getRestrictedSpecs access matrix incl. odd session values;
//  - open finding H-1 (variant labels derived from optic values) as it.fails.

import { Types } from "mongoose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanRow } from "@/lib/import/clean";
import { groupRows } from "@/lib/import/group";
import { SETTINGS_KEYS } from "@/lib/schemas/settings";
import {
  AreaModel,
  CategoryModel,
  ProductModel,
  SiteContentModel,
} from "@/models";
import {
  DEFAULT_RESTRICTED_SPEC_KEYS,
  restrictedSpecKeys,
  SPEC_COLUMNS,
  SPEC_KEYS,
  specColumnsFor,
  type SpecKey,
  type SpecValues,
  type SpecVisibility,
} from "@/models/spec-columns";
import { SPEC_GROUPS } from "@/components/admin/product-form/spec-groups";

import { setupMemoryDb } from "./helpers/memory-db";
import { testPublicId } from "./helpers/public-ids";

const cacheCalls = vi.hoisted(
  () => [] as { keyParts: string[]; tags: string[] }[],
);
vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...args: never[]) => Promise<unknown>,
    keyParts: string[],
    options: { tags?: string[] },
  ) => {
    cacheCalls.push({ keyParts, tags: options.tags ?? [] });
    // Mimic the real store: the caller only ever sees the JSON round trip.
    return async (...args: never[]) =>
      JSON.parse(JSON.stringify((await fn(...args)) ?? null)) as unknown;
  },
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
}));

const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: getSession,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { getBreadcrumb, listPublicCategories } from "@/lib/catalog/categories";
import { getFamilyProducts } from "@/lib/catalog/family";
import { getPublicProduct, listPublishedSlugs } from "@/lib/catalog/product";
import { getRelatedProducts } from "@/lib/catalog/related";
import { getRestrictedSpecs } from "@/lib/catalog/restricted";
import type { PublicProductView } from "@/lib/catalog/view";

setupMemoryDb("yg_catalog_gate_a_qa");

// ---------------------------------------------------------------------------
// Fixtures: every value a unique token, product AND variant level
// ---------------------------------------------------------------------------

const tok = (key: SpecKey, where: string) => `LEAK~${key}~${where}~`;
const specsAt = (where: string): SpecValues =>
  Object.fromEntries(
    SPEC_KEYS.map((key) => [key, [tok(key, where), `${tok(key, where)}2`]]),
  );

const ids = {
  main: new Types.ObjectId(),
  sub: new Types.ObjectId(),
  areaA: new Types.ObjectId(),
  areaB: new Types.ObjectId(),
  hero: new Types.ObjectId(),
  sibling: new Types.ObjectId(),
  related: new Types.ObjectId(),
  draft: new Types.ObjectId(),
  archived: new Types.ObjectId(),
  hostile: new Types.ObjectId(),
  datasheet: new Types.ObjectId(),
};
const HERO = "hero-he-001";
const HOSTILE = "hostile-ho-001";

const publishedBase = () => ({
  mainCategory: ids.sub,
  status: "published" as const,
  areas: [ids.areaA, ids.areaB],
  images: [{ publicId: testPublicId(1), order: 0, kind: "gallery" as const }],
});

beforeAll(async () => {
  await CategoryModel.create([
    { _id: ids.main, name: "Spot", slug: "spot", parent: null },
    { _id: ids.sub, name: "Recessed", slug: "recessed", parent: ids.main },
  ]);
  await AreaModel.create([
    { _id: ids.areaA, name: "Office", slug: "office", order: 0 },
    { _id: ids.areaB, name: "Retail", slug: "retail", order: 1 },
  ]);
  await ProductModel.create([
    {
      ...publishedBase(),
      _id: ids.hero,
      name: "Hero",
      slug: HERO,
      family: "Hero",
      modelCode: "HE-001",
      productNo: 1,
      specs: specsAt("P"),
      variants: [
        { modelNo: "HE-001A", label: "Variant A", specs: specsAt("V1") },
        { modelNo: "HE-001B", label: "Variant B", specs: {} },
        // only a few keys overridden, rest inherited
        {
          modelNo: "HE-001C",
          label: "Variant C",
          specs: { driver: [tok("driver", "V3")], cct: [tok("cct", "V3")] },
        },
      ],
      extraSpecs: [{ group: "Extra", label: "Note", value: "plain" }],
      publicFiles: [{ label: "Guide", url: "https://example.com/g.pdf" }],
      datasheetId: ids.datasheet,
    },
    {
      ...publishedBase(),
      _id: ids.sibling,
      name: "Hero Two",
      slug: "hero-he-002",
      family: "Hero",
      productNo: 2,
      specs: specsAt("S"),
      variants: [{ modelNo: "HE-002A", specs: specsAt("SV") }],
    },
    {
      ...publishedBase(),
      _id: ids.related,
      name: "Other",
      slug: "other-ot-001",
      family: "Other",
      productNo: 3,
      specs: specsAt("R"),
      variants: [{ modelNo: "OT-001A", specs: specsAt("RV") }],
    },
    {
      ...publishedBase(),
      _id: ids.draft,
      name: "Hero Draft",
      slug: "hero-he-003",
      family: "Hero",
      status: "draft",
      specs: specsAt("D"),
      variants: [{ modelNo: "HE-003A" }],
    },
  ]);
  // Raw inserts: bypass Mongoose so the schema cannot clean them up first.
  await ProductModel.collection.insertMany([
    {
      _id: ids.archived,
      name: "Archived",
      slug: "hero-he-004",
      family: "Hero",
      mainCategory: ids.sub,
      areas: [ids.areaA],
      status: "archived",
      images: [],
      specs: specsAt("X"),
      variants: [{ modelNo: "HE-004A", specs: {} }],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      _id: ids.hostile,
      name: "Hostile",
      slug: HOSTILE,
      family: "Hostile",
      mainCategory: ids.sub,
      areas: [ids.areaA, new Types.ObjectId()], // one dangling area
      status: "published",
      featured: true,
      adminNotes: "ADMIN-ONLY-NOTE",
      filters: { cctK: [3000], wattage: [12] },
      datasheetId: ids.datasheet,
      images: [
        {
          publicId: testPublicId(2),
          order: 1,
          kind: "gallery",
          sourceSha256: "SHA-SECRET",
          alt: null,
        },
        { publicId: testPublicId(3), order: 0, kind: "drawing" },
      ],
      specs: {
        ...specsAt("H"),
        secretColumn: ["UNKNOWN-KEY-VALUE"],
        driver: "LEAK~driver~H-string~", // wrong type
        cct: [{ $gt: "" }, "3000K", 7, null, ""], // junk entries
      },
      variants: [
        {
          modelNo: "HO-001A",
          label: null,
          specs: { ...specsAt("HV"), secretColumn: ["UNKNOWN-VARIANT"] },
          internalCost: "COST-SECRET",
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
});

async function setStoredVisibility(value: unknown | null): Promise<void> {
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
  Object.fromEntries(SPEC_KEYS.map((k) => [k, v])) as Record<
    SpecKey,
    SpecVisibility
  >;

/* Small deterministic PRNG (mulberry32) so a failure is reproducible. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Case = [label: string, stored: unknown | null, restricted: SpecKey[]];
const CASES: Case[] = [
  ["default (no document)", null, [...DEFAULT_RESTRICTED_SPEC_KEYS]],
  ["all public", all("public"), []],
  ["all restricted", all("restricted"), [...SPEC_KEYS]],
  ...SPEC_KEYS.map<Case>((k) => [
    `only ${k} restricted`,
    { ...all("public"), [k]: "restricted" },
    [k],
  ]),
  ...SPEC_KEYS.map<Case>((k) => [
    `only ${k} public`,
    { ...all("restricted"), [k]: "public" },
    SPEC_KEYS.filter((x) => x !== k),
  ]),
  ...Array.from({ length: 60 }, (_, i): Case => {
    const next = rng(1000 + i);
    const v = Object.fromEntries(
      SPEC_KEYS.map((k) => [k, next() < 0.5 ? "restricted" : "public"]),
    ) as Record<SpecKey, SpecVisibility>;
    return [`random #${i}`, v, restrictedSpecKeys(v)];
  }),
  // Damaged stored settings fail closed (parseStoredColumnVisibility).
  ["stored garbage string", "garbage", [...SPEC_KEYS]],
  ["stored empty object", {}, [...SPEC_KEYS]],
  ["stored array", ["public"], [...SPEC_KEYS]],
  [
    "stored odd casing / values",
    {
      ...all("public"),
      driver: "PUBLIC",
      batchNo: true,
      chipType: 1,
      holder: null,
    },
    ["batchNo", "chipType", "holder", "driver"],
  ],
  [
    "stored partial (only some keys public)",
    { cct: "public", wattage: "public" },
    SPEC_KEYS.filter((k) => k !== "cct" && k !== "wattage"),
  ],
];

function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object")
    for (const [k, inner] of Object.entries(value)) {
      out.add(k);
      allKeys(inner, out);
    }
  return out;
}

function expectNoLeak(
  value: unknown,
  restricted: readonly SpecKey[],
  where: string,
) {
  const json = JSON.stringify(value);
  const keys = allKeys(value);
  const leaked = restricted.filter(
    (k) => keys.has(k) || json.includes(`LEAK~${k}~`),
  );
  expect(leaked, where).toEqual([]);
}

beforeEach(async () => {
  getSession.mockReset();
  await setStoredVisibility(null);
});

// ---------------------------------------------------------------------------
// 1. Leak matrix
// ---------------------------------------------------------------------------

describe("leak matrix over the 28 keys (every cached reader)", () => {
  it(`has ${SPEC_KEYS.length} keys and the five default-restricted columns`, () => {
    expect(SPEC_KEYS).toHaveLength(28);
    expect([...DEFAULT_RESTRICTED_SPEC_KEYS].sort()).toEqual(
      ["batchNo", "chipEfficiency", "chipType", "driver", "holder"].sort(),
    );
  });

  it.each(CASES)("%s", async (label, stored, restricted) => {
    await setStoredVisibility(stored);
    const publicKeys = SPEC_KEYS.filter((k) => !restricted.includes(k));

    const hero = (await getPublicProduct(HERO)) as PublicProductView;
    const hostile = (await getPublicProduct(HOSTILE)) as PublicProductView;
    expect(hero).not.toBeNull();
    expect(hostile).not.toBeNull();
    const strips = await Promise.all([
      getFamilyProducts(hero.family, hero.id),
      getRelatedProducts(hero),
      getRelatedProducts({ ...hero, areas: [] }),
      getFamilyProducts("Hostile", ids.related.toHexString()),
      listPublishedSlugs(),
      getBreadcrumb(hero),
      listPublicCategories(),
    ]);

    expectNoLeak(hero, restricted, `${label}: hero view`);
    expectNoLeak(hostile, restricted, `${label}: hostile view`);
    // Strips, slugs, breadcrumbs and the category index carry NO spec at all.
    expectNoLeak(strips, SPEC_KEYS, `${label}: strips/slugs/breadcrumb`);

    // Completeness: the projection is not stricter than the setting.
    for (const k of publicKeys) {
      expect(hero.specs[k], `${label}: public ${k}`).toEqual([
        tok(k, "P"),
        `${tok(k, "P")}2`,
      ]);
      expect(hero.variants[0]?.specs[k]).toEqual([
        tok(k, "V1"),
        `${tok(k, "V1")}2`,
      ]);
      expect(hero.variants[1]?.specs[k]).toEqual([
        tok(k, "P"),
        `${tok(k, "P")}2`,
      ]);
    }
    // Variant C overrides driver (restricted by default) and cct.
    if (!restricted.includes("cct")) {
      expect(hero.variants[2]?.specs.cct).toEqual([tok("cct", "V3")]);
    }
    if (restricted.includes("driver")) {
      expect(hero.variants[2]?.specs).not.toHaveProperty("driver");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Exact shapes: nothing beyond the allowlist reaches a view
// ---------------------------------------------------------------------------

const VIEW_KEYS = [
  "areas",
  "description",
  "extraCategoryIds",
  "extraSpecs",
  "family",
  "hasDatasheet",
  "id",
  "images",
  "mainCategoryId",
  "modelCode",
  "name",
  "productNo",
  "publicFiles",
  "slug",
  "specs",
  "trackSize",
  "type",
  "updatedAt",
  "variants",
].sort();
const CARD_KEYS = ["family", "id", "image", "modelCode", "name", "slug"].sort();

describe("view shapes (filters, datasheetId, status, admin fields never reach a view)", () => {
  it("product view has exactly the allowlisted keys, nested ones too", async () => {
    await setStoredVisibility(all("public"));
    const view = (await getPublicProduct(HOSTILE)) as PublicProductView;
    expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
    for (const v of view.variants)
      expect(Object.keys(v).sort()).toEqual([
        "imagePublicId",
        "label",
        "modelNo",
        "specs",
      ]);
    for (const i of view.images)
      expect(Object.keys(i).sort()).toEqual([
        "alt",
        "kind",
        "order",
        "publicId",
      ]);
    for (const a of view.areas)
      expect(Object.keys(a).sort()).toEqual(["bwImage", "id", "name", "slug"]);
    const json = JSON.stringify(view);
    for (const secret of [
      "ADMIN-ONLY-NOTE",
      "SHA-SECRET",
      "COST-SECRET",
      "UNKNOWN-KEY-VALUE",
      "UNKNOWN-VARIANT",
      "secretColumn",
      "filters",
      "cctK",
      "featured",
      "status",
      "datasheetId",
      ids.datasheet.toHexString(),
      "$gt",
    ]) {
      expect(json.includes(secret), secret).toBe(false);
    }
    expect(view.hasDatasheet).toBe(true);
    // junk entries dropped, wrong-typed value dropped
    expect(view.specs.cct).toEqual(["3000K"]);
    expect(view.specs.driver).toBeUndefined();
    // spec keys only from the fixed 28, in sheet order
    expect(Object.keys(view.specs)).toEqual(
      SPEC_KEYS.filter((k) => k in view.specs),
    );
    // images sorted by order, dangling area dropped
    expect(view.images.map((i) => i.order)).toEqual([0, 1]);
    expect(view.areas.map((a) => a.slug)).toEqual(["office"]);
  });

  it("card views have exactly the allowlisted keys", async () => {
    const hero = (await getPublicProduct(HERO)) as PublicProductView;
    const cards = [
      ...(await getFamilyProducts(hero.family, hero.id)),
      ...(await getRelatedProducts(hero)),
      ...(await getFamilyProducts("Hostile", ids.related.toHexString())),
    ];
    expect(cards.length).toBeGreaterThanOrEqual(3);
    for (const c of cards) {
      expect(Object.keys(c).sort()).toEqual(CARD_KEYS);
      if (c.image)
        expect(Object.keys(c.image).sort()).toEqual([
          "alt",
          "kind",
          "order",
          "publicId",
        ]);
    }
    expect(JSON.stringify(cards)).not.toMatch(/SHA-SECRET|datasheet|LEAK~/);
    // the hostile card prefers its gallery photo over the drawing at order 0
    const hostileCard = cards.find((c) => c.slug === HOSTILE);
    expect(hostileCard?.image?.kind).toBe("gallery");
  });

  it("slug list holds slug + updatedAt only", async () => {
    for (const s of await listPublishedSlugs())
      expect(Object.keys(s).sort()).toEqual(["slug", "updatedAt"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Drafts and any non-published status are invisible everywhere
// ---------------------------------------------------------------------------

describe("drafts and other statuses are invisible everywhere", () => {
  it.each([
    ["draft", "hero-he-003", ids.draft],
    ["archived (raw status)", "hero-he-004", ids.archived],
  ])("%s", async (_l, slug, id) => {
    expect(await getPublicProduct(slug)).toBeNull();
    expect((await listPublishedSlugs()).map((s) => s.slug)).not.toContain(slug);
    const hero = (await getPublicProduct(HERO)) as PublicProductView;
    const cards = [
      ...(await getFamilyProducts("Hero", hero.id)),
      ...(await getFamilyProducts("Hero", ids.sibling.toHexString())),
      ...(await getRelatedProducts(hero)),
      ...(await getRelatedProducts({ ...hero, family: null, areas: [] })),
    ];
    expect(cards.map((c) => c.slug)).not.toContain(slug);
    getSession.mockResolvedValue({
      session: { id: "s" },
      user: {
        id: "u",
        role: "admin",
        banned: false,
        mustChangePassword: false,
      },
    });
    expect(await getRestrictedSpecs(id.toHexString())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Malformed and injection inputs: empty answer, no query
// ---------------------------------------------------------------------------

describe("malformed / injection inputs", () => {
  const badSlugs: unknown[] = [
    "",
    " ",
    "Hero-HE-001",
    "hero_he_001",
    "-hero",
    "hero-",
    "hero--he",
    "../hero",
    "hero/he",
    "hero%2dhe",
    "hero\nhe",
    "héro",
    "a".repeat(121),
    { $ne: null },
    { $regex: ".*" },
    ["hero-he-001"],
    42,
    null,
    undefined,
  ];

  it.each(badSlugs.map((s) => [JSON.stringify(s) ?? String(s), s]))(
    "getPublicProduct(%s) is null without a query",
    async (_l, slug) => {
      const find = vi.spyOn(ProductModel, "findOne");
      expect(await getPublicProduct(slug as string)).toBeNull();
      expect(find).not.toHaveBeenCalled();
    },
  );

  it("a 120-char valid slug is accepted (boundary) and just not found", async () => {
    expect(
      await getPublicProduct(`a${"-b".repeat(59)}c`.slice(0, 120)),
    ).toBeNull();
  });

  it.each<unknown>([{ $ne: null }, { $gt: "" }, ["Hero"], 7])(
    "getFamilyProducts with a non-string family %j never matches other families",
    async (family) => {
      let cards: unknown = [];
      try {
        cards = await getFamilyProducts(
          family as string,
          ids.hero.toHexString(),
        );
      } catch {
        cards = []; // a TypeError is acceptable: nothing is returned
      }
      expect(cards).toEqual([]);
    },
  );

  it.each([
    "",
    "xyz",
    "z".repeat(24),
    `${ids.hero.toHexString()}0`,
    "{}",
    " ".repeat(24),
  ])(
    "getFamilyProducts with excludeId %j is empty without a query",
    async (bad) => {
      const find = vi.spyOn(ProductModel, "find");
      expect(await getFamilyProducts("Hero", bad)).toEqual([]);
      expect(find).not.toHaveBeenCalled();
    },
  );

  it("an upper-case excludeId still excludes the product itself", async () => {
    const cards = await getFamilyProducts(
      "Hero",
      ids.hero.toHexString().toUpperCase(),
    );
    expect(cards.map((c) => c.slug)).toEqual(["hero-he-002"]);
  });

  it("getRelatedProducts ignores malformed ids and never throws on them", async () => {
    const hero = (await getPublicProduct(HERO)) as PublicProductView;
    expect(await getRelatedProducts({ ...hero, id: "nope" })).toEqual([]);
    expect(await getRelatedProducts({ ...hero, mainCategoryId: "" })).toEqual(
      [],
    );
    const withJunkAreas = await getRelatedProducts({
      ...hero,
      areas: [
        { id: "{$ne:1}", name: "", slug: "", bwImage: null },
        ...hero.areas,
      ],
    });
    expect(withJunkAreas).toEqual(await getRelatedProducts(hero));
  });

  it.each(["__proto__", "constructor", "toString", "", "x".repeat(5000)])(
    "getBreadcrumb(%j) is empty",
    async (id) => {
      expect(await getBreadcrumb({ mainCategoryId: id })).toEqual([]);
    },
  );

  it.each<unknown>([
    { $gt: "" },
    [ids.hero.toHexString()],
    1,
    null,
    undefined,
    "x".repeat(24),
  ])(
    "getRestrictedSpecs(%j) is null without reading the session or a product",
    async (bad) => {
      getSession.mockResolvedValue({
        session: { id: "s" },
        user: {
          id: "u",
          role: "admin",
          banned: false,
          mustChangePassword: false,
        },
      });
      const find = vi.spyOn(ProductModel, "findOne");
      expect(await getRestrictedSpecs(bad as string)).toBeNull();
      expect(getSession).not.toHaveBeenCalled();
      expect(find).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// 5. getRestrictedSpecs access matrix (beyond the dev's cases)
// ---------------------------------------------------------------------------

describe("getRestrictedSpecs access matrix", () => {
  const DAY = 86_400_000;
  const heroId = ids.hero.toHexString();
  const as = (
    user: Record<string, unknown> | null,
    session: unknown = { id: "s" },
  ) =>
    getSession.mockResolvedValue(
      user === null
        ? null
        : {
            session,
            user: {
              id: "u",
              role: "customer",
              banned: false,
              banExpires: null,
              mustChangePassword: false,
              accessExpiresAt: null,
              ...user,
            },
          },
    );

  it.each<[string, Record<string, unknown> | null]>([
    ["visitor", null],
    [
      "banned, ban ends tomorrow",
      { banned: true, banExpires: new Date(Date.now() + DAY) },
    ],
    [
      "banned, unreadable banExpires",
      { banned: true, banExpires: "not-a-date" },
    ],
    [
      "expired (ISO string)",
      { accessExpiresAt: new Date(Date.now() - DAY).toISOString() },
    ],
    ["unreadable accessExpiresAt", { accessExpiresAt: "soon" }],
    ["mustChangePassword missing", { mustChangePassword: undefined }],
    ["mustChangePassword null", { mustChangePassword: null }],
    ["mustChangePassword 'false' string", { mustChangePassword: "false" }],
    ["role missing", { role: undefined }],
    ["role empty", { role: "" }],
    ["role 'Admin' (case)", { role: "Admin" }],
    ["role 'administrator'", { role: "administrator" }],
    ["role 'staff'", { role: "staff" }],
    ["role 'user' (Better Auth default role)", { role: "user" }],
    [
      "admin on temporary password",
      { role: "admin", mustChangePassword: true },
    ],
    ["banned admin", { role: "admin", banned: true }],
  ])("refuses %s (no product read)", async (_l, user) => {
    as(user);
    const find = vi.spyOn(ProductModel, "findOne");
    expect(await getRestrictedSpecs(heroId)).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "customer, ISO-string expiry in the future",
      { accessExpiresAt: new Date(Date.now() + DAY).toISOString() },
    ],
    [
      "admin with unreadable accessExpiresAt (admin has no expiry)",
      { role: "admin", accessExpiresAt: "x" },
    ],
    [
      "customer whose timed ban is over",
      { banned: true, banExpires: new Date(Date.now() - 1000) },
    ],
  ])("allows %s", async (_l, user) => {
    as(user);
    const view = await getRestrictedSpecs(heroId);
    expect(view?.keys).toEqual([...DEFAULT_RESTRICTED_SPEC_KEYS]);
    expect(view?.variants.map((v) => v.modelNo)).toEqual([
      "HE-001A",
      "HE-001B",
      "HE-001C",
    ]);
    // variant C inherits everything but its own driver
    expect(view?.variants[2]?.specs.driver).toEqual([tok("driver", "V3")]);
    expect(view?.variants[2]?.specs.batchNo).toEqual([
      tok("batchNo", "P"),
      `${tok("batchNo", "P")}2`,
    ]);
  });

  it("returns ONLY restricted keys under each random visibility, never a public value", async () => {
    as({ role: "admin" });
    for (const [, stored, restricted] of CASES) {
      await setStoredVisibility(stored);
      const view = await getRestrictedSpecs(heroId);
      const pub = SPEC_KEYS.filter((k) => !restricted.includes(k));
      expect(view?.keys).toEqual(
        SPEC_KEYS.filter((k) => restricted.includes(k)),
      );
      expectNoLeak(view, pub, "restricted reader carries a public key");
    }
  });

  it("hostile raw document: only fixed keys, junk dropped", async () => {
    as({ role: "admin" });
    await setStoredVisibility(all("restricted"));
    const view = await getRestrictedSpecs(ids.hostile.toHexString());
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/secretColumn|UNKNOWN|COST-SECRET|\$gt/);
    expect(view?.specs.driver).toBeUndefined(); // wrong type dropped
    expect(view?.specs.cct).toEqual(["3000K"]);
  });
});

// ---------------------------------------------------------------------------
// 6. P2: SPEC_COLUMNS placement / group / restrictedSpecKeys / spec-groups
// ---------------------------------------------------------------------------

describe("P2 spec columns (ADR 0054)", () => {
  it("pink keys are exactly placement=quick, in sheet order", () => {
    expect(specColumnsFor("quick").map((c) => c.key)).toEqual([
      "housingMaterial",
      "housingFinish",
      "reflectorColor",
      "cutOutSize",
      "cct",
    ]);
    expect(specColumnsFor("table")).toHaveLength(23);
  });

  it("groups are contiguous and the editor groups cover every key once", () => {
    const seen = SPEC_GROUPS.flatMap((g) => g.columns.map((c) => c.key));
    expect(seen).toEqual([...SPEC_KEYS]);
    expect(new Set(SPEC_GROUPS.map((g) => g.title)).size).toBe(
      SPEC_GROUPS.length,
    );
  });

  it("restrictedSpecKeys: override wins, unknown keys ignored, never mutates", () => {
    expect(restrictedSpecKeys()).toEqual([...DEFAULT_RESTRICTED_SPEC_KEYS]);
    const odd = { driver: "public", nonsense: "restricted" } as never;
    expect(restrictedSpecKeys(odd)).toEqual([
      "batchNo",
      "chipType",
      "holder",
      "chipEfficiency",
    ]);
    expect(Object.isFrozen(SPEC_COLUMNS) || SPEC_COLUMNS.length === 28).toBe(
      true,
    );
  });

  it("FINDING L-2: restrictedSpecKeys treats a non-'restricted' typo as PUBLIC (fails open if ever fed unparsed data)", () => {
    // Today every caller passes parseStoredColumnVisibility output (fails
    // closed), so this is not reachable; it documents the helper contract.
    expect(restrictedSpecKeys({ driver: "RESTRICTED" } as never)).not.toContain(
      "driver",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Cache wrappers: tags and key parts
// ---------------------------------------------------------------------------

describe("cache wrappers", () => {
  it("every wrapper has a unique, versioned key and only catalog tags", () => {
    const keys = cacheCalls.map((c) => c.keyParts.join("|"));
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of cacheCalls) {
      expect(c.keyParts[0]).toBe("catalog");
      expect(c.keyParts.at(-1)).toMatch(/^v\d+$/);
      for (const t of c.tags)
        expect([
          "products",
          "categories",
          "areas",
          "settings:columns",
        ]).toContain(t);
    }
    // The visibility-dependent entry MUST carry settings:columns.
    const product = cacheCalls.find((c) =>
      c.keyParts.includes("public-product"),
    );
    expect(product?.tags).toContain("settings:columns");
    expect(product?.tags).toContain("areas");
  });
});

// ---------------------------------------------------------------------------
// 8. FINDING H-1: import-built variant labels are made of optic SPEC VALUES
// ---------------------------------------------------------------------------

describe("FINDING H-1: variant labels carry Lens/Reflector/Diffuser values", () => {
  it("the importer builds labels from the lens values (precondition, passes)", () => {
    const base = { family: "Arc", type: "Spot", cct: "3000K" };
    const { products } = groupRows(
      [
        cleanRow({
          sheet: "S",
          row: 2,
          hidden: false,
          cells: {
            productNo: "1",
            modelNo: "AR-1A",
            lens: "SECRET-LENS-ALPHA",
            ...base,
          },
        }),
        cleanRow({
          sheet: "S",
          row: 3,
          hidden: false,
          cells: {
            productNo: "1",
            modelNo: "AR-1B",
            lens: "SECRET-LENS-BETA",
            ...base,
          },
        }),
      ],
      {
        defaultCategoryId: "c0000000000000000000000a",
        categories: [],
        areas: [],
      },
    );
    expect(products[0]?.variants.map((v) => v.label)).toEqual([
      "SECRET-LENS-ALPHA",
      "SECRET-LENS-BETA",
    ]);
  });

  /*
   * Repro: admin sets Lens (or Reflector / Diffuser) to restricted. The
   * cached public view still carries variants[].label = the lens values
   * the import derived, so the restricted value reaches cached HTML / the
   * Models table / the switcher (rule 9). it.fails = open finding.
   */
  it.fails(
    "a restricted Lens column does not reach the public view through variant labels",
    async () => {
      const id = new Types.ObjectId();
      await ProductModel.create({
        ...publishedBase(),
        _id: id,
        name: "Arc AR-1",
        slug: "arc-ar-1",
        family: "Arc",
        // exactly what commit.ts writes for the grouped product above
        variants: [
          {
            modelNo: "AR-1A",
            label: "SECRET-LENS-ALPHA",
            specs: { lens: ["SECRET-LENS-ALPHA"] },
          },
          {
            modelNo: "AR-1B",
            label: "SECRET-LENS-BETA",
            specs: { lens: ["SECRET-LENS-BETA"] },
          },
        ],
      });
      try {
        await setStoredVisibility({ ...all("public"), lens: "restricted" });
        const view = await getPublicProduct("arc-ar-1");
        expect(view?.variants[0]?.specs.lens).toBeUndefined(); // projection works
        expect(JSON.stringify(view)).not.toContain("SECRET-LENS"); // ...label leaks
      } finally {
        await ProductModel.deleteOne({ _id: id });
      }
    },
  );
});
