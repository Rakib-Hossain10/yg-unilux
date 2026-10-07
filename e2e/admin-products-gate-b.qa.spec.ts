// QA gate B (Phase 2, T7-T10b): a Save clicked before hydration (simulated by
// switching JavaScript off) must not put field values in the URL; a customer's
// 403 for the edit page carries no restricted spec value in HTML or RSC; and
// the categories/areas not-found status (gate A L-1) is measured.
import { expect, test } from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";
import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";

const NETWORK = { "x-vercel-forwarded-for": "203.0.113.62" };
const RUN = Date.now().toString(36);
const SECRET = `RESTRICTED-DRIVER-${RUN}`;
const PRODUCT = `QA ${RUN} GateB`;

let client: MongoClient;
let db: Db;
let productId: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
  const now = new Date();
  const category = await db.collection("categories").insertOne({
    name: `QA GateB Cat ${RUN}`,
    slug: `qa-gateb-cat-${RUN}`,
    parent: null,
    order: 96,
    createdAt: now,
    updatedAt: now,
  });
  const product = await db.collection("products").insertOne({
    name: PRODUCT,
    slug: `qa-${RUN}-gateb`,
    mainCategory: category.insertedId,
    extraCategories: [],
    areas: [],
    status: "draft",
    featured: false,
    specs: { driver: [SECRET] },
    variants: [{ modelNo: `GB-${RUN}` }],
    extraSpecs: [],
    publicFiles: [],
    images: [],
    datasheetId: null,
    createdAt: now,
    updatedAt: now,
  });
  productId = product.insertedId.toHexString();
});

test.afterAll(async () => {
  await db.collection("products").deleteMany({ slug: `qa-${RUN}-gateb` });
  await db.collection("categories").deleteMany({ slug: `qa-gateb-cat-${RUN}` });
  await client.close();
});

test("a native (pre-hydration) submit of the edit form puts no values in the URL", async ({
  browser,
}) => {
  // The admin session comes from global setup (M-1); JS is off here.
  const context = await browser.newContext({
    storageState: loadState("admin"),
    javaScriptEnabled: false,
  });
  const page = await context.newPage();
  await page.goto(`/admin/products/${productId}`);
  // The admin sees the stored value (it is their data), server-rendered.
  await expect(page.locator("textarea, input").first()).toBeVisible();
  const names = await page
    .locator("form[aria-label='Product details'] [name]")
    .evaluateAll((nodes) =>
      nodes.map((n) => `${n.tagName}:${n.getAttribute("name")}`),
    );
  // Only non-text controls (ids from checkboxes/selects) may carry a name.
  expect(
    names.filter((n) => /^(INPUT|TEXTAREA):/.test(n) && !/checkbox/.test(n)),
  ).toEqual([]);
  await page.getByRole("button", { name: /^Save/ }).first().click();
  await page.waitForLoadState("domcontentloaded");
  const url = page.url();
  expect(decodeURIComponent(url)).not.toContain(SECRET);
  expect(decodeURIComponent(url)).not.toContain(PRODUCT);
  expect(decodeURIComponent(url)).not.toContain("driver");
  await context.close();
});

test("a customer's 403 for the edit page leaks no spec value (HTML and RSC)", async ({
  browser,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: NETWORK,
    storageState: loadState("customer"),
  });
  const page = await context.newPage();
  const path = `/admin/products/${productId}`;
  expect((await page.goto(path))?.status()).toBe(403);
  const html = await page.content();
  expect(html).not.toContain(SECRET);
  expect(html).not.toContain(PRODUCT);
  const rsc = await page.request.get(path, { headers: { RSC: "1" } });
  const body = await rsc.text();
  expect(body).not.toContain(SECRET);
  expect(body).not.toContain(PRODUCT);
  await context.close();
});

test("the admin edit page is no-store", async ({ browser }) => {
  const context = await browser.newContext({
    extraHTTPHeaders: NETWORK,
    storageState: loadState("admin"),
  });
  const page = await context.newPage();
  const response = await page.goto(`/admin/products/${productId}`);
  expect(response?.headers()["cache-control"] ?? "").toContain("no-store");
  await context.close();
});

test("gate A L-1: not-found status of categories/areas [id] (documented, measured)", async ({
  browser,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: NETWORK,
    storageState: loadState("admin"),
  });
  const page = await context.newPage();
  const missing = new ObjectId().toHexString();
  const statuses: Record<string, number | undefined> = {};
  for (const path of [
    `/admin/categories/${missing}`,
    `/admin/areas/${missing}`,
    `/admin/products/${missing}`,
  ]) {
    statuses[path] = (await page.goto(path))?.status();
  }
  console.log("[L-1] not-found statuses:", JSON.stringify(statuses));
  // Products must be a real 404 (ADR 0043); the other two are the open L-1.
  expect(statuses[`/admin/products/${missing}`]).toBe(404);
  await context.close();
});
