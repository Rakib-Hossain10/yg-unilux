// QA gate C (Phase 2, T11-T13): the datasheets screen, the product form's
// datasheet picker and the upload controls in a real browser. There is no
// The test server now fakes R2 and Cloudinary (T18, e2e/fake-providers); the
// failure cases below inject a failing delete or a dropped connection. What is
// checked here is what the admin and the network see: no storage key or URL in the HTML or the RSC payload, access
// answers (visitor, customer, admin), the admin-only CSP, no-store, dialog and
// live-region behaviour, keyboard focus, axe, and that a failed upload leaks no
// environment name.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type Browser,
  type BrowserContext,
  type Page,
  expect,
  test,
} from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";

import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import { breakProviders, failR2Delete, pngFile } from "./fixtures/providers";

const axeSource = readFileSync(
  join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

// Its own sign-in bucket (the limiter reads this header), see gate A's spec.
const OWN_NETWORK = { "x-vercel-forwarded-for": "203.0.113.63" };

const RUN = Date.now().toString(36);
// A recognisable object key: if it ever reaches a response, the grep finds it.
const KEY_TOKEN = `0a0a0a0a-${RUN.padEnd(4, "0").slice(0, 4)}-4a0a-8a0a-0a0a0a0a0a0a`;
const USED_KEY = `datasheets/${KEY_TOKEN}.xlsx`;
const FREE_KEY = `datasheets/1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b.xlsx`;
const USED_NAME = `QA-${RUN}-family-used.xlsx`;
const FREE_NAME = `QA-${RUN}-spare.xlsx`;
const RENAMED = `QA-${RUN}-renamed.xlsx`;

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
let adminState: StorageState;
let customerState: StorageState;
let client: MongoClient;
let db: Db;
let usedId: string;
let freeId: string;
let productId: string;
let areaId: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
  adminState = loadState("admin");
  customerState = loadState("customer");

  const now = new Date();
  const mime =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const sheets = await db.collection("datasheets").insertMany([
    {
      storageKey: USED_KEY,
      fileName: USED_NAME,
      size: 123_456,
      mimeType: mime,
      uploadedBy: new ObjectId(),
      createdAt: now,
      updatedAt: now,
    },
    {
      storageKey: FREE_KEY,
      fileName: FREE_NAME,
      size: 2_048,
      mimeType: mime,
      uploadedBy: new ObjectId(),
      createdAt: now,
      updatedAt: new Date(now.getTime() - 1000),
    },
  ]);
  usedId = sheets.insertedIds[0]!.toHexString();
  freeId = sheets.insertedIds[1]!.toHexString();

  const category = await db.collection("categories").insertOne({
    name: `QA GateC Cat ${RUN}`,
    slug: `qa-gatec-cat-${RUN}`,
    parent: null,
    order: 95,
    createdAt: now,
    updatedAt: now,
  });
  const product = await db.collection("products").insertOne({
    name: `QA ${RUN} GateC`,
    slug: `qa-${RUN}-gatec`,
    mainCategory: category.insertedId,
    extraCategories: [],
    areas: [],
    status: "draft",
    featured: false,
    specs: {},
    variants: [{ modelNo: `GC-${RUN}` }],
    extraSpecs: [],
    publicFiles: [],
    images: [],
    datasheetId: sheets.insertedIds[0],
    createdAt: now,
    updatedAt: now,
  });
  productId = product.insertedId.toHexString();
  const area = await db.collection("areas").insertOne({
    name: `QA GateC Area ${RUN}`,
    slug: `qa-gatec-area-${RUN}`,
    order: 95,
    createdAt: now,
    updatedAt: now,
  });
  areaId = area.insertedId.toHexString();
});

test.afterAll(async () => {
  await db
    .collection("datasheets")
    .deleteMany({ _id: { $in: [new ObjectId(usedId), new ObjectId(freeId)] } });
  await db.collection("products").deleteMany({ slug: `qa-${RUN}-gatec` });
  await db.collection("categories").deleteMany({ slug: `qa-gatec-cat-${RUN}` });
  await db.collection("areas").deleteMany({ slug: `qa-gatec-area-${RUN}` });
  await db.collection("auditLog").deleteMany({
    "target.id": { $in: [usedId, freeId] },
  });
  await client.close();
});

async function asAdmin(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: adminState });
  return context.newPage();
}

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

/* What must never reach a browser. */
const FORBIDDEN_IN_WIRE = [
  KEY_TOKEN,
  "storageKey",
  "datasheets/",
  "incoming/",
  "r2.cloudflarestorage.com",
  "X-Amz-",
];

function expectNoStorageLeak(text: string, where: string) {
  for (const needle of FORBIDDEN_IN_WIRE) {
    expect(text, `${where} must not contain ${needle}`).not.toContain(needle);
  }
}

test.describe("access", () => {
  test("a visitor is sent to login and sees no datasheet", async ({
    request,
  }) => {
    const response = await request.get("/admin/datasheets", {
      maxRedirects: 0,
      headers: OWN_NETWORK,
    });
    expect([302, 303, 307, 308]).toContain(response.status());
    expect(response.headers().location ?? "").toContain("/login");
    expect(await response.text()).not.toContain(USED_NAME);
  });

  test("a customer gets 403 for the page and the product edit page, with no file name or key", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: customerState });
    for (const url of [
      "/admin/datasheets",
      `/admin/products/${productId}`,
      `/admin/areas/${areaId}`,
    ]) {
      const response = await context.request.get(url, { maxRedirects: 0 });
      expect(response.status(), url).toBe(403);
      const body = await response.text();
      expect(body).not.toContain(USED_NAME);
      expectNoStorageLeak(body, `customer ${url}`);
    }
    await context.close();
  });
});

test.describe("no storage key or URL on the wire", () => {
  test("the datasheets list: HTML and RSC payload", async ({ browser }) => {
    const context = await browser.newContext({ storageState: adminState });
    const html = await context.request.get("/admin/datasheets");
    expect(html.status()).toBe(200);
    const body = await html.text();
    expect(body).toContain(USED_NAME); // the page does list the file by name
    expectNoStorageLeak(body, "list HTML");
    expect(html.headers()["cache-control"] ?? "").toContain("no-store");

    const rsc = await context.request.get("/admin/datasheets", {
      headers: { RSC: "1" },
    });
    expectNoStorageLeak(await rsc.text(), "list RSC payload");
    await context.close();
  });

  test("the product edit page (picker) shows ids and names, never keys", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: adminState });
    for (const headers of [{} as Record<string, string>, { RSC: "1" }]) {
      const response = await context.request.get(
        `/admin/products/${productId}`,
        {
          headers,
        },
      );
      expect(response.status()).toBe(200);
      const body = await response.text();
      expectNoStorageLeak(body, "product edit page");
      expect(response.headers()["cache-control"] ?? "").toContain("no-store");
    }
    await context.close();
  });

  test("rendered options and links carry no key", async ({ browser }) => {
    const page = await asAdmin(browser);
    await page.goto(`/admin/products/${productId}`);
    const select = page.getByLabel("Attached datasheet");
    await expect(select).toHaveValue(usedId);
    const values = await select
      .locator("option")
      .evaluateAll((options) =>
        options.map((o) => (o as HTMLOptionElement).value),
      );
    expect(values).toContain(usedId);
    expect(values).toContain(freeId);
    for (const value of values)
      expect(value).not.toMatch(/datasheets\/|\.xlsx/);
    const hrefs = await page
      .locator("a[href]")
      .evaluateAll((links) => links.map((a) => a.getAttribute("href") ?? ""));
    for (const href of hrefs)
      expect(href).not.toMatch(/datasheets\/|\.xlsx|r2\./);
    await page.context().close();
  });
});

test.describe("headers", () => {
  test("admin pages allow the upload hosts in connect-src; public pages do not", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: adminState });
    const admin = await context.request.get("/admin/datasheets");
    const adminCsp = admin.headers()["content-security-policy"] ?? "";
    expect(adminCsp).toContain("connect-src 'self' https://api.cloudinary.com");
    expect(adminCsp).toContain("frame-ancestors 'none'");
    expect(adminCsp).toContain("object-src 'none'");
    expect(adminCsp).not.toMatch(/connect-src[^;]*\*/);

    for (const url of ["/", "/login", "/products"]) {
      // maxRedirects 0: /login sends a signed-in admin on to /admin (Phase 5
      // P2); its own answer (the redirect) must carry the public CSP.
      const publicResponse = await context.request.get(url, {
        maxRedirects: 0,
      });
      const csp = publicResponse.headers()["content-security-policy"] ?? "";
      expect(csp, url).toContain("connect-src 'self'");
      expect(csp, url).not.toContain("api.cloudinary.com");
      expect(csp, url).not.toContain("r2.cloudflarestorage.com");
    }
    await context.close();
  });
});

test.describe("datasheets screen in the browser", () => {
  test("lists the files with sizes, usage counts, and passes axe", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/datasheets");
    await expect(
      page.getByRole("heading", { name: "Datasheets", level: 1 }),
    ).toBeVisible();
    const table = page.getByRole("table", { name: "Datasheets" });
    const used = table.getByRole("row").filter({ hasText: USED_NAME });
    await expect(used).toContainText("1 product");
    await expect(used).toContainText("121 KB");
    await expect(
      table.getByRole("row").filter({ hasText: FREE_NAME }),
    ).toContainText("Not used");
    expect(await axeViolations(page)).toEqual([]);
    await page.context().close();
  });

  test("rename dialog: labelled, Escape returns focus, a real rename updates the list and audits", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/datasheets");
    const trigger = page.getByRole("button", { name: `Rename ${FREE_NAME}` });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Rename datasheet" });
    await expect(dialog).toBeVisible();
    const field = dialog.getByLabel("File name");
    await expect(field).toHaveValue(FREE_NAME);
    expect(await axeViolations(page)).toEqual([]);

    // Focus is trapped inside the dialog while it is open.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(
        await dialog.evaluate((d) => d.contains(document.activeElement)),
      ).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    // Invalid names are refused in the dialog, with the error tied to the field.
    await trigger.click();
    await field.fill("not-excel.txt");
    await dialog.getByRole("button", { name: "Save name" }).click();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(dialog).toContainText("Excel .xlsx file");
    await field.fill("../escape.xlsx");
    await dialog.getByRole("button", { name: "Save name" }).click();
    await expect(dialog).toContainText("slashes");

    await field.fill(RENAMED);
    await dialog.getByRole("button", { name: "Save name" }).click();
    await expect(dialog).toBeHidden();
    // The second matching row is the message row under it.
    const row = page.getByRole("row").filter({ hasText: RENAMED }).first();
    await expect(row).toBeVisible();
    await expect(row.getByRole("status")).toHaveText(`Renamed to ${RENAMED}.`);

    const audit = await db
      .collection("auditLog")
      .find({ "target.id": freeId, action: "datasheet.rename" })
      .toArray();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(RENAMED);
    await page.context().close();
  });

  test("deleting a datasheet that products use is refused, in an alert, and nothing changes", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/datasheets");
    await page.getByRole("button", { name: `Delete ${USED_NAME}` }).click();
    const dialog = page.getByRole("alertdialog", {
      name: `Delete ${USED_NAME}?`,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: `Delete ${USED_NAME}` }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete" })
      .click();
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "was not deleted" });
    await expect(alert).toContainText("1 product uses this datasheet");
    await expect(
      page.getByRole("row").filter({ hasText: USED_NAME }).first(),
    ).toBeVisible();
    expect(
      await db
        .collection("datasheets")
        .countDocuments({ _id: new ObjectId(usedId) }),
    ).toBe(1);
    expect(
      await db
        .collection("auditLog")
        .countDocuments({ "target.id": usedId, action: "datasheet.delete" }),
    ).toBe(0);
    await page.context().close();
  });

  test("deleting an unused datasheet while storage is unreachable keeps the row and leaks no setting name", async ({
    browser,
  }) => {
    // The bucket fake refuses to delete this object, like an R2 outage.
    await failR2Delete(FREE_KEY);
    const page = await asAdmin(browser);
    await page.goto("/admin/datasheets");
    await page.getByRole("button", { name: `Delete ${RENAMED}` }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete" })
      .click();
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "was not deleted" });
    await expect(alert).toBeVisible();
    const text = (await alert.textContent()) ?? "";
    expect(text).not.toMatch(
      /R2_|ACCOUNT_ID|SECRET|bucket|cloudflare|EnvError/i,
    );
    expect(
      await db
        .collection("datasheets")
        .countDocuments({ _id: new ObjectId(freeId) }),
    ).toBe(1);
    await page.context().close();
  });

  test("the Replace dialog opens the system file picker; a wrong file is refused in the browser", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/datasheets");
    await page
      .getByRole("button", { name: `Replace file of ${RENAMED}` })
      .click();
    const dialog = page.getByRole("alertdialog", {
      name: `Replace the file of ${RENAMED}?`,
    });
    await expect(dialog).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      dialog.getByRole("button", { name: "Choose new file" }).click(),
    ]);
    expect(chooser.isMultiple()).toBe(false);
    await chooser.setFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello"),
    });
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "was not replaced" });
    await expect(alert).toContainText("notes.txt is not an Excel .xlsx file.");
    await page.context().close();
  });

  test("an upload whose storage connection drops shows a generic error, with no env name", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    // The browser's PUT to storage fails like a dropped connection.
    await breakProviders(page);
    await page.goto("/admin/datasheets");
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      // The hidden <input type=file> is also exposed as a button of the same name
      // (finding L-4), so take the visible one by its tag.
      page.locator("button", { hasText: "Choose Excel file" }).click(),
    ]);
    await chooser.setFiles({
      name: "fresh.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from("PK\u0003\u0004 not a real workbook"),
    });
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "was not uploaded" });
    await expect(alert).toBeVisible();
    const text = (await alert.textContent()) ?? "";
    expect(text).not.toMatch(
      /R2_|ACCOUNT_ID|SECRET|EnvError|at .*\(.*:\d+:\d+\)/,
    );
    expect(
      await db
        .collection("datasheets")
        .countDocuments({ fileName: "fresh.xlsx" }),
    ).toBe(0);
    await page.context().close();
  });

  test("the upload card and row status regions are live regions (polite)", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/datasheets");
    const card = page.getByRole("region", { name: "Upload a datasheet" });
    await expect(card.locator("[role=status][aria-live=polite]")).toHaveCount(
      1,
    );
    const row = page.getByRole("row").filter({ hasText: USED_NAME });
    await expect(row.locator("[role=status][aria-live=polite]")).toHaveCount(1);
    // The button is the only keyboard control for the hidden file input.
    const input = card.locator("input[type=file]");
    await expect(input).toHaveAttribute("tabindex", "-1");
    await expect(input).toHaveAttribute("aria-label", "Choose Excel file");
    await page.context().close();
  });
});

test.describe("product form and area page", () => {
  test("the edit page, with the images editor and picker, passes axe", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto(`/admin/products/${productId}`);
    await expect(page.getByLabel("Attached datasheet")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.context().close();
  });

  test("an image upload whose connection to Cloudinary drops shows a generic error", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await breakProviders(page);
    await page.goto(`/admin/products/${productId}`);
    await page
      .locator("input[type=file]")
      .first()
      .setInputFiles(pngFile("lamp.png"));
    const uploads = page.getByRole("list", { name: "Uploads" });
    await expect(uploads).toBeVisible();
    await expect(uploads).not.toContainText(
      /CLOUDINARY|API_KEY|SECRET|EnvError/i,
    );
    await expect(page.locator("body")).not.toContainText(
      /CLOUDINARY_URL|EnvError/,
    );
    await page.context().close();
  });

  test("the area edit page (b/w image uploader) passes axe and its file input is labelled", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto(`/admin/areas/${areaId}`);
    const input = page.locator("input[type=file]");
    await expect(input).toHaveCount(1);
    expect(
      ((await input.getAttribute("aria-label")) ?? "").length,
    ).toBeGreaterThan(0);
    expect(await axeViolations(page)).toEqual([]);
    await page.context().close();
  });
});
