// Phase 2 exit (T18): the admin builds a catalog entry end to end in a real
// browser against the production build. Sign in (shared session from global
// setup) -> category + area -> product with specs, a variant and images ->
// upload an .xlsx datasheet -> attach it -> publish -> the list shows it as
// published. Also covers the T11b/T13/T16 must-dos: the images editor (upload,
// alt, reorder, save, a stale save, a variant still using a removed image), the
// area image uploader, datasheet replace/rename/delete (and the in-use
// refusal), publish-reason links that move focus and the admin not-found page.
//
// R2 and Cloudinary are in-memory fakes (e2e/fake-providers): the server talks
// to them through a test-only preload, and the browser's own calls are stubbed
// with page.route (e2e/fixtures/providers.ts). Nothing real is contacted.
// Every test uses http://localhost and never waits for networkidle (ADR 0028).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Page, test as base, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import type { Db, MongoClient } from "mongodb";

import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import {
  cloudinaryImage,
  pngFile,
  r2Object,
  stubProviders,
} from "./fixtures/providers";

const axeSource = readFileSync(
  join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

const RUN = Date.now().toString(36);
const CATEGORY = `Exit Spots ${RUN}`;
const AREA = `Exit Lounge ${RUN}`;
const PRODUCT = `Exit Arc ${RUN}`;
const MODEL_NO = `EX-${RUN}-A1`;
const SHEET = `exit-family-${RUN}.xlsx`;
const SHEET_RENAMED = `exit-family-renamed-${RUN}.xlsx`;
// A replace takes the new file's name; the storage key stays.
const REPLACEMENT_SHEET = `exit-family-v2-${RUN}.xlsx`;
const SPARE_SHEET = `exit-spare-${RUN}.xlsx`;
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/* A real workbook (valid zip with [Content_Types].xml and xl/workbook.xml). */
async function workbook(title: string, rows: number) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Specs");
  sheet.addRow(["Model No.", title]);
  for (let i = 0; i < rows; i++) sheet.addRow([`R${i}`, i]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

/* Runs axe (WCAG 2.2 AA) and returns the violation ids. */
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

// A context holding the admin session that global setup signed in once, so no
// test here touches the per-email sign-in limiter (gate C, M-1).
const test = base.extend({
  context: async ({ browser }, provide) => {
    const context = await browser.newContext({
      storageState: loadState("admin"),
    });
    await provide(context);
    await context.close();
  },
});

test.describe.configure({ mode: "serial" });

let client: MongoClient;
let db: Db;
let productId = "";
let areaId = "";

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
});

test.afterAll(async () => {
  // Leave nothing behind for other specs (dashboard counts, listings).
  await db.collection("products").deleteMany({ name: PRODUCT });
  await db.collection("categories").deleteMany({ name: CATEGORY });
  await db.collection("areas").deleteMany({ name: AREA });
  await db.collection("datasheets").deleteMany({
    fileName: { $in: [SHEET, SHEET_RENAMED, REPLACEMENT_SHEET, SPARE_SHEET] },
  });
  await client.close();
});

/*
 * Goes to a page and waits until React has hydrated it. Filling an input that
 * already holds a server-rendered value before that point makes the browser
 * and React disagree about its content (the typed text and the old value end
 * up joined), which is a test race, not an app fault.
 */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => {
    const control = document.querySelector(
      "main button, main input, main textarea, main select",
    );
    return (
      control !== null &&
      Object.keys(control).some((key) => key.startsWith("__reactProps$"))
    );
  });
}

/* Clicks "Save changes" and waits for the server action to answer. */
async function saveProduct(page: Page): Promise<void> {
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/admin/products/"),
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  await answered;
  await expect(page.getByText("Product saved.")).toBeVisible();
}

/* The Images card's save/status line. */
const imageStatus = (page: Page) =>
  page.getByRole("region", { name: "Images" }).getByRole("status");

test("1. the admin creates a category and an area", async ({ page }) => {
  await open(page, "/admin/categories/new");
  await page.getByLabel("Name").fill(CATEGORY);
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page).toHaveURL(/\/admin\/categories(\?|$)/);
  await expect(page.getByText(CATEGORY).first()).toBeVisible();

  await open(page, "/admin/areas/new");
  await page.getByLabel("Name").fill(AREA);
  await page.getByRole("button", { name: "Create area" }).click();
  await expect(page).toHaveURL(/\/admin\/areas(\?|$)/);
  await expect(page.getByText(AREA).first()).toBeVisible();
  const area = await db.collection("areas").findOne({ name: AREA });
  areaId = String(area?._id);
  expect(areaId).toMatch(/^[0-9a-f]{24}$/);
});

test("2. a new draft starts incomplete and the publish reasons move focus to the control to fix", async ({
  page,
}) => {
  await open(page, "/admin/products/new");
  await page.getByLabel("Name").fill(PRODUCT);
  await page.locator("#product-main-category").click();
  await page.getByRole("option", { name: CATEGORY }).click();
  await page.getByRole("button", { name: "Create draft" }).click();
  await page.waitForURL(/\/admin\/products\/[0-9a-f]{24}/);
  productId = /\/admin\/products\/([0-9a-f]{24})/.exec(page.url())![1]!;

  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
  const reasons = page.getByText("Before it can be published,");
  await expect(reasons).toBeVisible();

  // Each reason is a link; clicking it moves focus (not only scroll).
  await page.getByRole("link", { name: /Add at least one variant/ }).click();
  await expect(page.locator("#product-section-variants")).toBeFocused();
  await page.getByRole("link", { name: /Add at least one image/ }).click();
  await expect(page.locator("#product-section-images")).toBeFocused();

  // The same links work from the keyboard.
  const variantLink = page.getByRole("link", {
    name: /Add at least one variant/,
  });
  await variantLink.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#product-section-variants")).toBeFocused();

  // Publishing a draft that is not ready is refused, in a list of reasons
  // that are links too.
  await page.getByRole("button", { name: "Publish" }).click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "can't be published yet" });
  await expect(alert).toBeVisible();
  await alert.getByRole("link", { name: /Add at least one image/ }).click();
  await expect(page.locator("#product-section-images")).toBeFocused();
});

test("3. product details, an area, specs and a variant are saved", async ({
  page,
}) => {
  await open(page, `/admin/products/${productId}`);
  await page.getByRole("checkbox", { name: AREA }).check();
  await page.locator("#product-specs-cct").fill("3000K\n4000K");
  await page.locator("#product-specs-wattage").fill("12W");
  await page.getByRole("button", { name: "Add variant" }).click();
  await page.locator("#product-variants-0-modelNo").fill(MODEL_NO);
  await page.locator("#product-variants-0-label").fill("Lens");
  await saveProduct(page);

  const saved = await db.collection("products").findOne({ name: PRODUCT });
  expect(saved?.variants?.[0]?.modelNo).toBe(MODEL_NO);
  expect(saved?.specs?.cct).toEqual(["3000K", "4000K"]);
  expect(saved?.areas).toHaveLength(1);
  expect(saved?.status).toBe("draft");
});

test("4. images editor: upload, alt text, reorder, save and reload", async ({
  page,
}) => {
  await stubProviders(page);
  await open(page, `/admin/products/${productId}`);
  const images = page.getByRole("region", { name: "Images" });
  await images
    .locator("input[type=file]")
    .setInputFiles([pngFile("front.png", 1), pngFile("side.png", 2)]);
  const cards = images.getByRole("list", { name: "Images in display order" });
  await expect(cards.getByRole("listitem")).toHaveCount(2);
  await expect(images.getByText("Not saved yet")).toHaveCount(2);

  // A save without alt text is refused before anything is sent.
  await images.getByRole("button", { name: "Save images" }).click();
  await expect(imageStatus(page)).toContainText("Add alt text to 2 images");

  await cards.getByLabel("Alt text").nth(0).fill("Arc spotlight, front view");
  await cards.getByLabel("Alt text").nth(1).fill("Arc spotlight, side view");

  // Move the second image first (keyboard-operable button).
  const later = images.getByRole("button", { name: "Move image 2 earlier" });
  await later.focus();
  await page.keyboard.press("Enter");
  await expect(imageStatus(page)).toContainText("moved to position 1 of 2");
  await expect(cards.getByLabel("Alt text").nth(0)).toHaveValue(
    "Arc spotlight, side view",
  );

  await images.getByRole("button", { name: "Save images" }).click();
  await expect(imageStatus(page)).toHaveText("Images saved.");

  // The server verified both uploads against the (fake) Cloudinary.
  const doc = await db.collection("products").findOne({ name: PRODUCT });
  expect(doc?.images).toHaveLength(2);
  expect(doc?.images?.[0]?.alt).toBe("Arc spotlight, side view");
  for (const image of doc?.images ?? []) {
    expect((await cloudinaryImage(image.publicId)).exists).toBe(true);
  }

  // After a reload the order and alt text are the saved ones.
  await page.reload();
  const reloaded = page
    .getByRole("list", { name: "Images in display order" })
    .getByLabel("Alt text");
  await expect(reloaded.nth(0)).toHaveValue("Arc spotlight, side view");
  await expect(reloaded.nth(1)).toHaveValue("Arc spotlight, front view");
  await expect(
    page.getByRole("region", { name: "Images" }).getByRole("status"),
  ).toHaveText("All images are saved.");
});

test("5. a stale images save is refused with PRODUCT_CHANGED text and nothing is lost", async ({
  page,
  context,
}) => {
  await stubProviders(page);
  await open(page, `/admin/products/${productId}`);
  const second = await context.newPage();
  await stubProviders(second);
  await open(second, `/admin/products/${productId}`);

  // Tab 2 changes the product first.
  await second
    .getByRole("list", { name: "Images in display order" })
    .getByLabel("Alt text")
    .nth(1)
    .fill("Arc spotlight, side view (edited)");
  await second.getByRole("button", { name: "Save images" }).click();
  await expect(imageStatus(second)).toHaveText("Images saved.");

  // Tab 1 still holds the old version.
  await page
    .getByRole("list", { name: "Images in display order" })
    .getByLabel("Alt text")
    .nth(0)
    .fill("Arc spotlight, front view (stale edit)");
  await page.getByRole("button", { name: "Save images" }).click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "The images were not saved" });
  await expect(alert).toContainText(
    "This product changed since you opened it. Reload to see the latest version.",
  );

  const doc = await db.collection("products").findOne({ name: PRODUCT });
  expect(doc?.images?.[1]?.alt).toBe("Arc spotlight, side view (edited)");
  expect(doc?.images?.[0]?.alt).toBe("Arc spotlight, side view");
  await second.close();
});

test("6. an image that a variant uses cannot be removed until the variant lets it go", async ({
  page,
}) => {
  await stubProviders(page);
  await open(page, `/admin/products/${productId}`);
  // Assign the first saved image to the variant, and save the product.
  const select = page.getByLabel("Image (optional)");
  await select.selectOption({ index: 1 });
  await saveProduct(page);

  const images = page.getByRole("region", { name: "Images" });
  await images.getByRole("button", { name: "Remove image 1" }).click();
  await images.getByRole("button", { name: "Save images" }).click();
  const alert = images.getByRole("alert").filter({ hasText: "not saved" });
  await expect(alert).toContainText(`variant ${MODEL_NO}`);
  await expect(alert).toContainText("Choose another image");
  expect(
    (await db.collection("products").findOne({ name: PRODUCT }))?.images,
  ).toHaveLength(2);

  // Discarding brings the card back; nothing was saved.
  await images.getByRole("button", { name: "Discard changes" }).click();
  await expect(
    images
      .getByRole("list", { name: "Images in display order" })
      .getByRole("listitem"),
  ).toHaveCount(2);

  // Freeing the variant first lets the removal through.
  await page.getByLabel("Image (optional)").selectOption("");
  await saveProduct(page);
  await images.getByRole("button", { name: "Remove image 2" }).click();
  await images.getByRole("button", { name: "Save images" }).click();
  await expect(imageStatus(page)).toHaveText("Images saved.");
  expect(
    (await db.collection("products").findOne({ name: PRODUCT }))?.images,
  ).toHaveLength(1);
});

test("7. datasheets: upload an .xlsx, attach it, rename, replace, and the in-use refusal", async ({
  page,
}) => {
  await stubProviders(page);
  await open(page, "/admin/datasheets");

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator("button", { hasText: "Choose Excel file" }).click(),
  ]);
  await chooser.setFiles({
    name: SHEET,
    mimeType: XLSX_MIME,
    buffer: await workbook("family", 3),
  });
  const card = page.getByRole("region", { name: "Upload a datasheet" });
  await expect(card.getByRole("status")).toHaveText(`${SHEET} uploaded.`);
  const table = page.getByRole("table", { name: "Datasheets" });
  const row = table.getByRole("row").filter({ hasText: SHEET }).first();
  await expect(row).toContainText("Not used");

  const stored = await db.collection("datasheets").findOne({ fileName: SHEET });
  const key = String(stored?.storageKey);
  expect(key).toMatch(/^datasheets\/.+\.xlsx$/);
  const firstSize = (await r2Object(key)).size;
  expect(firstSize).toBeGreaterThan(0);

  // Attach it in the product form.
  await open(page, `/admin/products/${productId}`);
  await page.getByLabel("Attached datasheet").selectOption({ label: SHEET });
  await saveProduct(page);
  expect(
    String(
      (await db.collection("products").findOne({ name: PRODUCT }))?.datasheetId,
    ),
  ).toBe(String(stored?._id));

  // Rename: the file name changes, the storage key does not.
  await open(page, "/admin/datasheets");
  await page.getByRole("button", { name: `Rename ${SHEET}` }).click();
  const dialog = page.getByRole("dialog", { name: "Rename datasheet" });
  await dialog.getByLabel("File name").fill(SHEET_RENAMED);
  await dialog.getByRole("button", { name: "Save name" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("row").filter({ hasText: SHEET_RENAMED }).first(),
  ).toContainText("1 product");

  // Replace the file: same storage key, new bytes.
  await page
    .getByRole("button", { name: `Replace file of ${SHEET_RENAMED}` })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: `Replace the file of ${SHEET_RENAMED}?`,
  });
  const [replaceChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    confirm.getByRole("button", { name: "Choose new file" }).click(),
  ]);
  await replaceChooser.setFiles({
    name: REPLACEMENT_SHEET,
    mimeType: XLSX_MIME,
    buffer: await workbook("family v2", 200),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "The file was replaced" }),
  ).toHaveCount(1);
  const after = await db.collection("datasheets").findOne({ _id: stored?._id });
  expect(after?.storageKey).toBe(key);
  expect((await r2Object(key)).size).toBeGreaterThan(firstSize);

  // A datasheet that a product uses cannot be deleted.
  await page
    .getByRole("button", { name: `Delete ${REPLACEMENT_SHEET}` })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "was not deleted" }),
  ).toContainText("1 product uses this datasheet");
  expect((await r2Object(key)).exists).toBe(true);
  expect(
    await db.collection("datasheets").countDocuments({ _id: stored?._id }),
  ).toBe(1);

  // An unused one can: the row and its object go.
  const [spare] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator("button", { hasText: "Choose Excel file" }).click(),
  ]);
  await spare.setFiles({
    name: SPARE_SHEET,
    mimeType: XLSX_MIME,
    buffer: await workbook("spare", 1),
  });
  await expect(
    page.getByRole("status").filter({ hasText: `${SPARE_SHEET} uploaded.` }),
  ).toBeVisible();
  const spareDoc = await db
    .collection("datasheets")
    .findOne({ fileName: SPARE_SHEET });
  const spareKey = String(spareDoc?.storageKey);
  expect((await r2Object(spareKey)).exists).toBe(true);
  await page.getByRole("button", { name: `Delete ${SPARE_SHEET}` }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(
    page.getByRole("row").filter({ hasText: SPARE_SHEET }),
  ).toHaveCount(0);
  expect(
    await db.collection("datasheets").countDocuments({ fileName: SPARE_SHEET }),
  ).toBe(0);
  expect((await r2Object(spareKey)).exists).toBe(false);
});

test("8. the product publishes and the list shows it as published", async ({
  page,
}) => {
  await open(page, `/admin/products/${productId}`);
  await expect(page.getByText("Before it can be published,")).toHaveCount(0);
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Published. The product is now on the site." }),
  ).toBeVisible();

  await page.goto(`/admin/products?q=${encodeURIComponent(PRODUCT)}`);
  const row = page
    .getByRole("table", { name: "Products" })
    .getByRole("row")
    .filter({ hasText: PRODUCT });
  await expect(row).toContainText("Published");
  expect(
    (await db.collection("products").findOne({ name: PRODUCT }))?.status,
  ).toBe("published");
  const audits = await db
    .collection("auditLog")
    .countDocuments({ "target.id": productId, action: "product.publish" });
  expect(audits).toBe(1);
});

test("9. the area image uploader: set, replace, remove, and axe is clean", async ({
  page,
}) => {
  await stubProviders(page);
  await open(page, `/admin/areas/${areaId}`);
  const section = page.getByRole("region", { name: "Black-and-white image" });
  await expect(section).toContainText("No image saved.");

  await section
    .locator("input[type=file]")
    .setInputFiles(pngFile("area.png", 1));
  await expect(section.getByRole("status")).toHaveText("Image saved.");
  const first = (await db.collection("areas").findOne({ name: AREA }))?.bwImage;
  expect(String(first)).toMatch(/^yg\/areas\//);
  expect((await cloudinaryImage(String(first))).exists).toBe(true);

  await page.reload();
  await expect(section).toContainText("Current image.");
  expect(await axeViolations(page)).toEqual([]);

  // Replace: a new id is stored; the old image is not deleted at save time.
  await section
    .locator("input[type=file]")
    .setInputFiles(pngFile("area2.png", 2));
  await expect(section.getByRole("status")).toHaveText("Image saved.");
  const second = (await db.collection("areas").findOne({ name: AREA }))
    ?.bwImage;
  expect(String(second)).not.toBe(String(first));
  expect((await cloudinaryImage(String(second))).exists).toBe(true);

  // Remove, after a confirm.
  await section.getByRole("button", { name: "Remove image" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove the image?" });
  await dialog.getByRole("button", { name: "Keep it" }).click();
  expect((await db.collection("areas").findOne({ name: AREA }))?.bwImage).toBe(
    second,
  );
  await section.getByRole("button", { name: "Remove image" }).click();
  await dialog.getByRole("button", { name: "Remove image" }).click();
  await expect(section.getByRole("status")).toHaveText("Image removed.");
  expect(
    (await db.collection("areas").findOne({ name: AREA }))?.bwImage ?? null,
  ).toBeNull();
  expect(await axeViolations(page)).toEqual([]);
});

test("10. the edit page passes axe, and a missing product, area or category shows a not-found page inside the admin shell", async ({
  page,
}) => {
  await stubProviders(page);
  await open(page, `/admin/products/${productId}`);
  await expect(page.getByLabel("Attached datasheet")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  const missing = "0123456789abcdef01234567";
  const cases = [
    ["products", "Product not found", "Back to products", /\/admin\/products/],
    ["areas", "Area not found", "Back to areas", /\/admin\/areas/],
    [
      "categories",
      "Category not found",
      "Back to categories",
      /\/admin\/categories/,
    ],
  ] as const;
  for (const [section, heading, back, url] of cases) {
    const response = await page.goto(`/admin/${section}/${missing}`);
    // Products answer a real 404; areas and categories still answer 200 for
    // the same page (gate A L-1, accepted), so only the content is checked.
    if (section === "products") expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { level: 1, name: heading }),
    ).toBeVisible();
    // Inside the admin shell: the admin nav is there and the way back works.
    await expect(
      page.getByRole("navigation", { name: "Admin" }).first(),
    ).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole("link", { name: back }).click();
    await expect(page).toHaveURL(url);
  }

  // A URL that matches no admin page at all gets the site's own 404, never an
  // admin page (the admin-wide not-found.tsx only serves pages that call
  // notFound() without their own, so it is not reachable by URL today).
  const unknown = await page.goto("/admin/this-page-does-not-exist");
  expect(unknown?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { level: 1, name: "Page not found" }),
  ).toBeVisible();
});
