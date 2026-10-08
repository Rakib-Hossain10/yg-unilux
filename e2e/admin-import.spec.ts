// Phase 3 exit (T11): the bulk import end to end in a real browser against the
// production build. Sign in (shared session from global setup) -> /admin/import
// -> download the template -> upload a filled copy (Arc, 2 variants, one
// floating picture) -> the preview shows the counts -> save -> the Arc product
// is a draft with 2 variants and 1 image -> import the same file again -> the
// preview says "all unchanged" and nothing is written. The synthetic bilingual
// fixture (test/fixtures/import/build.ts) is the tolerance case. axe (WCAG 2.2
// AA), the 375 px layout and the focus move are checked at every step.
//
// R2 and Cloudinary are the in-memory fakes (e2e/fake-providers): the browser's
// presigned PUT to imports/ is forwarded by stubProviders, the server's
// If-Match + Range GET and Cloudinary upload_stream go through the preload.
// Every test uses http://localhost and never waits for networkidle (ADR 0028).

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Page, test as base, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import type { Db, MongoClient } from "mongodb";

import { buildFixture, fixturePictures } from "../test/fixtures/import/build";
import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import { cloudinaryImage, r2Object, stubProviders } from "./fixtures/providers";

const axeSource = readFileSync(
  join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

const RUN = Date.now().toString(36).toUpperCase();
const CATEGORY = `Import Spots ${RUN}`;
const AREA = `Import Lounge ${RUN}`;
const BASE_MODEL = `AR-${RUN}A`;
const MODEL_NOS = [`${BASE_MODEL}1`, `${BASE_MODEL}2`];
// The bilingual fixture's products (Nos. 76-79; 80/81 have no Model No.).
const FIXTURE_MODEL_NOS = ["A", "B", "C", "D"].flatMap((l) => [
  `AR-013${l}1`,
  `AR-013${l}2`,
]);
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PHONE = { width: 375, height: 800 };
const DESKTOP = { width: 1280, height: 800 };
const CJK = /[　-〿㐀-鿿＀-￯]/;

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

/* axe at desktop width, then no horizontal page scroll (and axe) at 375 px. */
async function checkLayout(page: Page): Promise<void> {
  expect(await axeViolations(page)).toEqual([]);
  await page.setViewportSize(PHONE);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
  await page.setViewportSize(DESKTOP);
}

const stepHeading = (page: Page, name: string) =>
  page.getByRole("heading", { level: 2, name });

/* One count tile of the preview summary (a <dt>/<dd> pair). */
async function expectCount(page: Page, label: string, value: number) {
  const tile = page.locator("dl > div").filter({
    has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }),
  });
  await expect(tile.locator("dd")).toHaveText(String(value));
}

// A context holding the admin session that global setup signed in once.
const test = base.extend({
  context: async ({ browser }, provide) => {
    const context = await browser.newContext({
      storageState: loadState("admin"),
      viewport: DESKTOP,
    });
    await provide(context);
    await context.close();
  },
});

test.describe.configure({ mode: "serial" });

let client: MongoClient;
let db: Db;
let categoryId = "";
let areaId = "";
let filled: Buffer = Buffer.alloc(0);

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
});

test.afterAll(async () => {
  await db.collection("products").deleteMany({
    "variants.modelNo": { $in: [...MODEL_NOS, ...FIXTURE_MODEL_NOS] },
  });
  await db.collection("categories").deleteMany({ name: CATEGORY });
  await db.collection("areas").deleteMany({ name: AREA });
  await client.close();
});

/* Goes to a page and waits until React has hydrated it (see admin-product). */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => {
    const control = document.querySelector("main button, main input");
    return (
      control !== null &&
      Object.keys(control).some((key) => key.startsWith("__reactProps$"))
    );
  });
}

/* Step 1: choose the file and the default category, upload, wait for step 2. */
async function uploadAndPreview(
  page: Page,
  file: { name: string; buffer: Buffer },
): Promise<void> {
  await page
    .getByLabel("Excel file")
    .setInputFiles({ ...file, mimeType: XLSX_MIME });
  await page.getByRole("combobox", { name: "Default category" }).click();
  await page.getByRole("option", { name: CATEGORY }).click();
  await page.getByRole("button", { name: "Upload and preview" }).click();
  const heading = stepHeading(page, "Step 2: Check what will change");
  await expect(heading).toBeVisible({ timeout: 30_000 });
  // The step change moves focus to the new step's heading.
  await expect(heading).toBeFocused();
}

/* Fills the downloaded template the way the client would. */
async function fillTemplate(template: Buffer): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(template as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Products");
  if (!sheet) throw new Error("the template has no Products sheet");
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, column) => {
    headers[column - 1] = String(cell.value);
  });
  const col = (header: string) => {
    const at = headers.findIndex(
      (h) => h.toLowerCase() === header.toLowerCase(),
    );
    if (at === -1) throw new Error(`the template has no "${header}" column`);
    return at + 1;
  };
  const shared = {
    "Model Name": "Arc",
    "Model Type": "Pull-Down Spot Light",
    "Housing Material": "Die Casting Aluminium",
    "Housing Color/Finish": "White/Black",
    "Cut-out Size": "Ø90mm",
    Dimensions: "D100*H110mm",
    "Chip Type": "COB",
    CCT: "3000K\n4000K",
    CRI: ">90",
    "Beam Angle": "20°\n30°",
    Driver: "Lifud",
    "Voltage INPUT": "AC220-240V",
    Wattage: "12W",
    "IP Rating": "IP20",
    Category: CATEGORY,
    [`Area: ${AREA}`]: "Yes",
  };
  const rows: Record<string, ExcelJS.CellValue>[] = [
    {
      "NO.": 1,
      ...shared,
      "Model No.": MODEL_NOS[0],
      Lens: "Regular Lens",
      Reflector: "-",
      "Lumen Output": "1140 LM",
    },
    {
      ...shared,
      "Model No.": MODEL_NOS[1],
      Lens: "-",
      Reflector: "High Efficiency Reflector",
      "Lumen Output": "1200 LM",
    },
  ];
  const [picture] = await fixturePictures();
  const imageId = workbook.addImage({
    buffer: picture as unknown as ExcelJS.Buffer,
    extension: "png",
  });
  rows.forEach((row, i) => {
    const r = i + 2;
    for (const [header, value] of Object.entries(row)) {
      sheet.getCell(r, col(header)).value = value;
    }
    // The same floating picture over the Image cell of both rows.
    sheet.addImage(imageId, {
      tl: { col: col("Image") - 1, row: r - 1 },
      ext: { width: 64, height: 64 },
      editAs: "oneCell",
    });
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("1. the admin creates the category and area the template will list", async ({
  page,
}) => {
  await open(page, "/admin/categories/new");
  await page.getByLabel("Name").fill(CATEGORY);
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page).toHaveURL(/\/admin\/categories(\?|$)/);
  categoryId = String(
    (await db.collection("categories").findOne({ name: CATEGORY }))?._id,
  );
  expect(categoryId).toMatch(/^[0-9a-f]{24}$/);

  await open(page, "/admin/areas/new");
  await page.getByLabel("Name").fill(AREA);
  await page.getByRole("button", { name: "Create area" }).click();
  await expect(page).toHaveURL(/\/admin\/areas(\?|$)/);
  areaId = String((await db.collection("areas").findOne({ name: AREA }))?._id);
  expect(areaId).toMatch(/^[0-9a-f]{24}$/);
});

test("2. step 1 downloads a template that lists the live category and area", async ({
  page,
}) => {
  await open(page, "/admin/import");
  await expect(
    page.getByRole("heading", { level: 1, name: "Import products" }),
  ).toBeVisible();
  await expect(stepHeading(page, "Step 1: Upload the file")).toBeVisible();
  await checkLayout(page);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download template" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  const template = await readFile(await download.path());

  // The route answers privately and never cached.
  const response = await page.request.get("/api/admin/import/template");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["content-disposition"]).toContain("attachment");

  const book = new ExcelJS.Workbook();
  await book.xlsx.load(template as unknown as ExcelJS.Buffer);
  const header = book.getWorksheet("Products")?.getRow(1).values as unknown[];
  expect(header).toContain(`Area: ${AREA}`);
  const lists: unknown[] = [];
  book
    .getWorksheet("Lists")
    ?.getColumn(1)
    .eachCell((cell) => {
      lists.push(cell.value);
    });
  expect(lists).toContain(CATEGORY);

  filled = await fillTemplate(template);
});

test("3. a filled template previews, saves, and the Arc product is a draft with 2 variants and an image", async ({
  page,
}) => {
  await stubProviders(page);
  await open(page, "/admin/import");
  await uploadAndPreview(page, { name: `arc-${RUN}.xlsx`, buffer: filled });

  await expectCount(page, "New products", 1);
  await expectCount(page, "Products to update", 0);
  await expectCount(page, "Unchanged", 0);
  await expectCount(page, "Blocked \\(not saved\\)", 0);
  await expectCount(page, "Pictures to add", 1);
  await expectCount(page, "Variants to remove", 0);
  await expect(page.getByRole("tab", { name: "Products (1)" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Warnings (0)" })).toBeVisible();
  await expect(page.getByText(/1 new product will be saved/)).toBeVisible();
  await checkLayout(page);
  // Nothing written yet.
  expect(
    await db
      .collection("products")
      .countDocuments({ "variants.modelNo": MODEL_NOS[0] }),
  ).toBe(0);

  const auditsBefore = await db
    .collection("auditLog")
    .countDocuments({ action: "import.commit" });
  await page.getByRole("button", { name: "Save 1 product" }).click();
  const heading = stepHeading(page, "Step 3: Save");
  await expect(heading).toBeFocused();
  await expect(page.getByText("All 1 batch saved.")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Import finished")).toBeVisible();
  await expect(
    page.getByText(/^1 product created \(as drafts\), 0 updated/),
  ).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Arc" });
  await expect(row).toContainText("Created");
  await expect(row.getByRole("link", { name: /Edit/ })).toBeVisible();
  await checkLayout(page);

  const product = await db
    .collection("products")
    .findOne({ "variants.modelNo": MODEL_NOS[0] });
  expect(product?.status).toBe("draft");
  expect(product?.slug).toBe(`arc-${BASE_MODEL.toLowerCase()}`);
  expect(
    (product?.variants as { modelNo: string }[]).map((v) => v.modelNo),
  ).toEqual(MODEL_NOS);
  expect(product?.images).toHaveLength(1);
  const image = product?.images?.[0] as { publicId: string; alt: string };
  expect(image.alt).toBeTruthy();
  expect((await cloudinaryImage(image.publicId)).exists).toBe(true);
  expect(String(product?.mainCategory)).toBe(categoryId);
  expect((product?.areas as unknown[]).map(String)).toEqual([areaId]);
  expect(
    await db.collection("auditLog").countDocuments({ action: "import.commit" }),
  ).toBeGreaterThan(auditsBefore);

  // The staged file is deleted once the import finished.
  const staged = await db
    .collection("auditLog")
    .find({ action: "import.commit" })
    .sort({ _id: -1 })
    .limit(1)
    .next();
  const stagedId = String(
    (staged?.target as { id?: string } | undefined)?.id ?? "",
  );
  expect(stagedId).toMatch(/^[0-9a-f-]{36}$/);
  await expect
    .poll(async () => (await r2Object(`imports/${stagedId}.xlsx`)).exists)
    .toBe(false);
});

test("4. importing the same file again previews all unchanged and writes nothing", async ({
  page,
}) => {
  await stubProviders(page);
  const before = await db
    .collection("products")
    .findOne({ "variants.modelNo": MODEL_NOS[0] });
  const auditsBefore = await db.collection("auditLog").countDocuments({});

  await open(page, "/admin/import");
  await uploadAndPreview(page, { name: `arc-${RUN}.xlsx`, buffer: filled });
  await expectCount(page, "New products", 0);
  await expectCount(page, "Products to update", 0);
  await expectCount(page, "Unchanged", 1);
  await expectCount(page, "Pictures to add", 0);
  await expect(page.getByText("There is nothing to save")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Save / })).toHaveCount(0);
  await checkLayout(page);

  // Back to step 1: focus moves to its heading; the staged file is dropped.
  await page.getByRole("button", { name: "Choose another file" }).click();
  await expect(stepHeading(page, "Step 1: Upload the file")).toBeFocused();

  const after = await db
    .collection("products")
    .findOne({ "variants.modelNo": MODEL_NOS[0] });
  expect(after?.updatedAt).toEqual(before?.updatedAt);
  expect(after?.images).toEqual(before?.images);
  expect(after?.variants).toEqual(before?.variants);
  expect(await db.collection("auditLog").countDocuments({})).toBe(auditsBefore);
});

test("5. tolerance: the bilingual sample-sheet fixture imports 4 products in English and blocks 2", async ({
  page,
}) => {
  await stubProviders(page);
  await open(page, "/admin/import");
  await uploadAndPreview(page, {
    name: `bilingual-${RUN}.xlsx`,
    buffer: await buildFixture(),
  });
  await expectCount(page, "New products", 4);
  await expectCount(page, "Blocked \\(not saved\\)", 2);
  // One Cloudinary copy per product: Nos. 76+77 share picture A, 78+79 B.
  await expectCount(page, "Pictures to add", 4);
  await checkLayout(page);

  // The warnings tab lists why Nos. 80 and 81 are blocked.
  await page.getByRole("tab", { name: /^Warnings/ }).click();
  await expect(page.getByRole("tabpanel")).toContainText(/Model No/i);

  await page.getByRole("button", { name: "Save 4 products" }).click();
  await expect(stepHeading(page, "Step 3: Save")).toBeFocused();
  await expect(page.getByText(/^All 1 batch saved\.$/)).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Import finished")).toBeVisible();
  await expect(
    page.getByText(/^4 products created \(as drafts\), 0 updated/),
  ).toBeVisible();
  await checkLayout(page);

  const saved = await db
    .collection("products")
    .find({ "variants.modelNo": { $in: FIXTURE_MODEL_NOS } })
    .toArray();
  expect(saved).toHaveLength(4);
  for (const product of saved) {
    expect(product.status).toBe("draft");
    expect(product.variants).toHaveLength(2);
    expect(product.images).toHaveLength(1);
    // Every stored text is English: the Chinese lines were dropped.
    expect(JSON.stringify(product)).not.toMatch(CJK);
    // No Category column: the default category was used.
    expect(String(product.mainCategory)).toBe(categoryId);
  }
  expect(saved.map((p) => p.slug).sort()).toContain("arc-ar-013a");
});

test("6. a file that is not a workbook is refused as a whole and nothing is saved", async ({
  page,
}) => {
  await stubProviders(page);
  const before = await db.collection("products").countDocuments({});
  await open(page, "/admin/import");
  await uploadAndPreview(page, {
    name: `not-a-workbook-${RUN}.xlsx`,
    buffer: Buffer.from("this is plain text, not a zip"),
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "This file can't be imported" }),
  ).toBeVisible();
  await expect(page.getByText("Not a readable Excel file")).toBeVisible();
  await checkLayout(page);

  await page.getByRole("button", { name: "Choose another file" }).click();
  await expect(stepHeading(page, "Step 1: Upload the file")).toBeFocused();
  expect(await db.collection("products").countDocuments({})).toBe(before);
});
