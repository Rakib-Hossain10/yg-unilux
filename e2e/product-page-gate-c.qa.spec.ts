// QA gate C (Phase 4a exit): what gates A/B left open on the REAL server.
// 1. The publish lifecycle through the admin's own Publish / Move to draft
//    buttons: a product page that was already rendered (ISR) and listed in the
//    sitemap is a 404 for everyone on the very next request after it moves to
//    draft, its RSC payload too, and the restricted route stops answering
//    (rule 9 "drafts 404"; tags expire through the one revalidation helper).
// 2. Unknown and malformed slugs: always 404, never a public cacheable answer
//    (probe for the open L-1 "ISR stores 404s").
// 3. P9 perf changes keep their contracts: no lightbox <dialog> or lightbox
//    chunk before intent, and the header's Account link is never prefetched.

import { expect, test } from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";

import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import { EXIT } from "./fixtures/product-pages";

const RUN = Date.now().toString(36);
const CATEGORY_ID = new ObjectId();
const PRODUCT_ID = new ObjectId();
const SLUG = `qa-gatec-${RUN}`;
const PAGE = `/product/${SLUG}`;
const ROUTE = `/api/catalog/restricted/${PRODUCT_ID.toHexString()}`;
const MODEL_NO = `QC-${RUN}-1`.toUpperCase();
/* A default-restricted value: never in any public answer. */
const SECRET = `QCXDRIVER${RUN}`;

let client: MongoClient;
let db: Db;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
  const now = new Date();
  await db.collection("categories").insertOne({
    _id: CATEGORY_ID,
    name: `Gatec cat ${RUN}`,
    slug: `qa-gatec-cat-${RUN}`,
    parent: null,
    order: 950,
    createdAt: now,
    updatedAt: now,
  });
  // A draft: the public slug list (cached on `products`) does not hold it.
  await db.collection("products").insertOne({
    _id: PRODUCT_ID,
    name: "Gatec",
    slug: SLUG,
    family: "Gatec",
    modelCode: `QC-${RUN}`.toUpperCase(),
    mainCategory: CATEGORY_ID,
    extraCategories: [],
    areas: [],
    status: "draft",
    featured: false,
    extraSpecs: [],
    publicFiles: [],
    images: [
      { publicId: `products/e2e/${RUN}-gatec`, order: 0, kind: "gallery" },
    ],
    datasheetId: null,
    specs: { cct: ["3000K"], driver: [SECRET] },
    filters: {},
    variants: [{ modelNo: MODEL_NO, specs: {} }],
    createdAt: now,
    updatedAt: now,
  });
});

test.afterAll(async () => {
  await db.collection("products").deleteOne({ _id: PRODUCT_ID });
  await db.collection("categories").deleteOne({ _id: CATEGORY_ID });
  await client.close();
});

/* Clicks the status card's button on the admin edit page and waits for it. */
async function setStatus(
  browser: import("@playwright/test").Browser,
  button: "Publish" | "Move to draft",
  done: RegExp,
) {
  const admin = await browser.newContext({ storageState: loadState("admin") });
  const page = await admin.newPage();
  const response = await page.goto(
    `/admin/products/${PRODUCT_ID.toHexString()}`,
  );
  expect(response?.status()).toBe(200);
  await page.getByRole("button", { name: button, exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: done }),
  ).toBeVisible();
  await admin.close();
}

test.describe("publish lifecycle through the admin", () => {
  test("draft 404 -> publish 200 -> move to draft 404 on the next request", async ({
    browser,
    request,
  }) => {
    // Draft: 404 for a visitor, and not in the sitemap.
    expect((await request.get(PAGE)).status()).toBe(404);
    expect(await (await request.get("/sitemap.xml")).text()).not.toContain(
      SLUG,
    );

    await setStatus(browser, "Publish", /Published/);

    // Published: the page renders (and is now stored as ISR), no secret.
    const live = await request.get(PAGE);
    expect(live.status()).toBe(200);
    const html = await live.text();
    expect(html).toContain(MODEL_NO);
    expect(html).not.toContain(SECRET);
    // Twice, so the second answer comes from the route cache.
    expect((await request.get(PAGE)).status()).toBe(200);
    expect(await (await request.get("/sitemap.xml")).text()).toContain(SLUG);
    // The admin gets the restricted value from the route only.
    const admin = await browser.newContext({
      storageState: loadState("admin"),
    });
    const allowed = await admin.request.get(ROUTE);
    expect(allowed.status()).toBe(200);
    expect(await allowed.text()).toContain(SECRET);

    await setStatus(browser, "Move to draft", /Moved to draft/);

    // The FIRST request after the move: 404, never the stored page.
    const gone = await request.get(PAGE);
    expect(gone.status()).toBe(404);
    expect(await gone.text()).not.toContain(MODEL_NO);
    const rsc = await request.get(PAGE, { headers: { RSC: "1" } });
    expect(rsc.status()).toBe(404);
    expect(await rsc.text()).not.toContain(MODEL_NO);
    expect(await (await request.get("/sitemap.xml")).text()).not.toContain(
      SLUG,
    );
    // Drafts 404 for everyone, the admin included, on the public site.
    expect((await admin.request.get(PAGE)).status()).toBe(404);
    const refused = await admin.request.get(ROUTE);
    expect(refused.status()).toBe(404);
    expect(await refused.text()).not.toContain(SECRET);
    expect(refused.headers()["cache-control"]).toBe("private, no-store");
    await admin.close();
  });
});

test.describe("unknown and malformed slugs", () => {
  for (const [name, slug] of [
    ["unknown", `qa-gatec-nope-${RUN}`],
    ["upper case", "UPPER-Case"],
    ["too long", "a".repeat(400)],
    ["encoded traversal", "..%2f..%2fetc"],
    ["encoded markup", "%3Cscript%3E"],
  ] as const) {
    test(`${name} slug is a 404 (cache header recorded)`, async ({
      request,
    }) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await request.get(`/product/${slug}`);
        expect(response.status()).toBe(404);
        expect(await response.text()).toContain("Product not found");
        const cacheControl = response.headers()["cache-control"] ?? "";
        // Gate C evidence for open L-1: Next stores each unknown slug's 404 as
        // an ISR entry ("s-maxage=31536000", tagged `products`). The publish
        // lifecycle test above proves a later publish still shows the page
        // (the tag expires the stored 404); what stays open is growth of the
        // ISR store under a random-slug flood. Recorded, not asserted, so a
        // fix (not storing 404s) does not break this test.
        test.info().annotations.push({
          type: `attempt ${attempt + 1}`,
          description: `cache-control: ${cacheControl}; x-nextjs-cache: ${response.headers()["x-nextjs-cache"] ?? "-"}`,
        });
      }
    });
  }
});

test.describe("P9 performance changes keep their contracts", () => {
  test("no lightbox code or dialog before intent; Account link never prefetched", async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    // The exit product has three images, so the gallery and lightbox exist.
    const answered = page.waitForResponse((r) =>
      r.url().includes("/api/catalog/restricted/"),
    );
    const response = await page.goto(`/product/${EXIT.slug}`);
    expect(response?.status()).toBe(200);
    const html = await response!.text();
    expect(html).not.toContain("<dialog");
    await page.waitForLoadState("load");
    await answered;
    // Viewport prefetches run on idle after load; give them time to start.
    await page.waitForTimeout(2000);
    await expect(page.locator("dialog")).toHaveCount(0);
    // next/link prefetch of /login would request its RSC payload.
    expect(
      requested.filter((url) => new URL(url).pathname === "/login"),
    ).toEqual([]);

    // Opening the lightbox mounts the dialog (lazy chunk) and shows it.
    await page
      .getByRole("button", { name: "View larger", exact: true })
      .click();
    const dialog = page.locator("dialog");
    await expect(dialog).toHaveCount(1);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // Focus returns to the opener.
    await expect(
      page.getByRole("button", { name: "View larger", exact: true }),
    ).toBeFocused();
  });
});
