// QA gate B (Phase 4b, L4-L6): the restricted-data leak test on the REAL
// listing, area and search pages, the search overlay's answers, the header
// menus and the sitemap served by `next start`, with two products whose EVERY
// spec column (all 28, product and variant level) holds a unique token
// (fixtures/listing-gate-b.ts, seeded before the server starts).
//
//  1. Visitor, default visibility: HTML, RSC payload and prefetch of every
//     catalog page hold no spec value at all (cards and facets carry none),
//     no variant label, nothing of a draft; the search route's JSON neither.
//  2. The browser: every response loaded while the mega-menu and the search
//     overlay are used (scripts included) is value-free.
//  3. The admin restricts EVERY column through the real settings screen:
//     the facets disappear at once, filter params of restricted columns are
//     ignored (no noindex, same count), product page included nothing leaks;
//     then back to the defaults and the facets return on the first request.
//  4. Cache expiry after real admin writes: category rename, area rename,
//     product unpublish/publish show on the first visitor request (listing,
//     area, menu, search, sitemap).
//  5. A junk-parameter flood adds no data-cache entry (.next/cache/fetch-cache)
//     and every answer stays 200/404, never 500.
//  6. Sitemap: path-only <loc>s (no query string), no draft-only category.
//  7. Keyboard and axe (360/1280) with the mega-menu, the small-screen menu
//     and the overlay open on listing and area pages.
// Never `networkidle`.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  type APIRequestContext,
  type Browser,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { Db, MongoClient, ObjectId } from "mongodb";

import { SPEC_COLUMNS } from "../src/models/spec-columns";
import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import {
  LGB,
  LGB_AREA_PATH,
  LGB_DEFAULT_RESTRICTED_TOKENS,
  LGB_DRAFT_TOKENS,
  LGB_DRAFTCAT_PATH,
  LGB_LABEL_TOKENS,
  LGB_MAIN_PATH,
  LGB_SPEC_TOKENS,
  LGB_SUB_PATH,
  lgbToken,
} from "./fixtures/listing-gate-b";
import {
  axeViolations,
  horizontalOverflow,
  serveImages,
  waitForHydration,
} from "./fixtures/product-page-helpers";

/*
 * A category whose subtree holds only drafts: hidden from the menus, the
 * sitemap, search (gate-A I-2) and other categories' sub-category rows
 * (finding M-1, checked separately below).
 */
const DRAFT_CATEGORY_TOKENS: readonly string[] = [
  LGB.draftCat.name,
  LGB.draftCat.slug,
];
/** The draft product's tokens (name, slug, model no.). */
const DRAFT_NON_CATEGORY = LGB_DRAFT_TOKENS.filter(
  (t) => !DRAFT_CATEGORY_TOKENS.includes(t),
);
/** Every value that must never reach a public catalog page or answer. */
const NEVER = [...LGB_SPEC_TOKENS, ...LGB_LABEL_TOKENS, ...DRAFT_NON_CATEGORY];

const found = (text: string, tokens: readonly string[] = NEVER) =>
  tokens.filter((token) => text.toUpperCase().includes(token.toUpperCase()));

const P1_PATH = `/product/${LGB.p1.slug}`;
const P2_PATH = `/product/${LGB.p2.slug}`;

/** The catalog pages under test (all render on request, except home). */
const CATALOG_PAGES = [
  LGB_MAIN_PATH,
  LGB_SUB_PATH,
  `${LGB_SUB_PATH}?cct=${LGB.filters.cctK}&ip=${LGB.filters.ip}&sort=name`,
  LGB_AREA_PATH,
  `${LGB_AREA_PATH}?cat=${LGB.main.slug}&ugr=${LGB.filters.ugr}`,
  "/products",
  "/areas",
  "/search?q=Gatelist",
  `/search?q=${LGB.p1.v2.toLowerCase()}`,
  "/search?q=lgbfam",
  "/search?q=Qaxdraft",
  "/",
] as const;

/** Search route queries: name, family, model no. exact/prefix, draft names. */
const SEARCH_QUERIES = [
  "Gatelist",
  "gatelist spots",
  "lgbfam",
  LGB.p1.v1,
  LGB.p1.v2.toLowerCase(),
  LGB.p1.modelCode,
  "Qaxdraft",
  LGB.draft.modelNo,
  "Qaxdraftcat",
  // A spec token itself must find nothing (specs are not indexed).
  lgbToken("driver", "p1"),
  lgbToken("housingMaterial", "p1"),
];

let client: MongoClient;
let db: Db;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
});

test.afterAll(async () => {
  await client.close();
});

/* HTML, RSC payload and router prefetch of one path, as the server sends them. */
async function serverAnswers(request: APIRequestContext, path: string) {
  const html = await request.get(path);
  expect(html.status(), path).toBe(200);
  const rsc = await request.get(path, { headers: { RSC: "1" } });
  expect(rsc.status(), `${path} (RSC)`).toBe(200);
  expect(rsc.headers()["content-type"]).toContain("text/x-component");
  const prefetch = await request.get(path, {
    headers: { RSC: "1", "Next-Router-Prefetch": "1" },
  });
  expect(prefetch.status(), `${path} (prefetch)`).toBe(200);
  return {
    html: await html.text(),
    rsc: await rsc.text(),
    prefetch: await prefetch.text(),
  };
}

/** All catalog pages + search JSON + sitemap as one text, leaks per path. */
async function catalogLeaks(
  request: APIRequestContext,
  tokens: readonly string[] = NEVER,
  extraPages: readonly string[] = [],
): Promise<string[]> {
  const leaks: string[] = [];
  for (const path of [...CATALOG_PAGES, ...extraPages]) {
    const a = await serverAnswers(request, path);
    for (const [kind, text] of Object.entries(a)) {
      for (const token of found(text, tokens)) {
        leaks.push(`${token} in ${path} (${kind})`);
      }
    }
  }
  for (const q of SEARCH_QUERIES) {
    const response = await request.get(
      `/api/catalog/search?q=${encodeURIComponent(q)}`,
    );
    expect(response.status(), q).toBe(200);
    // The answer echoes the query itself; everything else is checked.
    const answer = (await response.json()) as Record<string, unknown>;
    delete answer.query;
    for (const token of found(JSON.stringify(answer), tokens)) {
      leaks.push(`${token} in search ${q}`);
    }
  }
  const sitemap = await (await request.get("/sitemap.xml")).text();
  for (const token of found(sitemap, tokens)) {
    leaks.push(`${token} in sitemap`);
  }
  return leaks;
}

/** The filter parameters of the listing's facet inputs (desktop rail). */
async function facetParams(request: APIRequestContext, path: string) {
  const html = await (await request.get(path)).text();
  const names = new Set<string>();
  for (const match of html.matchAll(
    /<input[^>]*type="checkbox"[^>]*name="([a-z]+)"[^>]*value="([^"]*)"/g,
  )) {
    names.add(`${match[1]}=${match[2]}`);
  }
  return names;
}

const robotsOf = (html: string) =>
  /<meta name="robots" content="([^"]*)"/.exec(html)?.[1] ?? null;
const resultCountOf = (html: string) =>
  /data-slot="result-count"[^>]*>([\s\S]*?)<\/p>/
    .exec(html)?.[1]
    ?.replace(/<[^>]+>/g, "")
    .replace(/<!-- -->/g, "")
    .trim() ?? null;

// ---------------------------------------------------------------------------
// 1. Visitor, default visibility
// ---------------------------------------------------------------------------

test.describe("a visitor (default visibility)", () => {
  test("the grep works: names, model nos. and categories ARE in the pages", async ({
    request,
  }) => {
    const sub = await serverAnswers(request, LGB_SUB_PATH);
    expect(sub.html).toContain(LGB.p1.name);
    expect(sub.html).toContain(LGB.p2.name);
    expect(sub.html).toContain(LGB.p1.modelCode);
    expect(sub.rsc).toContain(LGB.p1.name);
    const area = await serverAnswers(request, LGB_AREA_PATH);
    expect(area.html).toContain(LGB.p2.name);
    const search = await serverAnswers(
      request,
      `/search?q=${LGB.p1.v2.toLowerCase()}`,
    );
    // The matched model no. is shown and linked.
    expect(search.html).toContain(`/product/${LGB.p1.slug}?model=${LGB.p1.v2}`);
    // The facets of the fixture's filter numbers are offered.
    const facets = await facetParams(request, LGB_SUB_PATH);
    for (const pair of [
      `cct=${LGB.filters.cctK}`,
      `cri=${LGB.filters.cri}`,
      `beam=${LGB.filters.beamDeg}`,
      `ugr=${LGB.filters.ugr}`,
      `w=41+`,
      `ip=${LGB.filters.ip}`,
    ]) {
      expect([...facets], pair).toContain(pair);
    }
  });

  test("no spec value of ANY column, no label, no draft: HTML, RSC, prefetch, search JSON, sitemap", async ({
    request,
  }) => {
    expect(await catalogLeaks(request)).toEqual([]);
  });

  test("search answers carry card fields only, drafts and draft-only categories never", async ({
    request,
  }) => {
    const allowed = [
      "id",
      "slug",
      "name",
      "family",
      "modelCode",
      "image",
      "variantCount",
      "matchedModelNo",
    ];
    const answer = async (q: string) => {
      const response = await request.get(
        `/api/catalog/search?q=${encodeURIComponent(q)}`,
      );
      expect(response.headers()["cache-control"]).toBe("private, max-age=30");
      expect(response.headers()["set-cookie"]).toBeUndefined();
      return (await response.json()) as {
        products: Record<string, unknown>[];
        categories: { name: string; slugPath: string[] }[];
      };
    };
    const byName = await answer("Gatelist");
    expect(byName.products.map((p) => p.slug).sort()).toEqual(
      [LGB.p1.slug, LGB.p2.slug].sort(),
    );
    for (const hit of byName.products) {
      expect(Object.keys(hit).every((key) => allowed.includes(key))).toBe(true);
    }
    expect(byName.categories.map((c) => c.name)).toEqual(
      expect.arrayContaining([LGB.main.name, LGB.sub.name]),
    );
    const byModel = await answer(LGB.p1.v2.toLowerCase());
    expect(byModel.products[0]?.matchedModelNo).toBe(LGB.p1.v2);
    for (const q of ["Qaxdraft", "Qaxdraftcat", LGB.draft.modelNo]) {
      const hidden = await answer(q);
      expect(hidden.products, q).toEqual([]);
      expect(hidden.categories, q).toEqual([]);
    }
    for (const key of ["driver", "chipType", "housingMaterial", "cct"]) {
      expect((await answer(lgbToken(key, "p1v1"))).products, key).toEqual([]);
    }
  });

  test("the draft-only category: hidden in menus, sitemap and search; its page lists nothing", async ({
    request,
  }) => {
    const sub = await serverAnswers(request, LGB_SUB_PATH);
    // The small-screen menu is server HTML (the mega-menu panel is checked
    // in the browser test); the listing header row is finding M-1.
    const mobileNav =
      /data-slot="mobile-nav"[\s\S]*?<\/nav>/.exec(sub.html)?.[0] ?? "";
    expect(mobileNav).toContain(LGB.sub.name);
    expect(found(mobileNav, DRAFT_CATEGORY_TOKENS)).toEqual([]);
    // The path itself resolves (tree), but lists no draft.
    const page = await request.get(LGB_DRAFTCAT_PATH);
    expect(page.status()).toBe(200);
    const html = await page.text();
    expect(found(html)).toEqual([]);
    expect(html).toContain('data-slot="listing-empty"');
    // Drafts never count in any facet or total.
    expect(resultCountOf(sub.html)).toBe("2 products");
  });

  test("M-1: the listing header's sub-category row never names a draft-only category", async ({
    request,
  }) => {
    // subLinksOf() applies categoriesWithPublished (the menu/sitemap/search
    // rule); the draft-only page itself answers 200 but is not indexed.
    const leaks: string[] = [];
    for (const path of [LGB_MAIN_PATH, LGB_SUB_PATH]) {
      const a = await serverAnswers(request, path);
      for (const [kind, text] of Object.entries(a)) {
        for (const token of found(text, DRAFT_CATEGORY_TOKENS)) {
          leaks.push(`${token} in ${path} (${kind})`);
        }
      }
    }
    expect(leaks).toEqual([]);
    const own = await (await request.get(LGB_DRAFTCAT_PATH)).text();
    expect(robotsOf(own)).toBe("noindex, follow");
    expect(robotsOf(await (await request.get(LGB_SUB_PATH)).text())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The browser: every response while menu and overlay are used
// ---------------------------------------------------------------------------

/*
 * Records the body of every text response; `settle()` waits for bodies still
 * being read, so a late chunk or RSC payload is never skipped.
 */
function recordBodies(page: Page) {
  const bodies: { url: string; body: string }[] = [];
  const pending: Promise<void>[] = [];
  page.on("response", (response) => {
    pending.push(
      (async () => {
        const type = response.headers()["content-type"] ?? "";
        if (!/text|javascript|json|x-component|xml/.test(type)) return;
        try {
          bodies.push({ url: response.url(), body: await response.text() });
        } catch {
          // Redirects and aborted requests have no body.
        }
      })(),
    );
  });
  return { bodies, settle: () => Promise.allSettled(pending) };
}
const leaksIn = (bodies: { url: string; body: string }[]) =>
  bodies.flatMap(({ url, body }) =>
    found(body).map((token) => `${token} in ${url}`),
  );

const menuButton = (page: Page) =>
  page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: "Product" });
const megaPanel = (page: Page) => page.locator('[data-slot="mega-menu-panel"]');
const searchTrigger = (page: Page) =>
  page.locator('[data-slot="search-trigger"]');
const overlay = (page: Page) => page.locator('[data-slot="search-overlay"]');

test.describe("the browser (1280)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("mega-menu, overlay type-ahead, a filter tick and the area page load no value", async ({
    page,
  }) => {
    await serveImages(page);
    const { bodies, settle } = recordBodies(page);
    await page.goto(LGB_SUB_PATH);
    await waitForHydration(menuButton(page));

    await menuButton(page).click();
    await expect(megaPanel(page)).toBeVisible();
    const main = megaPanel(page).getByRole("link", {
      name: LGB.main.name,
      exact: true,
    });
    await main.focus();
    await expect(
      megaPanel(page).getByRole("link", { name: LGB.sub.name, exact: true }),
    ).toBeVisible();
    await expect(megaPanel(page)).not.toContainText(LGB.draftCat.name);
    await page.keyboard.press("Escape");

    await waitForHydration(searchTrigger(page));
    await searchTrigger(page).click();
    const input = overlay(page).getByRole("combobox");
    for (const q of ["gatelist", LGB.p1.v1.toLowerCase(), "qaxdraft"]) {
      const answered = page.waitForResponse((r) =>
        r.url().includes("/api/catalog/search?q="),
      );
      await input.fill(q);
      await answered;
      await expect(
        overlay(page).locator('[data-slot="search-status"]'),
      ).not.toHaveText("Searching…");
    }
    expect(found(await overlay(page).innerHTML())).toEqual([]);
    await page.keyboard.press("Escape");

    // A filter tick (client router.replace → RSC fetch).
    const cct = page
      .locator('[data-slot="filter-rail"]')
      .locator(`input[name="cct"][value="${LGB.filters.cctK}"]`);
    await cct.check();
    await expect(page).toHaveURL(new RegExp(`cct=${LGB.filters.cctK}`));
    // Client navigation (RSC fetch) to the area page from the mega-menu.
    await menuButton(page).click();
    await megaPanel(page)
      .getByRole("link", { name: LGB.area.name, exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`${LGB_AREA_PATH}$`));
    await expect(page.locator("h1")).toHaveText(LGB.area.name);
    await settle();

    expect(bodies.length).toBeGreaterThan(5);
    expect(bodies.some(({ body }) => body.includes(LGB.p1.name))).toBe(true);
    expect(leaksIn(bodies)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Every column restricted, then back
// ---------------------------------------------------------------------------

const restrictSwitch = (page: Page, header: string) =>
  page.getByRole("switch", { name: `Restrict ${header}`, exact: true });

/**
 * Sets every column to restricted (`all`) or back to the defaults on
 * /admin/settings through the real form and save action.
 */
async function setVisibility(browser: Browser, mode: "all" | "defaults") {
  const context = await browser.newContext({
    storageState: loadState("admin"),
  });
  const page = await context.newPage();
  await page.goto("/admin/settings");
  for (const column of SPEC_COLUMNS) {
    const want =
      mode === "all" ? true : column.defaultVisibility === "restricted";
    const toggle = restrictSwitch(page, column.header);
    const checked = (await toggle.getAttribute("aria-checked")) === "true";
    if (checked !== want) await toggle.click();
  }
  await page.getByRole("button", { name: "Save column settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await context.close();
}

test.describe("every column restricted, then back", () => {
  let saved: { _id: ObjectId; filters: unknown }[] = [];
  let changed = false;

  test.beforeAll(async () => {
    // The save drops restricted columns' filter numbers from EVERY product;
    // they are put back before the visibility is restored (the restore save
    // expires the `products` tag, so the readers see them again).
    saved = (await db
      .collection("products")
      .find({}, { projection: { filters: 1 } })
      .toArray()) as { _id: ObjectId; filters: unknown }[];
  });

  async function restoreFilters() {
    for (const doc of saved) {
      await db
        .collection("products")
        .updateOne(
          { _id: doc._id },
          doc.filters === undefined
            ? { $unset: { filters: "" } }
            : { $set: { filters: doc.filters } },
        );
    }
  }

  test.afterAll(async ({ browser }) => {
    if (!changed) return;
    await restoreFilters();
    await setVisibility(browser, "defaults");
  });

  test("facets go, params are ignored and nothing leaks; back again on the first request", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    // Warm every entry first, so a stale cache would show.
    const filtered = `${LGB_SUB_PATH}?cct=${LGB.filters.cctK}`;
    const warm = await (await request.get(filtered)).text();
    expect(robotsOf(warm)).toBe("noindex, follow");
    expect(resultCountOf(warm)).toBe("2 of 2 products");
    expect((await facetParams(request, LGB_SUB_PATH)).size).toBeGreaterThan(0);
    // The product page shows public spec values (sanity for the grep; the
    // variant value wins where variants differ, so any place counts).
    expect((await (await request.get(P1_PATH)).text()).toUpperCase()).toContain(
      "LGBXHOUSINGMATERIAL",
    );

    changed = true;
    await setVisibility(browser, "all");

    // First visitor request after the save: no facet at all.
    expect([...(await facetParams(request, LGB_SUB_PATH))]).toEqual([]);
    expect([...(await facetParams(request, LGB_AREA_PATH))]).toEqual(
      expect.not.arrayContaining([
        expect.stringMatching(/^(cct|cri|beam|ugr|w|ip)=/),
      ]),
    );
    // A restricted filter param is dropped: not refined, nothing filtered.
    const ignored = await (await request.get(filtered)).text();
    expect(robotsOf(ignored)).toBeNull();
    expect(resultCountOf(ignored)).toBe("2 products");
    // Nothing anywhere, the product pages (HTML/RSC) included.
    expect(await catalogLeaks(request, NEVER, [P1_PATH, P2_PATH])).toEqual([]);
    // The search index never held specs: same answers as before.
    const byModel = await (
      await request.get(`/api/catalog/search?q=${LGB.p1.v2}`)
    ).json();
    expect(byModel.products[0]?.matchedModelNo).toBe(LGB.p1.v2);

    // Back to the defaults (filter numbers restored first).
    await restoreFilters();
    await setVisibility(browser, "defaults");
    changed = false;
    const facets = await facetParams(request, LGB_SUB_PATH);
    expect([...facets]).toContain(`cct=${LGB.filters.cctK}`);
    expect([...facets]).toContain(`ip=${LGB.filters.ip}`);
    const refined = await (await request.get(filtered)).text();
    expect(robotsOf(refined)).toBe("noindex, follow");
    expect(resultCountOf(refined)).toBe("2 of 2 products");
    // Default-restricted values stay out everywhere, product pages included.
    expect(
      await catalogLeaks(
        request,
        [...LGB_DEFAULT_RESTRICTED_TOKENS, ...DRAFT_NON_CATEGORY],
        [P1_PATH, P2_PATH],
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Cache expiry after real admin writes
// ---------------------------------------------------------------------------

async function adminPage(browser: Browser) {
  const context = await browser.newContext({
    storageState: loadState("admin"),
  });
  return { context, page: await context.newPage() };
}

async function renameIn(
  browser: Browser,
  path: string,
  name: string,
  listPath: RegExp,
) {
  const { context, page } = await adminPage(browser);
  await page.goto(path);
  const field = page.getByLabel("Name", { exact: true });
  await field.fill(name);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(listPath);
  await context.close();
}

test.describe("cache expiry after admin writes (first visitor request)", () => {
  test.describe.configure({ timeout: 180_000 });

  test("category rename: listing, menu data, search and sitemap follow", async ({
    browser,
    request,
  }) => {
    const NEW = "Gatelist Beams";
    // Warm.
    await serverAnswers(request, LGB_SUB_PATH);
    await request.get("/api/catalog/search?q=Gatelist");
    await renameIn(
      browser,
      `/admin/categories/${LGB.subId.toHexString()}`,
      NEW,
      /\/admin\/categories(\?|$)/,
    );
    try {
      const sub = await serverAnswers(request, LGB_SUB_PATH);
      expect(sub.html).toContain(`>${NEW}</h1>`);
      expect(sub.rsc).toContain(NEW);
      expect(sub.rsc).not.toContain(`"${LGB.sub.name}"`);
      const products = await serverAnswers(request, "/products");
      expect(products.html + products.rsc).toContain(NEW);
      const search = (await (
        await request.get("/api/catalog/search?q=Gatelist")
      ).json()) as { categories: { name: string }[] };
      expect(search.categories.map((c) => c.name)).toContain(NEW);
      expect(search.categories.map((c) => c.name)).not.toContain(LGB.sub.name);
    } finally {
      await renameIn(
        browser,
        `/admin/categories/${LGB.subId.toHexString()}`,
        LGB.sub.name,
        /\/admin\/categories(\?|$)/,
      );
    }
    expect((await serverAnswers(request, LGB_SUB_PATH)).html).toContain(
      `>${LGB.sub.name}</h1>`,
    );
  });

  test("area rename: area page, /areas, menu data and the product page follow", async ({
    browser,
    request,
  }) => {
    const NEW = "Gatelist Atrium";
    await serverAnswers(request, LGB_AREA_PATH);
    await request.get("/areas");
    await request.get(P1_PATH);
    await renameIn(
      browser,
      `/admin/areas/${LGB.areaId.toHexString()}`,
      NEW,
      /\/admin\/areas(\?|$)/,
    );
    try {
      const area = await serverAnswers(request, LGB_AREA_PATH);
      expect(area.html).toContain(`>${NEW}</h1>`);
      const areas = await (await request.get("/areas")).text();
      expect(areas).toContain(NEW);
      expect(areas).not.toContain(`>${LGB.area.name}<`);
      const listing = await serverAnswers(request, LGB_SUB_PATH);
      expect(listing.rsc).toContain(NEW);
      // ISR product page: its applications row (tag `areas`).
      expect(await (await request.get(P1_PATH)).text()).toContain(NEW);
    } finally {
      await renameIn(
        browser,
        `/admin/areas/${LGB.areaId.toHexString()}`,
        LGB.area.name,
        /\/admin\/areas(\?|$)/,
      );
    }
    expect((await serverAnswers(request, LGB_AREA_PATH)).html).toContain(
      `>${LGB.area.name}</h1>`,
    );
  });

  test("product unpublish/publish: listing, area, facets, search, sitemap follow", async ({
    browser,
    request,
  }) => {
    // Warm.
    expect(
      resultCountOf((await serverAnswers(request, LGB_SUB_PATH)).html),
    ).toBe("2 products");
    await serverAnswers(request, LGB_AREA_PATH);
    await request.get("/api/catalog/search?q=Gatelist");
    await request.get("/sitemap.xml");

    const { context, page } = await adminPage(browser);
    await page.goto(`/admin/products/${LGB.p2Id.toHexString()}`);
    await page.getByRole("button", { name: "Move to draft" }).click();
    await expect(
      page.getByText("Moved to draft. The product is hidden from the site."),
    ).toBeVisible();
    try {
      const sub = await serverAnswers(request, LGB_SUB_PATH);
      expect(resultCountOf(sub.html)).toBe("1 product");
      expect(sub.html + sub.rsc).not.toContain(LGB.p2.name);
      const area = await serverAnswers(request, LGB_AREA_PATH);
      expect(area.html + area.rsc).not.toContain(LGB.p2.name);
      const search = (await (
        await request.get("/api/catalog/search?q=Gatelist")
      ).json()) as { products: { slug: string }[] };
      expect(search.products.map((p) => p.slug)).toEqual([LGB.p1.slug]);
      const sitemap = await (await request.get("/sitemap.xml")).text();
      expect(sitemap).not.toContain(LGB.p2.slug);
      expect((await request.get(P2_PATH)).status()).toBe(404);
    } finally {
      await page.reload();
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(
        page.getByText("Published. The product is now on the site."),
      ).toBeVisible();
      await context.close();
    }
    const back = await serverAnswers(request, LGB_SUB_PATH);
    expect(resultCountOf(back.html)).toBe("2 products");
    expect((await request.get(P2_PATH)).status()).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5. Junk-parameter flood
// ---------------------------------------------------------------------------

const FETCH_CACHE = join(process.cwd(), ".next", "cache", "fetch-cache");

/** Data-cache entries on disk (the file-system handler `next start` uses). */
function cacheEntries(): number {
  const walk = (dir: string): number => {
    let n = 0;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const full = join(dir, name);
      n += statSync(full).isDirectory() ? walk(full) : 1;
    }
    return n;
  };
  return walk(FETCH_CACHE);
}

test.describe("junk-parameter flood", () => {
  test("adds no data-cache entry and never answers 500", async ({
    request,
  }) => {
    test.setTimeout(180_000);
    // Warm the clean pages (their entries may be created now).
    for (const path of [LGB_SUB_PATH, LGB_AREA_PATH, "/products"]) {
      expect((await request.get(path)).status()).toBe(200);
    }
    const before = cacheEntries();
    expect(before, "the data cache is on disk").toBeGreaterThan(0);

    const junk: string[] = [];
    for (let i = 0; i < 40; i++) {
      const r = `${i}${Math.random().toString(36).slice(2, 8)}`;
      junk.push(
        // Unknown keys, unknown values of known facets, bad numbers,
        // over-long lists, prototype keys, injection shapes.
        `${LGB_SUB_PATH}?utm_${r}=1&x${r}=${r}&cct=${1000 + i}&cri=${i % 100}.5`,
        `${LGB_SUB_PATH}?cct=${7000 + i}&cct=${7100 + i}&beam=${200 + i}&w=${r}&ip=${90 + (i % 9)}`,
        `${LGB_AREA_PATH}?cat=${r}&cat=no-such-${r}&ugr=${30 + (i % 10)}`,
        `/products?sort=${r}&page=${r}&__proto__[x]=1&constructor=${r}&cct[$ne]=1`,
        `/products?track=${10 + (i % 3)}&cct=${"9".repeat(40)}&page=-${i}`,
        `/search?q=${encodeURIComponent(`zz${r} junk`)}`,
      );
    }
    junk.push(
      `${LGB_SUB_PATH}?${Array.from({ length: 300 }, (_, i) => `cct=${2000 + i}`).join("&")}`,
      `${LGB_SUB_PATH}?${"a".repeat(4000)}=1`,
      `/products?cct=${encodeURIComponent('{"$gt":0}')}`,
      `/search?q=${"x".repeat(300)}`,
    );
    const statuses = new Map<number, number>();
    for (const path of junk) {
      const status = (await request.get(path)).status();
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      expect([200, 404], path).toContain(status);
    }
    // Pages past the end are 404 and never create an entry.
    for (let page = 2; page < 30; page++) {
      expect((await request.get(`${LGB_SUB_PATH}?page=${page}`)).status()).toBe(
        404,
      );
    }
    const after = cacheEntries();
    console.log(
      `[gate B flood] ${junk.length + 28} requests, statuses ${JSON.stringify([...statuses])}, data-cache entries ${before} -> ${after}`,
    );
    expect(after - before).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Sitemap
// ---------------------------------------------------------------------------

test("sitemap: path-only catalog URLs, no draft-only category, no value", async ({
  request,
}) => {
  const response = await request.get("/sitemap.xml");
  expect(response.status()).toBe(200);
  const xml = await response.text();
  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1] ?? "");
  const paths = locs.map((loc) => new URL(loc).pathname + new URL(loc).search);
  expect(paths.filter((p) => p.includes("?"))).toEqual([]);
  for (const path of [
    LGB_MAIN_PATH,
    LGB_SUB_PATH,
    LGB_AREA_PATH,
    P1_PATH,
    P2_PATH,
    "/products",
    "/areas",
    "/",
  ]) {
    expect(paths, path).toContain(path);
  }
  expect(paths).not.toContain(LGB_DRAFTCAT_PATH);
  expect(new Set(paths).size).toBe(paths.length);
  expect(found(xml)).toEqual([]);
  expect(response.headers()["set-cookie"]).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 7. Keyboard and axe at 360 / 1280
// ---------------------------------------------------------------------------

test.describe("a11y: menus and overlay on listing and area pages", () => {
  test("L-2: a mega-menu link to the page already shown closes the menu", async ({
    page,
  }) => {
    // The panel closes on any link click; only a touch first tap that
    // reveals a category (explicit flag from CategoryGrid) keeps it open.
    await page.setViewportSize({ width: 1280, height: 900 });
    await serveImages(page);
    await page.goto(LGB_SUB_PATH);
    await waitForHydration(menuButton(page));
    await menuButton(page).click();
    await megaPanel(page)
      .getByRole("link", { name: LGB.main.name, exact: true })
      .focus();
    await megaPanel(page)
      .getByRole("link", { name: LGB.sub.name, exact: true })
      .click();
    await expect(megaPanel(page)).toBeHidden({ timeout: 2000 });
  });

  // Main category page: the keyboard walk ends on another page.
  for (const path of [LGB_MAIN_PATH, LGB_AREA_PATH]) {
    test(`1280: keyboard-only mega-menu → sub-category; axe with menu and overlay open (${path})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await serveImages(page);
      await page.goto(path);
      await waitForHydration(menuButton(page));
      expect(await axeViolations(page), "page").toEqual([]);

      // Keyboard only: Tab from the skip link to the menu button.
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("link", { name: "Skip to content" }),
      ).toBeFocused();
      let reached = false;
      for (let i = 0; i < 6 && !reached; i++) {
        await page.keyboard.press("Tab");
        reached = await menuButton(page).evaluate(
          (el) => el === document.activeElement,
        );
      }
      expect(reached, "Tab reaches the Product button").toBe(true);
      await page.keyboard.press("Enter");
      await expect(megaPanel(page)).toBeVisible();
      expect(await axeViolations(page), "mega-menu open").toEqual([]);
      // Walk to our main category with Tab and open its sub-category.
      const main = megaPanel(page).getByRole("link", {
        name: LGB.main.name,
        exact: true,
      });
      let onMain = false;
      for (let i = 0; i < 60 && !onMain; i++) {
        await page.keyboard.press("Tab");
        onMain = await main.evaluate((el) => el === document.activeElement);
      }
      expect(onMain, "Tab reaches the category").toBe(true);
      const sub = megaPanel(page).getByRole("link", {
        name: LGB.sub.name,
        exact: true,
      });
      let onSub = false;
      for (let i = 0; i < 5 && !onSub; i++) {
        await page.keyboard.press("Tab");
        onSub = await sub.evaluate((el) => el === document.activeElement);
      }
      expect(onSub, "Tab reaches the sub-category").toBe(true);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`${LGB_SUB_PATH}$`));
      await expect(megaPanel(page)).toBeHidden();

      // Overlay with answers: focus stays inside the modal dialog on Tab.
      await waitForHydration(searchTrigger(page));
      await searchTrigger(page).focus();
      await page.keyboard.press("Enter");
      const input = overlay(page).getByRole("combobox");
      await expect(input).toBeFocused();
      const answered = page.waitForResponse((r) =>
        r.url().includes("/api/catalog/search?q="),
      );
      await page.keyboard.type("gatelist");
      await answered;
      await expect(overlay(page).getByRole("option").first()).toBeVisible();
      expect(await axeViolations(page), "overlay open").toEqual([]);
      // The page behind the modal <dialog> is inert: Tab cycles through the
      // dialog's controls and the browser UI (activeElement = body), never
      // the header or listing behind it.
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press("Tab");
        expect(
          await overlay(page).evaluate(
            (el) =>
              el.contains(document.activeElement) ||
              document.activeElement === document.body,
          ),
          `Tab ${i + 1} never reaches the page behind`,
        ).toBe(true);
      }
      // Back into the input for Escape.
      await overlay(page).getByRole("combobox").focus();
      await page.keyboard.press("Escape");
      await expect(searchTrigger(page)).toBeFocused();
    });

    test(`360: small-screen menu nested open and overlay, axe clean (${path})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 360, height: 800 });
      await serveImages(page);
      await page.goto(path);
      const toggle = page.locator("summary[aria-label=Menu]");
      await waitForHydration(toggle);
      expect(await axeViolations(page), "page").toEqual([]);
      expect(await horizontalOverflow(page)).toBe(0);
      await toggle.focus();
      await page.keyboard.press("Enter");
      const nav = page.locator('[data-slot="mobile-nav"]');
      await expect(nav).toBeVisible();
      const products = nav.locator('[data-slot="mobile-products"] > summary');
      await products.focus();
      await page.keyboard.press("Enter");
      const group = nav.locator("details summary", { hasText: LGB.main.name });
      await group.focus();
      await page.keyboard.press("Enter");
      const subLink = nav.getByRole("link", {
        name: LGB.sub.name,
        exact: true,
      });
      await expect(subLink).toBeVisible();
      await expect(nav).not.toContainText(LGB.draftCat.name);
      expect(await axeViolations(page), "menu open").toEqual([]);
      expect(await horizontalOverflow(page)).toBe(0);
      await page.keyboard.press("Escape");
      await expect(nav).toBeHidden();

      await waitForHydration(searchTrigger(page));
      await searchTrigger(page).click();
      const input = overlay(page).getByRole("combobox");
      const answered = page.waitForResponse((r) =>
        r.url().includes("/api/catalog/search?q="),
      );
      await input.fill("gatelist");
      await answered;
      await expect(overlay(page).getByRole("option").first()).toBeVisible();
      expect(await axeViolations(page), "overlay open").toEqual([]);
      expect(await horizontalOverflow(page)).toBe(0);
    });
  }
});
