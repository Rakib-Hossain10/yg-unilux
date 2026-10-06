// QA gate A (Phase 2, T1-T6) plus T9: the categories, areas and products admin
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

import { E2E_ADMIN, E2E_CUSTOMER } from "./fixtures/accounts";
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
const OWN_NETWORK = { "x-vercel-forwarded-for": "203.0.113.61" };

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

async function signInState(
  browser: Browser,
  email: string,
  password: string,
): Promise<StorageState> {
  const context = await browser.newContext({ extraHTTPHeaders: OWN_NETWORK });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  const state = await context.storageState();
  await context.close();
  return state;
}

test.beforeAll(async ({ browser }) => {
  client = await connectE2eDb();
  db = client.db();
  adminState = await signInState(browser, E2E_ADMIN.email, E2E_ADMIN.password);
  customerState = await signInState(
    browser,
    E2E_CUSTOMER.email,
    E2E_CUSTOMER.password,
  );
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

  test.beforeAll(async () => {
    const now = new Date();
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
      "?notice=%3Cimg%20src%3Dx%3E",
    ]) {
      const response = await page.goto(`/admin/products${query}`);
      expect(response?.status(), query).toBe(200);
      await expect(
        page.getByRole("heading", { level: 1, name: "Products" }),
      ).toBeVisible();
      await expect(page.locator('img[src="x"]')).toHaveCount(0);
    }
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
