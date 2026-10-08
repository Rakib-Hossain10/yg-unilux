// QA gate B (Phase 4a, P4-P7): the restricted-data leak test on the REAL
// product page served by `next start`, with a product whose every
// default-restricted column is filled (fixtures/product-pages.ts GATE_B,
// seeded before the server starts). Checked as a visitor, as an expired,
// banned and temporary-password customer: page source, RSC payload (direct
// and through a client navigation), every response the browser loads
// (scripts included), JSON-LD, <meta>, the sitemap, the family and related
// strips. Then the admin toggles columns restricted <-> public through the
// real settings screen and the static page follows at once (tags expire).
// Then the route matrix of /api/catalog/restricted/[productId] and axe on the
// product page at 360 and 1280 px.

import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";

import { E2E_CUSTOMER } from "./fixtures/accounts";
import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import {
  axeViolations,
  horizontalOverflow,
} from "./fixtures/product-page-helpers";
import {
  GATE_B,
  GATE_B_RESTRICTED_TOKENS,
  GATE_B_STRIP_TOKENS,
} from "./fixtures/product-pages";

const PAGE = `/product/${GATE_B.slug}`;
const SIBLING = `/product/${GATE_B.siblingSlug}`;
const ROUTE = `/api/catalog/restricted/${GATE_B.productId}`;
/** Every restricted value the gate B fixtures hold (product, variants, cards). */
const ALL_TOKENS = [...GATE_B_RESTRICTED_TOKENS, ...GATE_B_STRIP_TOKENS];

let client: MongoClient;
let db: Db;
let savedCustomer: Record<string, unknown> | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
  savedCustomer = await db.collection("users").findOne(
    { email: E2E_CUSTOMER.email },
    {
      projection: {
        mustChangePassword: 1,
        accessExpiresAt: 1,
        banned: 1,
        banExpires: 1,
      },
    },
  );
});

test.afterAll(async () => {
  if (savedCustomer) {
    await db.collection("users").updateOne(
      { email: E2E_CUSTOMER.email },
      {
        $set: {
          mustChangePassword: savedCustomer.mustChangePassword ?? true,
          accessExpiresAt: savedCustomer.accessExpiresAt ?? null,
          banned: savedCustomer.banned ?? false,
          banExpires: savedCustomer.banExpires ?? null,
        },
      },
    );
  }
  await client.close();
});

/* The seeded customer in one of the refused or allowed states. */
async function setCustomer(fields: {
  mustChangePassword?: boolean;
  accessExpiresAt?: Date | null;
  banned?: boolean;
}) {
  await db.collection("users").updateOne(
    { email: E2E_CUSTOMER.email },
    {
      $set: {
        mustChangePassword: false,
        accessExpiresAt: null,
        banned: false,
        banExpires: null,
        ...fields,
      },
    },
  );
}
const expiredCustomer = () =>
  setCustomer({ accessExpiresAt: new Date(Date.now() - 86_400_000) });

/** Every token of `tokens` found in `text`. */
const found = (text: string, tokens: readonly string[] = ALL_TOKENS) =>
  tokens.filter((token) => text.includes(token));

/* The JSON-LD object of a page's HTML. */
function jsonLdOf(html: string): Record<string, unknown> {
  const match =
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error("no JSON-LD in the page");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

/* Every <meta> and <link rel=canonical> tag of the head. */
function headTags(html: string): string {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";
  return (
    head.match(/<(meta|link|title)\b[^>]*>(?:[^<]*<\/title>)?/g) ?? []
  ).join("\n");
}

/* The page as the server sends it: HTML, then the RSC payload of the route. */
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
    headers: html.headers(),
    rsc: await rsc.text(),
    prefetch: await prefetch.text(),
  };
}

/*
 * Opens `path` in a browser and records the body of EVERY text response the
 * page loads (HTML, scripts, RSC, JSON, CSS): the client bundles included.
 * Waits for the restricted route's answer, so the block has settled.
 */
async function browse(context: BrowserContext, path: string) {
  const page = await context.newPage();
  const bodies: { url: string; body: string }[] = [];
  page.on("response", async (response) => {
    const type = response.headers()["content-type"] ?? "";
    if (!/text|javascript|json|x-component|xml/.test(type)) return;
    try {
      bodies.push({ url: response.url(), body: await response.text() });
    } catch {
      // A redirect or an aborted request has no body.
    }
  });
  const answered = page.waitForResponse((response) =>
    response.url().includes("/api/catalog/restricted/"),
  );
  await page.goto(path);
  const route = await answered;
  await page.waitForLoadState("load");
  return { page, bodies, route };
}

const leaksIn = (bodies: { url: string; body: string }[]) =>
  bodies.flatMap(({ url, body }) =>
    found(body).map((token) => `${token} in ${url}`),
  );

// ---------------------------------------------------------------------------
// Leak test: visitor
// ---------------------------------------------------------------------------

test.describe("a visitor", () => {
  test("gets no restricted value in the HTML, RSC payload or prefetch", async ({
    request,
  }) => {
    const answers = await serverAnswers(request, PAGE);
    // The grep works: public values and the model nos. ARE there.
    expect(answers.html).toContain(GATE_B.publicValues.housingFinish);
    expect(answers.html).toContain(GATE_B.v1);
    expect(answers.rsc).toContain(GATE_B.publicValues.housingFinish);
    expect(found(answers.html)).toEqual([]);
    expect(found(answers.rsc)).toEqual([]);
    expect(found(answers.prefetch)).toEqual([]);
    // No datasheet id, storage key or URL of the private file.
    for (const text of [answers.html, answers.rsc]) {
      expect(text).not.toMatch(/datasheetId|storageKey|r2\.|X-Amz-/i);
    }
    // The static page is shared, so it must carry nothing per viewer.
    expect(answers.headers["set-cookie"]).toBeUndefined();
  });

  test("JSON-LD and <meta> hold no restricted value and no spec value", async ({
    request,
  }) => {
    const html = await (await request.get(PAGE)).text();
    const ld = jsonLdOf(html);
    expect(ld["@type"]).toBe("ProductGroup");
    expect(ld.hasVariant).toHaveLength(2);
    expect(JSON.stringify(ld)).not.toMatch(/price|offers/i);
    expect(found(JSON.stringify(ld))).toEqual([]);
    const head = headTags(html);
    expect(head).toContain('name="description"');
    expect(head).toContain('property="og:title"');
    expect(head).toContain(`rel="canonical"`);
    expect(found(head)).toEqual([]);
  });

  test("the sitemap lists published pages only, with no spec value", async ({
    request,
  }) => {
    const draftSlug = `qa-gateb-draft-${Date.now().toString(36)}`;
    const draftId = new ObjectId();
    await db.collection("products").insertOne({
      _id: draftId,
      name: "Gateb draft",
      slug: draftSlug,
      status: "draft",
      mainCategory: GATE_B.categoryId,
      extraCategories: [],
      areas: [],
      images: [],
      specs: { chipType: [GATE_B.restricted.chipType] },
      variants: [{ modelNo: "GB-DRAFT-1", specs: {} }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    try {
      const response = await request.get("/sitemap.xml");
      expect(response.status()).toBe(200);
      const xml = await response.text();
      expect(xml).toContain(`/product/${GATE_B.slug}</loc>`);
      expect(xml).toContain(`/product/${GATE_B.siblingSlug}</loc>`);
      expect(xml).not.toContain(draftSlug);
      expect(found(xml)).toEqual([]);
      // A draft is a 404 for everyone.
      expect((await request.get(`/product/${draftSlug}`)).status()).toBe(404);
      expect(
        (
          await request.get(`/api/catalog/restricted/${draftId.toHexString()}`)
        ).status(),
      ).toBe(404);
    } finally {
      await db.collection("products").deleteOne({ _id: draftId });
    }
  });

  test("the family and related strips show cards and no spec value", async ({
    request,
  }) => {
    const html = await (await request.get(PAGE)).text();
    const family = /data-section="family"[\s\S]*?<\/section>/.exec(html)?.[0];
    const related = /data-section="related"[\s\S]*?<\/section>/.exec(html)?.[0];
    expect(family).toContain(`href="${SIBLING}"`);
    expect(related).toContain(`href="/product/${GATE_B.relatedSlug}"`);
    expect(found(family ?? "")).toEqual([]);
    expect(found(related ?? "")).toEqual([]);
    // The sibling and related pages themselves, HTML and RSC.
    for (const path of [SIBLING, `/product/${GATE_B.relatedSlug}`]) {
      const answers = await serverAnswers(request, path);
      expect(found(answers.html)).toEqual([]);
      expect(found(answers.rsc)).toEqual([]);
    }
  });

  test("no response the browser loads holds a value, also after a client navigation", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const { page, bodies, route } = await browse(context, SIBLING);
    // The sibling has no datasheet.
    expect(await route.json()).toEqual({
      allowed: false,
      state: "coming-soon",
      access: "signin",
    });
    // Client navigation through the family strip: a real RSC fetch.
    const navigated = page.waitForResponse((response) =>
      response.url().includes(ROUTE),
    );
    await page
      .locator('[data-section="family"]')
      .getByRole("link", { name: /Gateb/ })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
    await navigated;
    await expect(
      page.locator('[data-slot="datasheet"] [data-datasheet-state="signin"]'),
    ).toBeVisible();
    // Every recorded body: HTML, RSC, scripts, CSS, the route's answer.
    expect(bodies.some(({ body }) => body.includes(GATE_B.v1))).toBe(true);
    expect(leaksIn(bodies)).toEqual([]);
    expect(found(await page.content())).toEqual([]);
    await context.close();
  });
});

// ---------------------------------------------------------------------------
// Leak test: signed-in viewers who are refused
// ---------------------------------------------------------------------------

test.describe("a refused customer", () => {
  for (const [name, apply, state] of [
    ["expired", expiredCustomer, "expired"],
    ["banned", () => setCustomer({ banned: true }), "expired"],
    [
      "on a temporary password",
      () => setCustomer({ mustChangePassword: true }),
      "signin",
    ],
  ] as const) {
    test(`${name}: no value in the page, the RSC payload or any response`, async ({
      browser,
    }) => {
      await apply();
      const context = await browser.newContext({
        storageState: loadState("customer"),
      });
      const answers = await serverAnswers(context.request, PAGE);
      expect(found(answers.html)).toEqual([]);
      expect(found(answers.rsc)).toEqual([]);
      const { page, bodies, route } = await browse(context, PAGE);
      expect(route.headers()["cache-control"]).toBe("private, no-store");
      // The refused answer is the state and the coarse reason only: nothing
      // else is sent (the reason equals the state here: a datasheet exists).
      expect(await route.json()).toEqual({
        allowed: false,
        state,
        access: state,
      });
      await expect(
        page.locator(`[data-datasheet-state="${state}"]`),
      ).toBeVisible();
      expect(leaksIn(bodies)).toEqual([]);
      expect(found(await page.content())).toEqual([]);
      await context.close();
    });
  }

  test("an active customer gets the values from the route only, never in the page", async ({
    browser,
  }) => {
    await setCustomer({});
    const context = await browser.newContext({
      storageState: loadState("customer"),
    });
    // The page HTML/RSC is the same static answer for everyone.
    const answers = await serverAnswers(context.request, PAGE);
    expect(found(answers.html)).toEqual([]);
    expect(found(answers.rsc)).toEqual([]);
    const { page, bodies, route } = await browse(context, PAGE);
    const body = await route.text();
    expect(found(body, GATE_B_RESTRICTED_TOKENS).sort()).toEqual(
      [...GATE_B_RESTRICTED_TOKENS].sort(),
    );
    expect(body).not.toMatch(/datasheetId|storageKey|https?:/);
    // Outside the route's answer, no response holds a value.
    expect(leaksIn(bodies.filter(({ url }) => !url.includes(ROUTE)))).toEqual(
      [],
    );
    await expect(
      page.locator('[data-slot="restricted-specs"] tr[data-spec="chipType"]'),
    ).toContainText(GATE_B.restricted.chipType);
    // The card strips stay value-free for an allowed viewer too.
    for (const section of ["family", "related"]) {
      expect(
        found(
          (await page
            .locator(`[data-section="${section}"]`)
            .innerHTML()) as string,
        ),
      ).toEqual([]);
    }
    await context.close();
  });
});

// ---------------------------------------------------------------------------
// Column visibility: restricted <-> public through the admin screen
// ---------------------------------------------------------------------------

const restrictSwitch = (page: Page, header: string) =>
  page.getByRole("switch", { name: `Restrict ${header}`, exact: true });

/** Flips the named columns on /admin/settings and saves (the real action). */
async function toggleColumns(browser: Browser, headers: readonly string[]) {
  const context = await browser.newContext({
    storageState: loadState("admin"),
  });
  const page = await context.newPage();
  await page.goto("/admin/settings");
  for (const header of headers) await restrictSwitch(page, header).click();
  await page.getByRole("button", { name: "Save column settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await context.close();
}

/** The visitor's view after a change: HTML + RSC + JSON-LD + meta + sitemap. */
async function visitorText(request: APIRequestContext): Promise<string> {
  const answers = await serverAnswers(request, PAGE);
  const sitemap = await (await request.get("/sitemap.xml")).text();
  return [answers.html, answers.rsc, answers.prefetch, sitemap].join("\n");
}

test.describe("column visibility changes", () => {
  const MADE_RESTRICTED = ["Housing Color/Finish", "Lens"];
  const MADE_PUBLIC = ["Chip Type"];
  const nowRestricted = [
    GATE_B.publicValues.housingFinish,
    GATE_B.publicValues.lensV1,
    GATE_B.publicValues.lensV2,
    // Labels may hold optic values: hidden while Lens is restricted.
    GATE_B.labels.v1,
    GATE_B.labels.v2,
  ];
  let toggled = false;

  test.afterAll(async ({ browser }) => {
    // Put the setting back through the same screen, so the tags expire.
    if (toggled)
      await toggleColumns(browser, [...MADE_RESTRICTED, ...MADE_PUBLIC]);
  });

  test("the cached page follows at once, in both directions", async ({
    browser,
    request,
  }) => {
    await setCustomer({});
    // Warm every cache entry first (page, data, sitemap).
    const before = await visitorText(request);
    expect(found(before, nowRestricted).sort()).toEqual(
      [...nowRestricted].sort(),
    );
    expect(found(before, [GATE_B.restricted.chipType])).toEqual([]);

    toggled = true;
    await toggleColumns(browser, [...MADE_RESTRICTED, ...MADE_PUBLIC]);

    // The FIRST visitor request after the save: never a stale page.
    const after = await visitorText(request);
    expect(found(after, nowRestricted)).toEqual([]);
    expect(after).toContain(GATE_B.restricted.chipType);
    // Still restricted columns stay out.
    expect(
      found(
        after,
        GATE_B_RESTRICTED_TOKENS.filter(
          (token) => token !== GATE_B.restricted.chipType,
        ),
      ),
    ).toEqual([]);
    // The optic switch falls back to model nos.
    const html = await (await request.get(PAGE)).text();
    expect(html).toContain(GATE_B.v2);

    // A customer now gets the newly restricted values from the route.
    const customer = await browser.newContext({
      storageState: loadState("customer"),
    });
    const route = await (await customer.request.get(ROUTE)).text();
    expect(route).toContain(GATE_B.publicValues.housingFinish);
    expect(route).toContain(GATE_B.publicValues.lensV2);
    expect(route).not.toContain(GATE_B.restricted.chipType);
    await customer.close();

    // And back: the first request already shows the old split again.
    await toggleColumns(browser, [...MADE_RESTRICTED, ...MADE_PUBLIC]);
    toggled = false;
    const restored = await visitorText(request);
    expect(found(restored, nowRestricted).sort()).toEqual(
      [...nowRestricted].sort(),
    );
    expect(found(restored)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The restricted route's matrix
// ---------------------------------------------------------------------------

test.describe("GET /api/catalog/restricted/[productId]", () => {
  const NO_STORE = "private, no-store";

  test("visitor: refused with the state only; bad and unknown ids", async ({
    request,
  }) => {
    for (const [path, status] of [
      [ROUTE, 200],
      [`/api/catalog/restricted/${GATE_B.productId.toUpperCase()}`, 200],
      [`/api/catalog/restricted/${new ObjectId().toHexString()}`, 404],
      ["/api/catalog/restricted/not-an-id", 400],
      [`/api/catalog/restricted/${encodeURIComponent('{"$ne":null}')}`, 400],
      [`/api/catalog/restricted/${encodeURIComponent("[$ne]=1")}`, 400],
      [`/api/catalog/restricted/${"a".repeat(25)}`, 400],
      [`/api/catalog/restricted/${GATE_B.productId}%00`, 400],
    ] as const) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(status);
      expect(response.headers()["cache-control"], path).toBe(NO_STORE);
      const body = await response.text();
      expect(found(body), path).toEqual([]);
      expect(body, path).not.toMatch(/stack|mongo|cast|error:/i);
    }
    expect(await (await request.get(ROUTE)).json()).toEqual({
      allowed: false,
      state: "signin",
      access: "signin",
    });
  });

  test("only GET is answered", async ({ request }) => {
    for (const method of ["post", "put", "delete", "patch"] as const) {
      const response = await request[method](ROUTE, { data: {} });
      expect(response.status(), method).toBe(405);
      expect(found(await response.text())).toEqual([]);
    }
  });

  test("admin and active customer: allowed; a forged cookie is a visitor", async ({
    browser,
  }) => {
    await setCustomer({});
    for (const who of ["admin", "customer"] as const) {
      const context = await browser.newContext({
        storageState: loadState(who),
      });
      const response = await context.request.get(ROUTE);
      expect(response.status(), who).toBe(200);
      expect(response.headers()["cache-control"], who).toBe(NO_STORE);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.allowed, who).toBe(true);
      expect(body.state, who).toBe("download");
      expect(Object.keys(body).sort()).toEqual([
        "allowed",
        "keys",
        "specs",
        "state",
        "variants",
      ]);
      await context.close();
    }
    const forged = await browser.newContext();
    const cookies = loadState("customer").cookies.map((cookie) => ({
      ...cookie,
      value: `${cookie.value.slice(0, -4)}AAAA`,
    }));
    await forged.addCookies(cookies);
    expect(await (await forged.request.get(ROUTE)).json()).toEqual({
      allowed: false,
      state: "signin",
      access: "signin",
    });
    await forged.close();
  });
});

// ---------------------------------------------------------------------------
// Accessibility of the product page (visitor)
// ---------------------------------------------------------------------------

for (const width of [360, 1280]) {
  test(`the product page passes axe at ${width} px (visitor)`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
    });
    const { page } = await browse(context, PAGE);
    await expect(
      page.locator('[data-slot="datasheet"] [data-datasheet-state]'),
    ).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    // No horizontal scroll at this width.
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    await context.close();
  });
}
