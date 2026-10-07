// QA gate A (Phase 2, T1-T6) plus T9/T10a: the categories, areas and products admin
// modules end to end on the production build. create -> move -> delete
// blocked -> delete, the guard on every new URL and on a replayed Server
// Action, CSRF, notice allow-listing, no-store headers, focus and axe.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  expect,
  test,
} from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";

import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";

const axeSource = readFileSync(
  join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

/*
 * Sign-in is limited per (email + network) and other specs sign these
 * accounts in too. A documentation-range address in the one header the
 * limiter reads gives this file its own bucket, so it can't be the 6th try.
 */

/* Unique per run, so a retry never trips over an earlier run's rows. */
const RUN = Date.now().toString(36);
const SPOT = `QA Spot ${RUN}`;
const TRACK = `QA Track ${RUN}`;
const RECESSED = `QA Recessed ${RUN}`;
const RETAIL = `QA Retail ${RUN}`;
const OFFICE = `QA Office ${RUN}`;

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
let adminState: StorageState;
let customerState: StorageState;
let client: MongoClient;
let db: Db;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
  adminState = loadState("admin");
  customerState = loadState("customer");
});

test.afterAll(async () => {
  // Leave nothing behind for other specs (e.g. dashboard counts).
  await db
    .collection("products")
    .deleteMany({ slug: { $regex: `^qa-${RUN}` } });
  await db.collection("categories").deleteMany({ name: { $regex: `${RUN}$` } });
  await db.collection("areas").deleteMany({ name: { $regex: `${RUN}$` } });
  await client.close();
});

async function asAdmin(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: adminState });
  return context.newPage();
}

/* Runs axe (WCAG 2.2 AA) on the page and returns the violation ids. */
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

/* The id at the end of a row's Edit link (/admin/<module>/<id>). */
async function idFromEditLink(link: Locator): Promise<string> {
  const href = await link.getAttribute("href");
  const id = href?.split("/").pop() ?? "";
  expect(id).toMatch(/^[0-9a-f]{24}$/);
  return id;
}

async function createCategory(page: Page, name: string, parent?: string) {
  await page.goto("/admin/categories/new");
  await page.getByLabel("Name").fill(name);
  if (parent) {
    await page.getByLabel("Parent category").click();
    await page.getByRole("option", { name: parent }).click();
  }
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page).toHaveURL(/\/admin\/categories\?notice=created$/);
  await expect(
    page.getByRole("status").filter({ hasText: "Category created." }),
  ).toBeVisible();
}

async function createArea(page: Page, name: string) {
  await page.goto("/admin/areas/new");
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create area" }).click();
  await expect(page).toHaveURL(/\/admin\/areas\?notice=created$/);
  await expect(
    page.getByRole("status").filter({ hasText: "Area created." }),
  ).toBeVisible();
}

/* Opens a row's delete dialog and confirms. */
async function confirmDelete(page: Page, name: string) {
  await page
    .getByRole("button", { name: `Delete ${name}`, exact: true })
    .click();
  const dialog = page.getByRole("alertdialog", { name: `Delete ${name}?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

test.describe("categories", () => {
  let spotId: string;
  let trackId: string;
  let recessedId: string;

  test("create two main categories and a subcategory", async ({ browser }) => {
    const page = await asAdmin(browser);
    await createCategory(page, SPOT);
    await createCategory(page, TRACK);

    // "Add subcategory" presets the parent picker to that main category.
    await page
      .getByRole("link", { name: `Add subcategory to ${SPOT}`, exact: true })
      .click();
    await expect(page).toHaveURL(
      /\/admin\/categories\/new\?parent=[0-9a-f]{24}$/,
    );
    await expect(page.getByLabel("Parent category")).toHaveText(SPOT);
    await page.getByLabel("Name").fill(RECESSED);
    await page.getByRole("button", { name: "Create category" }).click();
    await expect(page).toHaveURL(/notice=created$/);

    const tree = page.getByRole("list", { name: "Categories", exact: true });
    spotId = await idFromEditLink(
      tree.getByRole("link", { name: `Edit ${SPOT}`, exact: true }),
    );
    trackId = await idFromEditLink(
      tree.getByRole("link", { name: `Edit ${TRACK}`, exact: true }),
    );
    recessedId = await idFromEditLink(
      tree.getByRole("link", { name: `Edit ${RECESSED}`, exact: true }),
    );
    await expect(
      page.getByRole("list", { name: `Subcategories of ${SPOT}` }),
    ).toContainText(RECESSED);
    // The slug came from the name.
    await expect(tree).toContainText(`/qa-spot-${RUN}`);

    const sub = await db
      .collection("categories")
      .findOne({ _id: new ObjectId(recessedId) });
    expect(String(sub?.parent)).toBe(spotId);
    const audit = await db.collection("auditLog").countDocuments({
      action: "category.create",
      "target.id": { $in: [spotId, trackId, recessedId] },
    });
    expect(audit).toBe(3);
    await page.context().close();
  });

  test("a crafted or repeated ?notice= shows nothing", async ({ browser }) => {
    const page = await asAdmin(browser);
    for (const query of [
      "?notice=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
      "?notice=created&notice=deleted",
      "?notice=Created",
    ]) {
      await page.goto(`/admin/categories${query}`);
      await expect(
        page.getByRole("heading", { level: 1, name: "Categories" }),
      ).toBeVisible();
      await expect(page.getByText("Category created.")).toHaveCount(0);
      await expect(page.getByText("Category deleted.")).toHaveCount(0);
      // Next echoes the URL inside its flight data as escaped JSON; what
      // must never happen is the value becoming markup.
      await expect(page.locator('img[src="x"]')).toHaveCount(0);
      expect(await page.content()).not.toMatch(/<img[^>]*onerror/i);
    }
    await page.context().close();
  });

  test("move up keeps focus, announces the move and disables the edge", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/categories");
    const tree = page.getByRole("list", { name: "Categories", exact: true });
    const names = async () =>
      (await tree.locator(":scope > li").allInnerTexts())
        .map((t) =>
          t.includes(SPOT) ? SPOT : t.includes(TRACK) ? TRACK : "other",
        )
        .filter((n) => n !== "other");
    expect(await names()).toEqual([SPOT, TRACK]);

    const up = page.getByRole("button", { name: `Move ${TRACK} up` });
    await up.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("status").filter({ hasText: `${TRACK} moved up.` }),
    ).toBeAttached();
    await expect.poll(names).toEqual([TRACK, SPOT]);
    // aria-disabled (not disabled), so keyboard focus survives the move.
    await expect(up).toBeFocused();
    await expect(up).toHaveAttribute("aria-disabled", "true");

    // Pressing an aria-disabled edge button does nothing.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    expect(await names()).toEqual([TRACK, SPOT]);

    const rows = await db
      .collection("categories")
      .find({
        parent: null,
        _id: { $in: [new ObjectId(spotId), new ObjectId(trackId)] },
      })
      .sort({ order: 1 })
      .toArray();
    expect(rows.map((r) => String(r._id))).toEqual([trackId, spotId]);
    await page.context().close();
  });

  test("delete is blocked by subcategories (dialog) and by products (server)", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/categories");

    // A main category with a subcategory: the dialog offers only Close.
    const trigger = page.getByRole("button", {
      name: `Delete ${SPOT}`,
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("alertdialog", { name: `Delete ${SPOT}?` });
    await expect(dialog).toContainText("1 subcategory");
    await expect(
      dialog.getByRole("button", { name: "Delete", exact: true }),
    ).toHaveCount(0);
    // Escape closes it and focus returns to the trigger.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    // A product using the subcategory: the server refuses the delete.
    await db.collection("products").insertOne({
      name: "QA product",
      slug: `qa-${RUN}-cat`,
      status: "draft",
      mainCategory: new ObjectId(recessedId),
      extraCategories: [],
      areas: [],
    });
    await confirmDelete(page, RECESSED);
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "That did not work" });
    await expect(alert).toContainText("1 product uses it");
    expect(
      await db
        .collection("categories")
        .countDocuments({ _id: new ObjectId(recessedId) }),
    ).toBe(1);
    await db.collection("products").deleteOne({ slug: `qa-${RUN}-cat` });
    await page.context().close();
  });

  test("delete works once nothing uses it, children first", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/categories");
    for (const name of [RECESSED, SPOT, TRACK]) {
      await confirmDelete(page, name);
      await expect(page).toHaveURL(/\/admin\/categories\?notice=deleted$/);
      await expect(
        page.getByRole("button", { name: `Delete ${name}`, exact: true }),
      ).toHaveCount(0);
    }
    expect(
      await db.collection("categories").countDocuments({
        _id: {
          $in: [spotId, trackId, recessedId].map((id) => new ObjectId(id)),
        },
      }),
    ).toBe(0);
    expect(
      await db.collection("auditLog").countDocuments({
        action: "category.delete",
        "target.id": { $in: [spotId, trackId, recessedId] },
      }),
    ).toBe(3);
    await page.context().close();
  });
});

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

test.describe("areas", () => {
  let retailId: string;
  let officeId: string;
  let moveAction: {
    url: string;
    headers: Record<string, string>;
    body: string;
  };

  test("create two areas", async ({ browser }) => {
    const page = await asAdmin(browser);
    await createArea(page, RETAIL);
    await createArea(page, OFFICE);
    const list = page.getByRole("list", { name: "Areas", exact: true });
    retailId = await idFromEditLink(
      list.getByRole("link", { name: `Edit ${RETAIL}`, exact: true }),
    );
    officeId = await idFromEditLink(
      list.getByRole("link", { name: `Edit ${OFFICE}`, exact: true }),
    );
    await expect(list).toContainText(`/qa-retail-${RUN}`);
    await page.context().close();
  });

  test("move down swaps them (and records the Server Action call)", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/areas");
    const requestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        request.headers()["next-action"] !== undefined,
    );
    await page.getByRole("button", { name: `Move ${RETAIL} down` }).click();
    const request = await requestPromise;
    const headers = { ...request.headers() };
    delete headers.cookie;
    moveAction = {
      url: request.url(),
      headers,
      body: request.postData() ?? "",
    };

    await expect
      .poll(async () =>
        (
          await db
            .collection("areas")
            .find({
              _id: { $in: [new ObjectId(retailId), new ObjectId(officeId)] },
            })
            .sort({ order: 1 })
            .toArray()
        ).map((r) => String(r._id)),
      )
      .toEqual([officeId, retailId]);
    await expect(
      page.getByRole("status").filter({ hasText: `${RETAIL} moved down.` }),
    ).toBeAttached();
    await page.context().close();
  });

  test("the move action replayed by a customer, a visitor or another origin changes nothing", async ({
    browser,
    playwright,
  }) => {
    const order = async () =>
      (
        await db
          .collection("areas")
          .find({
            _id: { $in: [new ObjectId(retailId), new ObjectId(officeId)] },
          })
          .sort({ order: 1 })
          .toArray()
      ).map((r) => String(r._id));
    const before = await order();
    const audits = () =>
      db.collection("auditLog").countDocuments({ action: "area.reorder" });
    const auditsBefore = await audits();

    // The same action id and arguments ("move <Office> up" is the inverse,
    // but replaying the recorded call is enough: any write would show).
    const customer = await browser.newContext({ storageState: customerState });
    const asCustomer = await customer.request.post(moveAction.url, {
      headers: moveAction.headers,
      data: moveAction.body,
      maxRedirects: 0,
    });
    expect(asCustomer.status()).toBe(403);
    expect(await asCustomer.text()).not.toContain(RETAIL);
    await customer.close();

    // A visitor with a forged session cookie gets past the proxy's coarse
    // check; requireAdmin() must still refuse.
    const visitor = await playwright.request.newContext({
      baseURL: new URL(moveAction.url).origin,
      // Name per src/lib/session-cookie.ts (prefix "yg", plain http).
      extraHTTPHeaders: { cookie: "yg.session_token=forged.value" },
    });
    const asVisitor = await visitor.post(moveAction.url, {
      headers: moveAction.headers,
      data: moveAction.body,
      maxRedirects: 0,
    });
    // A Server Action's redirect() answers 200 with this header, so the
    // header (and the unchanged database below) is the proof.
    expect(asVisitor.headers()["x-action-redirect"] ?? "").toMatch(/^\/login/);
    await visitor.dispose();

    // The admin's own cookie, but sent from another site (CSRF).
    const admin = await browser.newContext({ storageState: adminState });
    const crossSite = await admin.request.post(moveAction.url, {
      headers: { ...moveAction.headers, origin: "https://evil.example" },
      data: moveAction.body,
      maxRedirects: 0,
    });
    // Next refuses an action whose Origin is not the host (its CSRF check).
    expect(crossSite.status(), await crossSite.text()).toBeGreaterThanOrEqual(
      400,
    );
    await admin.close();

    expect(await order()).toEqual(before);
    expect(await audits()).toBe(auditsBefore);
  });

  test("delete is blocked while a product uses the area, then works", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await db.collection("products").insertOne({
      name: "QA product",
      slug: `qa-${RUN}-area`,
      status: "draft",
      mainCategory: new ObjectId(),
      extraCategories: [],
      areas: [new ObjectId(retailId)],
    });
    await page.goto("/admin/areas");
    await confirmDelete(page, RETAIL);
    await expect(
      page.getByRole("alert").filter({ hasText: "That did not work" }),
    ).toContainText("1 product uses this area");
    expect(
      await db
        .collection("areas")
        .countDocuments({ _id: new ObjectId(retailId) }),
    ).toBe(1);

    await db.collection("products").deleteOne({ slug: `qa-${RUN}-area` });
    for (const name of [RETAIL, OFFICE]) {
      await confirmDelete(page, name);
      await expect(page).toHaveURL(/\/admin\/areas\?notice=deleted$/);
      await expect(
        page.getByRole("status").filter({ hasText: "Area deleted." }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: `Delete ${name}`, exact: true }),
      ).toHaveCount(0);
    }
    expect(
      await db.collection("auditLog").countDocuments({
        action: "area.delete",
        "target.id": { $in: [retailId, officeId] },
      }),
    ).toBe(2);
    await page.context().close();
  });
});

// ---------------------------------------------------------------------------
// Guards, headers, not-found, accessibility
// ---------------------------------------------------------------------------

test.describe("guards and pages", () => {
  const SECRET_CATEGORY = `QA Hidden ${RUN}`;
  let hiddenId: string;

  test.beforeAll(async () => {
    const now = new Date();
    const result = await db.collection("categories").insertOne({
      name: SECRET_CATEGORY,
      slug: `qa-hidden-${RUN}`,
      parent: null,
      order: 99,
      createdAt: now,
      updatedAt: now,
    });
    hiddenId = result.insertedId.toHexString();
  });

  test("a customer gets 403 with no module data on every new admin URL", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: customerState });
    const page = await context.newPage();
    for (const path of [
      "/admin/categories",
      "/admin/categories/new",
      `/admin/categories/${hiddenId}`,
      "/admin/areas",
      "/admin/areas/new",
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(403);
      expect(await page.content(), path).not.toContain(SECRET_CATEGORY);
      // The RSC payload of a client-side navigation too.
      const rsc = await page.request.get(path, {
        headers: { RSC: "1" },
        maxRedirects: 0,
      });
      expect(await rsc.text(), path).not.toContain(SECRET_CATEGORY);
    }
    await context.close();
  });

  test("a visitor is sent to /login from every new admin URL", async ({
    page,
  }) => {
    for (const path of [
      "/admin/categories",
      "/admin/areas/new",
      `/admin/categories/${hiddenId}`,
    ]) {
      const response = await page.request.get(path, { maxRedirects: 0 });
      expect([302, 303, 307, 308], path).toContain(response.status());
      expect(response.headers().location, path).toMatch(/\/login$/);
    }
  });

  test("admin module pages are never stored by a browser or CDN", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    for (const path of [
      "/admin/categories",
      "/admin/areas",
      `/admin/categories/${hiddenId}`,
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      const cacheControl = response?.headers()["cache-control"] ?? "";
      expect(cacheControl, path).toContain("no-store");
      expect(cacheControl, path).toContain("private");
    }
    await page.context().close();
  });

  /*
   * QA gate A finding L-1: the status is 200, not 404. [id]/loading.tsx wraps
   * the page in Suspense, so the 200 is streamed before notFound() runs (a
   * soft 404, like the page-level 403 in ADR 0036). Harmless for an admin-only
   * page with noindex; this pins what the admin sees and that nothing leaks.
   */
  test("an unknown or malformed id shows not-found inside the admin shell", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    for (const [path, heading] of [
      [
        `/admin/categories/${new ObjectId().toHexString()}`,
        "Category not found",
      ],
      ["/admin/categories/not-an-id", "Category not found"],
      ["/admin/areas/%7B%22%24ne%22%3Anull%7D", "Area not found"],
    ] as const) {
      const response = await page.goto(path);
      expect([200, 404], path).toContain(response?.status());
      await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute(
        "content",
        /noindex/,
      );
      await expect(page.getByLabel("Name")).toHaveCount(0);
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
    }
    await page.context().close();
  });

  for (const path of [
    "/admin/categories",
    "/admin/categories/new",
    "/admin/areas",
    "/admin/areas/new",
  ]) {
    test(`axe WCAG 2.2 AA: ${path}`, async ({ browser }) => {
      const page = await asAdmin(browser);
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await page.context().close();
    });
  }

  test("axe WCAG 2.2 AA: the edit form and the open delete dialog", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto(`/admin/categories/${hiddenId}`);
    await expect(
      page.getByRole("heading", { level: 1, name: `Edit ${SECRET_CATEGORY}` }),
    ).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    await page.goto("/admin/categories");
    await page
      .getByRole("button", { name: `Delete ${SECRET_CATEGORY}`, exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.context().close();
  });

  test("invalid input shows field errors and focuses the field", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/categories/new");
    await page.getByLabel("Name").fill("   ");
    await page.getByLabel("Slug").fill("Not A Slug!");
    await page.getByRole("button", { name: "Create category" }).click();
    await expect(page.getByLabel("Name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByLabel("Slug")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByLabel("Name")).toBeFocused();
    await expect(page).toHaveURL(/\/admin\/categories\/new$/);

    // A slug already taken under the same parent is a server field error.
    await page.getByLabel("Name").fill("Anything");
    await page.getByLabel("Slug").fill(`qa-hidden-${RUN}`);
    await page.getByRole("button", { name: "Create category" }).click();
    await expect(
      page.getByText(
        "Another category under the same parent already uses this slug.",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Slug")).toBeFocused();
    expect(
      await db.collection("categories").countDocuments({ name: "Anything" }),
    ).toBe(0);
    await page.context().close();
  });
});

// ---------------------------------------------------------------------------
// T9: products list + new draft, and gate A's L-4 / L-5 on the areas list.
// In this serial file on purpose: the category tree and the area order are
// shared, ordered lists, so a separate spec running in parallel (local runs
// are fullyParallel) would shift the edges the tests above assert.
// ---------------------------------------------------------------------------

test.describe("products", () => {
  const CATEGORY = `QA ProdCat ${RUN}`;
  // Leads with RUN so the file's afterAll (slug ^qa-<RUN>) removes it.
  const PRODUCT = `QA ${RUN} Lamp`;
  const EXTRA_CATEGORY = `QA ProdExtra ${RUN}`;
  const AREA = `QA ProdArea ${RUN}`;

  test.beforeAll(async () => {
    const now = new Date();
    await db.collection("categories").insertOne({
      name: EXTRA_CATEGORY,
      slug: `qa-prodextra-${RUN}`,
      parent: null,
      order: 97,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection("areas").insertOne({
      name: AREA,
      slug: `qa-prodarea-${RUN}`,
      order: 800,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection("categories").insertOne({
      name: CATEGORY,
      slug: `qa-prodcat-${RUN}`,
      parent: null,
      order: 98,
      createdAt: now,
      updatedAt: now,
    });
  });

  test("a customer gets 403 and a visitor goes to /login", async ({
    browser,
    page,
  }) => {
    const context = await browser.newContext({ storageState: customerState });
    const customer = await context.newPage();
    for (const path of ["/admin/products", "/admin/products/new"]) {
      expect((await customer.goto(path))?.status(), path).toBe(403);
      expect(await customer.content(), path).not.toContain(CATEGORY);
      const response = await page.request.get(path, { maxRedirects: 0 });
      expect([302, 303, 307, 308], path).toContain(response.status());
      expect(response.headers().location, path).toMatch(/\/login$/);
    }
    await context.close();
  });

  test("create a draft: name + main category, then its edit page", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/products/new");

    // Empty submit: both fields flagged, focus on the first.
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(page.getByLabel("Name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByText("Choose a main category")).toBeVisible();
    await expect(page.getByLabel("Name")).toBeFocused();

    await page.getByLabel("Name").fill(PRODUCT);
    await page.getByLabel("Main category").click();
    await page.getByRole("option", { name: CATEGORY }).click();

    // Server Action calls are POSTs carrying a Next-Action header.
    let actionPosts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) {
        actionPosts += 1;
      }
    });
    // Both clicks land before the first request returns; the in-flight
    // guard must turn them into one create.
    await page.getByRole("button", { name: "Create draft" }).dblclick();
    // The edit page arrives in T10; the URL is what matters here.
    await page.waitForURL(/\/admin\/products\/[0-9a-f]{24}\?notice=created$/);

    const rows = await db
      .collection("products")
      .find({ name: PRODUCT })
      .toArray();
    expect(actionPosts).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("draft");
    expect(page.url()).toContain(String(rows[0]?._id));
    expect(
      await db.collection("auditLog").countDocuments({
        action: "product.create",
        "target.id": String(rows[0]?._id),
      }),
    ).toBe(1);
    await page.context().close();
  });

  test("the list finds it by search and filters by status and category", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/products");
    await expect(
      page.getByRole("heading", { level: 1, name: "Products" }),
    ).toBeVisible();

    await page.getByLabel("Search").fill(RUN);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]q=${RUN}`));
    const link = page.getByRole("link", { name: PRODUCT });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute(
      "href",
      /^\/admin\/products\/[0-9a-f]{24}$/,
    );
    await expect(page.getByText("1 matching product.")).toBeVisible();

    await page.getByLabel("Status").click();
    await page.getByRole("option", { name: "Published" }).click();
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/status=published/);
    await expect(page.getByText("No products match")).toBeVisible();
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/admin\/products$/);

    const category = await db
      .collection("categories")
      .findOne({ name: CATEGORY });
    await page.goto(`/admin/products?category=${String(category?._id)}`);
    await expect(page.getByRole("link", { name: PRODUCT })).toBeVisible();
    await page.context().close();
  });

  test("crafted query values fall back instead of failing", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    for (const query of [
      // JSON operator objects in `status` and `category` ({"$ne": ...}).
      "?status=%7B%22%24ne%22%3A%22x%22%7D&category=%7B%22%24ne%22%3Anull%7D",
      `?category=${new ObjectId().toHexString()}&page=-4`,
      "?page=999999&q=" + "a".repeat(500),
    ]) {
      const response = await page.goto(`/admin/products${query}`);
      expect(response?.status(), query).toBe(200);
      await expect(
        page.getByRole("heading", { level: 1, name: "Products" }),
      ).toBeVisible();
    }
    await page.context().close();
  });

  test("a crafted ?notice= never becomes markup on the list", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    const payload = '<img id="qa-xss" src="x" onerror="window.__qaXss=1">';
    const response = await page.goto(
      `/admin/products?notice=${encodeURIComponent(payload)}`,
    );
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { level: 1, name: "Products" }),
    ).toBeVisible();

    // The raw HTML: the payload may only appear escaped (flight data JSON).
    const body = (await response?.text()) ?? "";
    expect(body).not.toContain('<img id="qa-xss"');
    expect(body).not.toMatch(/<img[^>]*qa-xss/i);
    // The live DOM: no injected element, no handler ran, no notice shown.
    const injected = page.locator("#qa-xss");
    await expect(injected).toHaveCount(0);
    await expect(page.locator("[onerror]")).toHaveCount(0);
    expect(await page.evaluate(() => "__qaXss" in window)).toBe(false);
    await expect(
      page.getByRole("status").filter({ hasText: "Product" }),
    ).toHaveCount(0);

    // Control: the same locator does find such an element once one exists,
    // so the checks above can fail.
    await page.evaluate(() => {
      const img = document.createElement("img");
      img.id = "qa-xss";
      document.body.append(img);
    });
    await expect(injected).toHaveCount(1);
    await page.context().close();
  });

  // T10a: the edit page. Runs after "create a draft", which made PRODUCT.
  test("edit basics, categories, areas and filters; save twice", async ({
    browser,
  }) => {
    const row = await db.collection("products").findOne({ name: PRODUCT });
    expect(row).not.toBeNull();
    const id = String(row?._id);
    // Fields section (a) doesn't edit must survive every save.
    await db.collection("products").updateOne(
      { _id: row?._id },
      {
        $set: {
          variants: [{ modelNo: `QA-${RUN}-1`, label: "Lens" }],
          specs: { cct: ["3000K"] },
        },
      },
    );

    const page = await asAdmin(browser);
    await page.goto(`/admin/products/${id}?notice=created`);
    await expect(
      page.getByRole("heading", { level: 1, name: `Edit ${PRODUCT}` }),
    ).toBeVisible();
    await expect(page.getByText("Draft created.")).toBeVisible();

    await page.getByLabel("Family (optional)").fill("QA Family");
    await page.getByLabel("Product no. (optional)").fill("76");
    await page.getByRole("checkbox", { name: EXTRA_CATEGORY }).click();
    await page.getByRole("checkbox", { name: AREA }).click();
    await page.getByLabel("CCT (K)", { exact: true }).fill("3000, 4000");

    // Bad text is caught on the client, with focus on the field. Scoped to
    // the Filters section: the Specs section (T10b) has a "CRI" input too.
    const criFilter = page
      .getByRole("region", { name: "Filters" })
      .getByLabel("CRI", { exact: true });
    await criFilter.fill("80, high");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText('"high" is not a number')).toBeVisible();
    await expect(criFilter).toBeFocused();
    await criFilter.fill("90");

    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL(
      new RegExp(`/admin/products/${id}\\?notice=updated$`),
    );
    await expect(page.getByText("Product saved.")).toBeVisible();
    await expect(page.getByLabel("Family (optional)")).toHaveValue("QA Family");

    // A second save from the same mounted form must also go through.
    await page.getByLabel("Wattage (W)", { exact: true }).fill("12");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(
        async () =>
          (await db.collection("products").findOne({ _id: row?._id }))?.filters
            ?.wattage,
      )
      .toEqual([12]);

    await page.reload();
    await expect(page.getByLabel("CCT (K)", { exact: true })).toHaveValue(
      "3000, 4000",
    );
    await expect(page.getByLabel("Wattage (W)", { exact: true })).toHaveValue(
      "12",
    );
    await expect(
      page.getByRole("checkbox", { name: EXTRA_CATEGORY }),
    ).toBeChecked();
    await expect(page.getByRole("checkbox", { name: AREA })).toBeChecked();

    const saved = await db.collection("products").findOne({ _id: row?._id });
    expect(saved?.family).toBe("QA Family");
    expect(saved?.productNo).toBe(76);
    expect(saved?.filters).toEqual({
      cctK: [3000, 4000],
      cri: [90],
      wattage: [12],
    });
    expect(saved?.extraCategories).toHaveLength(1);
    expect(saved?.areas).toHaveLength(1);
    expect(saved?.variants).toEqual([
      { modelNo: `QA-${RUN}-1`, label: "Lens" },
    ]);
    expect(saved?.specs).toEqual({ cct: ["3000K"] });
    expect(
      await db
        .collection("auditLog")
        .countDocuments({ action: "product.update", "target.id": id }),
    ).toBe(2);
    await page.context().close();
  });

  // T10b: specs, variants, extra specs and public files. These run after the
  // T10a test above, so PRODUCT has variant `QA-<RUN>-1` and specs.cct.
  const MODEL_1 = `QA-${RUN}-1`;
  const MODEL_2 = `QA-${RUN}-2`;
  const MODEL_3 = `QA-${RUN}-3`;

  /*
   * Waits until React has hydrated the edit form (React tags hydrated DOM
   * nodes with a `__reactFiber$…` key). A click before that would submit the
   * form natively and reload the page, losing what the test typed.
   */
  const hydrated = (page: Page) =>
    page.waitForFunction(() => {
      const form = document.querySelector('form[aria-label="Product details"]');
      return (
        form !== null &&
        Object.keys(form).some((key) => key.startsWith("__reactFiber"))
      );
    });

  /* The group of one row, e.g. "Variant 2", by its accessible name. */
  const row = (page: Page, name: string) =>
    page.getByRole("group", { name, exact: true });

  test("edit specs, add and reorder variants, add an extra spec and a public file; all persist in order", async ({
    browser,
  }) => {
    const product = await db.collection("products").findOne({ name: PRODUCT });
    const id = String(product?._id);
    const page = await asAdmin(browser);
    await page.goto(`/admin/products/${id}`);
    await hydrated(page);
    const specs = page.getByRole("region", { name: "Specs" });
    // Restricted columns carry a plain badge in their label.
    await expect(specs.getByLabel("Driver")).toHaveAccessibleName(
      "Driver Restricted by default",
    );
    await specs.getByLabel("CCT", { exact: true }).fill("3000K\n4000K");
    await specs.getByLabel("Dimensions", { exact: true }).fill("Ø85 x 60 mm");

    // Add two variants; focus lands in each new row's model no.
    await page.getByRole("button", { name: "Add variant" }).click();
    const second = row(page, "Variant 2").getByLabel("Model no.");
    await expect(second).toBeFocused();
    await page.keyboard.type(MODEL_2);
    await page.getByRole("button", { name: "Add variant" }).click();
    const third = row(page, "Variant 3");
    await expect(third.getByLabel("Model no.")).toBeFocused();
    await page.keyboard.type(MODEL_3);
    await third.getByLabel("Label (optional)").fill("Reflector");

    // Variant 3 gets one spec that differs from the product's.
    await third
      .getByLabel("Add a spec that differs")
      .selectOption({ label: "Beam Angle" });
    await third
      .getByRole("button", { name: "Add the chosen spec to variant 3" })
      .click();
    const beam = third.getByLabel("Beam Angle", { exact: true });
    await expect(beam).toBeFocused();
    await beam.fill("36°");

    // Move it up: focus stays on the pressed button, now in row 2.
    await page.getByRole("button", { name: "Move variant 3 up" }).click();
    await expect(
      page.getByRole("button", { name: "Move variant 2 up" }),
    ).toBeFocused();
    await expect(row(page, "Variant 2").getByLabel("Model no.")).toHaveValue(
      MODEL_3,
    );
    await expect(
      page.getByRole("status").filter({ hasText: "moved up" }),
    ).toHaveText("Variant 3 moved up, now variant 2.");

    await page.getByRole("button", { name: "Add extra spec" }).click();
    const extra = row(page, "Extra spec 1");
    await expect(extra.getByLabel("Group (optional)")).toBeFocused();
    await extra.getByLabel("Group (optional)").fill("Physical");
    await extra.getByLabel("Label").fill("Weight");
    await extra.getByLabel("Value").fill("0.4 kg");

    // A non-https link is refused on the client, on its row, with focus.
    await page.getByRole("button", { name: "Add public file" }).click();
    const file = row(page, "Public file 1");
    await expect(file.getByLabel("Label")).toBeFocused();
    await file.getByLabel("Label").fill("IES file");
    await file.getByLabel("Link").fill("http://example.com/qa.ies");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(file.getByText("Enter a full https:// link")).toBeVisible();
    await expect(file.getByLabel("Link")).toBeFocused();
    await expect(file.getByLabel("Link")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await file.getByLabel("Link").fill("https://example.com/qa.ies");

    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL(
      new RegExp(`/admin/products/${id}\\?notice=updated$`),
    );
    await page.reload();
    await hydrated(page);
    await expect(row(page, "Variant 2").getByLabel("Model no.")).toHaveValue(
      MODEL_3,
    );
    await expect(
      row(page, "Variant 2").getByLabel("Beam Angle", { exact: true }),
    ).toHaveValue("36°");
    await expect(
      page.getByRole("region", { name: "Specs" }).getByLabel("CCT", {
        exact: true,
      }),
    ).toHaveValue("3000K\n4000K");

    const saved = await db
      .collection("products")
      .findOne({ _id: product?._id });
    expect(saved?.variants).toEqual([
      { modelNo: MODEL_1, label: "Lens" },
      { modelNo: MODEL_3, label: "Reflector", specs: { beamAngle: ["36°"] } },
      { modelNo: MODEL_2 },
    ]);
    expect(saved?.specs).toEqual({
      cct: ["3000K", "4000K"],
      dimensions: ["Ø85 x 60 mm"],
    });
    expect(saved?.extraSpecs).toEqual([
      { group: "Physical", label: "Weight", value: "0.4 kg" },
    ]);
    expect(saved?.publicFiles).toEqual([
      { label: "IES file", url: "https://example.com/qa.ies" },
    ]);
    await page.context().close();
  });

  test("a repeated model no. shows on its row with focus, on the client and from the server", async ({
    browser,
  }) => {
    const product = await db.collection("products").findOne({ name: PRODUCT });
    const id = String(product?._id);
    const OTHER = `QA-${RUN}-OTHER`;
    const now = new Date();
    await db.collection("products").insertOne({
      name: `QA ${RUN} Other`,
      slug: `qa-${RUN}-other`,
      mainCategory: product?.mainCategory,
      status: "draft",
      variants: [{ modelNo: OTHER }],
      extraCategories: [],
      areas: [],
      images: [],
      extraSpecs: [],
      publicFiles: [],
      createdAt: now,
      updatedAt: now,
    });

    const page = await asAdmin(browser);
    await page.goto(`/admin/products/${id}`);
    await hydrated(page);
    // Client: the same model no. twice in this product (any case).
    const modelNo = row(page, "Variant 3").getByLabel("Model no.");
    await modelNo.fill(MODEL_1.toLowerCase());
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      row(page, "Variant 3").getByText(
        "This model no. is already used by another variant",
      ),
    ).toBeVisible();
    await expect(modelNo).toBeFocused();
    await expect(modelNo).toHaveAttribute(
      "aria-describedby",
      "product-variants-2-modelNo-error",
    );

    // Server: a model no. another product owns comes back on the row.
    await modelNo.fill(OTHER);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      row(page, "Variant 3").getByText(
        "This model no. already belongs to another product",
      ),
    ).toBeVisible();
    await expect(modelNo).toBeFocused();
    expect(
      (await db.collection("products").findOne({ _id: product?._id }))
        ?.variants[2]?.modelNo,
    ).toBe(MODEL_2);
    await page.context().close();
  });

  test("axe WCAG 2.2 AA: the edit page with rows and the remove-variant dialog", async ({
    browser,
  }) => {
    const product = await db.collection("products").findOne({ name: PRODUCT });
    const page = await asAdmin(browser);
    await page.goto(`/admin/products/${String(product?._id)}`);
    await hydrated(page);
    await expect(row(page, "Variant 3")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "Remove variant 2" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.context().close();
  });

  test("remove a variant asks first, moves focus to the next row and saves", async ({
    browser,
  }) => {
    const product = await db.collection("products").findOne({ name: PRODUCT });
    const id = String(product?._id);
    const page = await asAdmin(browser);
    await page.goto(`/admin/products/${id}`);
    await hydrated(page);

    // Cancel keeps the row and returns focus to its Remove button.
    await page.getByRole("button", { name: "Remove variant 2" }).click();
    const dialog = page.getByRole("alertdialog", {
      name: "Remove variant 2?",
    });
    await expect(dialog).toContainText(MODEL_3);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("button", { name: "Remove variant 2" }),
    ).toBeFocused();
    await expect(page.getByRole("group", { name: /^Variant \d$/ })).toHaveCount(
      3,
    );

    await page.getByRole("button", { name: "Remove variant 2" }).click();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    const next = row(page, "Variant 2").getByLabel("Model no.");
    await expect(next).toHaveValue(MODEL_2);
    await expect(next).toBeFocused();
    await expect(page.getByRole("group", { name: /^Variant \d$/ })).toHaveCount(
      2,
    );

    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL(
      new RegExp(`/admin/products/${id}\\?notice=updated$`),
    );
    const saved = await db
      .collection("products")
      .findOne({ _id: product?._id });
    expect(saved?.variants.map((v: { modelNo: string }) => v.modelNo)).toEqual([
      MODEL_1,
      MODEL_2,
    ]);
    await page.context().close();
  });

  /*
   * T10b performance check: 200 variants (the MAX_VARIANTS cap). After a
   * failed submit the resolver re-parses the whole form on every change, so
   * typing must stay responsive. Timings are logged for the report; the
   * budgets are loose on purpose (CI machines are slower), but a per-keystroke
   * re-render of every row would blow them.
   */
  test("the form stays responsive with 200 variants", async ({ browser }) => {
    const product = await db.collection("products").findOne({ name: PRODUCT });
    const now = new Date();
    const variants = Array.from({ length: 200 }, (_, index) => ({
      modelNo: `QA-${RUN}-P${index + 1}`,
      label: `Optic ${index + 1}`,
      ...(index % 4 === 0 ? { specs: { beamAngle: ["24°", "36°"] } } : {}),
    }));
    const { insertedId } = await db.collection("products").insertOne({
      name: `QA ${RUN} Perf`,
      slug: `qa-${RUN}-perf`,
      mainCategory: product?.mainCategory,
      status: "draft",
      variants,
      specs: { cct: ["3000K"] },
      extraCategories: [],
      areas: [],
      images: [],
      extraSpecs: [],
      publicFiles: [],
      createdAt: now,
      updatedAt: now,
    });

    const page = await asAdmin(browser);
    const loadStart = Date.now();
    await page.goto(`/admin/products/${String(insertedId)}`);
    await hydrated(page);
    const last = row(page, "Variant 200").getByLabel("Label (optional)");
    await expect(last).toBeVisible();
    const loadMs = Date.now() - loadStart;

    // A failed submit switches the resolver to re-validate on every change.
    await page.getByLabel("Name").fill("");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByLabel("Name")).toBeFocused();

    await last.click();
    const typeStart = Date.now();
    await page.keyboard.type("abcdefghijklmnopqrst");
    await expect(last).toHaveValue("Optic 200abcdefghijklmnopqrst");
    const typeMs = Date.now() - typeStart;

    const moveStart = Date.now();
    await page.getByRole("button", { name: "Move variant 100 down" }).click();
    await expect(
      page.getByRole("button", { name: "Move variant 101 down" }),
    ).toBeFocused();
    const moveMs = Date.now() - moveStart;

    console.log(
      `[perf] 200 variants: load ${loadMs} ms, 20 keystrokes ${typeMs} ms, move ${moveMs} ms`,
    );
    expect(typeMs).toBeLessThan(6_000);
    expect(moveMs).toBeLessThan(3_000);
    await expect(
      page.getByRole("button", { name: "Add variant" }),
    ).toHaveAttribute("aria-disabled", "true");
    await page.context().close();
  });

  test("publish is refused with the missing items listed", async ({
    browser,
  }) => {
    const row = await db.collection("products").findOne({ name: PRODUCT });
    const page = await asAdmin(browser);
    await page.goto(`/admin/products/${String(row?._id)}`);
    await page.getByRole("button", { name: "Publish" }).click();
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "This product can't be published yet" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Add at least one image");
    expect(
      (await db.collection("products").findOne({ _id: row?._id }))?.status,
    ).toBe("draft");
    await page.context().close();
  });

  test("the edit page: 403 for a customer, /login for a visitor, 404 for an unknown id", async ({
    browser,
    page,
  }) => {
    const row = await db.collection("products").findOne({ name: PRODUCT });
    const path = `/admin/products/${String(row?._id)}`;

    const context = await browser.newContext({ storageState: customerState });
    const customer = await context.newPage();
    expect((await customer.goto(path))?.status()).toBe(403);
    expect(await customer.content()).not.toContain(PRODUCT);
    const rsc = await customer.request.get(path, {
      headers: { RSC: "1" },
      maxRedirects: 0,
    });
    expect(await rsc.text()).not.toContain(PRODUCT);
    await context.close();

    const visitor = await page.request.get(path, { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(visitor.status());
    expect(visitor.headers().location).toMatch(/\/login$/);

    const admin = await asAdmin(browser);
    for (const missing of [
      `/admin/products/${new ObjectId().toHexString()}`,
      "/admin/products/not-an-id",
    ]) {
      const response = await admin.goto(missing);
      expect(response?.status(), missing).toBe(404);
      await expect(
        admin.getByRole("heading", { level: 1, name: "Product not found" }),
      ).toBeVisible();
      await expect(admin.getByLabel("Name")).toHaveCount(0);
    }
    await admin.context().close();
  });

  test("axe WCAG 2.2 AA: the edit page and its delete dialog", async ({
    browser,
  }) => {
    const row = await db.collection("products").findOne({ name: PRODUCT });
    const page = await asAdmin(browser);
    const response = await page.goto(`/admin/products/${String(row?._id)}`);
    expect(response?.headers()["cache-control"] ?? "").toContain("no-store");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "Delete product" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.context().close();
  });

  test("delete asks first, then opens the list with a notice", async ({
    browser,
  }) => {
    const row = await db.collection("products").findOne({ name: PRODUCT });
    const page = await asAdmin(browser);
    await page.goto(`/admin/products/${String(row?._id)}`);
    await page.getByRole("button", { name: "Delete product" }).click();
    const dialog = page.getByRole("alertdialog", {
      name: `Delete ${PRODUCT}?`,
    });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(
      await db.collection("products").countDocuments({ _id: row?._id }),
    ).toBe(1);

    await page.getByRole("button", { name: "Delete product" }).click();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForURL(/\/admin\/products\?notice=deleted$/);
    await expect(page.getByText("Product deleted.")).toBeVisible();
    expect(
      await db.collection("products").countDocuments({ _id: row?._id }),
    ).toBe(0);
    await page.context().close();
  });

  for (const path of ["/admin/products", "/admin/products/new"]) {
    test(`axe WCAG 2.2 AA: ${path}`, async ({ browser }) => {
      const page = await asAdmin(browser);
      const response = await page.goto(path);
      const cacheControl = response?.headers()["cache-control"] ?? "";
      expect(cacheControl).toContain("no-store");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await page.context().close();
    });
  }
});

test.describe("areas list fixes from gate A", () => {
  const AREA_A = `QA AreaA ${RUN}`;
  const AREA_B = `QA AreaB ${RUN}`;
  const AREA_C = `QA AreaC ${RUN}`;

  test.beforeAll(async () => {
    const now = new Date();
    await db.collection("areas").insertMany(
      [AREA_A, AREA_B].map((name, index) => ({
        name,
        slug: `qa-area-${index}-${RUN}`,
        order: 900 + index,
        createdAt: now,
        updatedAt: now,
      })),
    );
  });

  test("a move clears the earlier 'created' notice (L-4)", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await createArea(page, AREA_C);

    await page.getByRole("button", { name: `Move ${AREA_C} up` }).click();
    await expect(
      page.getByRole("status").filter({ hasText: `${AREA_C} moved up.` }),
    ).toBeAttached();
    await expect(page).toHaveURL(/\/admin\/areas$/);
    await expect(page.getByText("Area created.")).toHaveCount(0);
    await page.context().close();
  });

  test("two fast clicks on a move button send one move (L-5)", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/areas");
    const names = async () =>
      (
        await db
          .collection("areas")
          .find({}, { projection: { name: 1 } })
          .sort({ order: 1, _id: 1 })
          .toArray()
      ).map((row) => String(row.name));

    const before = await names();
    const from = before.indexOf(AREA_A);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(from).toBeLessThan(before.length - 2);

    // Server Action calls are POSTs carrying a Next-Action header.
    let actionPosts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) {
        actionPosts += 1;
      }
    });

    await page.getByRole("button", { name: `Move ${AREA_A} down` }).dblclick();
    await expect(
      page.getByRole("status").filter({ hasText: `${AREA_A} moved down.` }),
    ).toBeAttached();
    // Both clicks fire before the first request returns, so a second POST
    // would already have been counted by now.
    expect(actionPosts).toBe(1);
    expect((await names()).indexOf(AREA_A)).toBe(from + 1);
    await page.context().close();
  });
});
