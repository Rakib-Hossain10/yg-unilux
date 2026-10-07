// QA gate E (Phase 2 exit): the whole-admin access matrix the plan's
// Verification asks for, run against the production build. Every admin URL:
// a visitor (no cookie, or a forged one) ends on /login, a signed-in customer
// gets a real 403 whose HTML and RSC payload carry none of the seeded data,
// and the admin's response is no-store with the admin-only CSP. Public pages
// keep the plain CSP. The datasheets page never shows a storage key, and the
// admin list/new pages pass axe. Seeds its own records in the throwaway
// database and removes them afterwards; never waits for networkidle.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Page, expect, test } from "@playwright/test";
import type { Db, MongoClient } from "mongodb";
import { ObjectId } from "mongodb";

import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import { E2E_PROVIDER_ENV } from "./fixtures/providers-port";

const RUN = `ge${Date.now().toString(36)}`;
const CATEGORY = `QA GateE Cat ${RUN}`;
const AREA = `QA GateE Area ${RUN}`;
const PRODUCT = `QA GateE Product ${RUN}`;
const MODEL_NO = `GE-${RUN}-A1`;
// A restricted (driver) value: must never reach a non-admin.
const SECRET = `qa-gate-e-driver-${RUN}`;
const SHEET = `qa-gate-e-${RUN}.xlsx`;
const STORAGE_KEY = "datasheets/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.xlsx";
// Each context its own bucket for the per-IP limiter.
const NETWORK = { "x-vercel-forwarded-for": "203.0.113.77" };

const axeSource = readFileSync(
  join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

let client: MongoClient;
let db: Db;
let productId = "";
let categoryId = "";
let areaId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
  const now = new Date();
  const admin = await db
    .collection("users")
    .findOne({ role: "admin" }, { projection: { _id: 1 } });
  const category = await db.collection("categories").insertOne({
    name: CATEGORY,
    slug: `qa-gatee-cat-${RUN}`,
    parent: null,
    order: 95,
    createdAt: now,
    updatedAt: now,
  });
  categoryId = category.insertedId.toHexString();
  const area = await db.collection("areas").insertOne({
    name: AREA,
    slug: `qa-gatee-area-${RUN}`,
    order: 795,
    createdAt: now,
    updatedAt: now,
  });
  areaId = area.insertedId.toHexString();
  const sheet = await db.collection("datasheets").insertOne({
    storageKey: STORAGE_KEY,
    fileName: SHEET,
    size: 1234,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    uploadedBy: admin?._id ?? new ObjectId(),
    createdAt: now,
    updatedAt: now,
  });
  const product = await db.collection("products").insertOne({
    name: PRODUCT,
    slug: `qa-gatee-${RUN}`,
    mainCategory: category.insertedId,
    extraCategories: [],
    areas: [area.insertedId],
    status: "draft",
    featured: false,
    specs: { driver: [SECRET] },
    variants: [{ modelNo: MODEL_NO }],
    extraSpecs: [],
    publicFiles: [],
    images: [],
    datasheetId: sheet.insertedId,
    createdAt: now,
    updatedAt: now,
  });
  productId = product.insertedId.toHexString();
});

test.afterAll(async () => {
  await db.collection("products").deleteMany({ slug: `qa-gatee-${RUN}` });
  await db.collection("categories").deleteMany({ name: CATEGORY });
  await db.collection("areas").deleteMany({ name: AREA });
  await db.collection("datasheets").deleteMany({ fileName: SHEET });
  await client.close();
});

/* Every admin page in Phase 2 (dynamic ones with the seeded ids). */
function adminUrls(): string[] {
  return [
    "/admin",
    "/admin/categories",
    "/admin/categories/new",
    `/admin/categories/${categoryId}`,
    "/admin/areas",
    "/admin/areas/new",
    `/admin/areas/${areaId}`,
    "/admin/products",
    "/admin/products/new",
    `/admin/products/${productId}`,
    "/admin/datasheets",
    "/admin/settings",
  ];
}

/* Strings that only an admin may ever receive. */
const SEEDED = () => [
  SECRET,
  PRODUCT,
  MODEL_NO,
  SHEET,
  CATEGORY,
  AREA,
  STORAGE_KEY,
];

function connectSrc(csp: string): string {
  return (
    csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("connect-src")) ?? ""
  );
}

test("a visitor without a session is sent to /login from every admin URL", async ({
  browser,
}) => {
  const context = await browser.newContext({ extraHTTPHeaders: NETWORK });
  const page = await context.newPage();
  for (const url of adminUrls()) {
    await page.goto(url);
    await expect(page, url).toHaveURL(/\/login(\?|$)/);
    const html = await page.content();
    for (const value of SEEDED()) expect(html, url).not.toContain(value);
  }
  await context.close();
});

test("a forged session cookie is no better than none", async ({ browser }) => {
  const customer = loadState("customer");
  const cookie = customer.cookies.find((c) => c.name.endsWith("session_token"));
  expect(cookie).toBeDefined();
  const context = await browser.newContext({ extraHTTPHeaders: NETWORK });
  await context.addCookies([
    { ...cookie!, value: "forged.not-a-real-session-token" },
  ]);
  const page = await context.newPage();
  for (const url of adminUrls()) {
    const response = await page.goto(url);
    await expect(page, url).toHaveURL(/\/login(\?|$)/);
    expect(response?.status(), url).toBeLessThan(400);
    const html = await page.content();
    for (const value of SEEDED()) expect(html, url).not.toContain(value);
  }
  await context.close();
});

test("a signed-in customer gets a real 403 on every admin URL, HTML and RSC carry no admin data", async ({
  browser,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: NETWORK,
    storageState: loadState("customer"),
  });
  const page = await context.newPage();
  for (const url of adminUrls()) {
    const response = await page.goto(url);
    expect(response?.status(), url).toBe(403);
    const html = await page.content();
    expect(html, url).not.toContain("Sign out");
    for (const value of SEEDED()) expect(html, url).not.toContain(value);

    const rsc = await page.request.get(url, { headers: { RSC: "1" } });
    const body = await rsc.text();
    for (const value of SEEDED())
      expect(body, `${url} (RSC)`).not.toContain(value);
  }
  await context.close();
});

test("admin responses are no-store and carry exactly the two upload hosts in connect-src", async ({
  browser,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: NETWORK,
    storageState: loadState("admin"),
  });
  const page = await context.newPage();
  const expected = `connect-src 'self' https://api.cloudinary.com https://${E2E_PROVIDER_ENV.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  for (const url of adminUrls()) {
    const response = await page.goto(url);
    expect(response?.status(), url).toBe(200);
    const headers = response!.headers();
    expect(headers["cache-control"] ?? "", url).toContain("no-store");
    expect(headers["cache-control"] ?? "", url).not.toContain("public");
    expect(connectSrc(headers["content-security-policy"] ?? ""), url).toBe(
      expected,
    );
    expect(headers["x-frame-options"], url).toBe("DENY");
  }
  await context.close();
});

test("public pages keep connect-src 'self' only", async ({ request }) => {
  for (const url of ["/", "/login", "/blocked"]) {
    const response = await request.get(url, { headers: NETWORK });
    expect(
      connectSrc(response.headers()["content-security-policy"] ?? ""),
      url,
    ).toBe("connect-src 'self'");
  }
});

test("the admin datasheets page and product page never show a storage key or an R2 URL", async ({
  browser,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: NETWORK,
    storageState: loadState("admin"),
  });
  const page = await context.newPage();
  for (const url of ["/admin/datasheets", `/admin/products/${productId}`]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    const html = await page.content();
    // The admin does see the file NAME (a table cell, or a picker option).
    expect(html, url).toContain(SHEET);
    const rsc = await (
      await page.request.get(url, { headers: { RSC: "1" } })
    ).text();
    for (const body of [html, rsc]) {
      expect(body, url).not.toContain(STORAGE_KEY);
      expect(body, url).not.toMatch(/datasheets\/[0-9a-f-]{36}\.xlsx/);
      expect(body, url).not.toContain("r2.cloudflarestorage.com");
      expect(body, url).not.toContain("X-Amz-Signature");
    }
  }
  await context.close();
});

/* Runs axe (WCAG 2.2 AA) and returns the violation ids with counts. */
async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const result = await window.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    return (result.violations as { id: string; nodes: unknown[] }[]).map(
      (v) => `${v.id} (${v.nodes.length})`,
    );
  });
}

test("every admin page passes axe (WCAG 2.2 AA)", async ({ browser }) => {
  const context = await browser.newContext({
    extraHTTPHeaders: NETWORK,
    storageState: loadState("admin"),
  });
  const page = await context.newPage();
  for (const url of adminUrls()) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    expect(await axeViolations(page), url).toEqual([]);
  }
  await context.close();
});

test("the admin skip link takes the keyboard past the nav into the main content", async ({
  browser,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: NETWORK,
    storageState: loadState("admin"),
  });
  const page = await context.newPage();
  await page.goto("/admin/products");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: /skip to/i });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  // <main> is not focusable itself; the browser moves the focus starting
  // point, so the NEXT Tab must land inside main, not in the sidebar nav.
  await page.keyboard.press("Tab");
  const focusedInMain = await page.evaluate(() => {
    const main = document.querySelector("main");
    return (
      main !== null &&
      (main === document.activeElement || main.contains(document.activeElement))
    );
  });
  expect(focusedInMain).toBe(true);
  await context.close();
});
