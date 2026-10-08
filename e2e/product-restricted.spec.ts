// Phase 4a P7: the restricted block and datasheet button on a seeded product
// whose restricted columns are all filled. A visitor sees only the fallback
// (and no restricted value in the HTML, ever); an active customer gets the
// rows, which follow the optic switch, and the download link; an expired
// customer gets "Access expired — contact us"; the slot height holds.

import { type Browser, expect, type Page, test } from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";

import { E2E_CUSTOMER } from "./fixtures/accounts";
import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";

const RUN = Date.now().toString(36);
const SLUG = `e2e-restricted-${RUN}`;
const SOON = `e2e-restricted-soon-${RUN}`;
const A1 = `RS-${RUN}-A1`.toUpperCase();
const A2 = `RS-${RUN}-A2`.toUpperCase();
// Unique tokens: a leak is a plain substring match on the page source.
const SECRET = {
  batchNo: `BATCH~${RUN}`,
  chipType: `CHIP~${RUN}`,
  holder: `HOLDER~${RUN}`,
  chipEfficiency: `EFF~${RUN}`,
  driverA1: `DRIVER-A1~${RUN}`,
  driverA2: `DRIVER-A2~${RUN}`,
};

let client: MongoClient;
let db: Db;
let productId: string;
let savedCustomer: Record<string, unknown> | null = null;
const categoryId = new ObjectId();

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
  const now = new Date();
  await db.collection("categories").insertOne({
    _id: categoryId,
    name: `E2E Restricted ${RUN}`,
    slug: `e2e-restricted-cat-${RUN}`,
    parent: null,
    order: 92,
    createdAt: now,
    updatedAt: now,
  });
  const base = {
    mainCategory: categoryId,
    extraCategories: [],
    areas: [],
    status: "published",
    featured: false,
    extraSpecs: [],
    publicFiles: [],
    images: [],
    createdAt: now,
    updatedAt: now,
  };
  const id = new ObjectId();
  productId = id.toHexString();
  await db.collection("products").insertMany([
    {
      ...base,
      _id: id,
      name: "Restricted",
      slug: SLUG,
      family: "Restricted",
      modelCode: `RS-${RUN}`.toUpperCase(),
      // Only `products.datasheetId != null` matters to the page (no file).
      datasheetId: new ObjectId(),
      specs: {
        cct: ["3000K"],
        batchNo: [SECRET.batchNo],
        chipType: [SECRET.chipType],
        holder: [SECRET.holder],
        chipEfficiency: [SECRET.chipEfficiency],
      },
      variants: [
        {
          modelNo: A1,
          label: "Lens",
          specs: { lens: ["PC lens"], driver: [SECRET.driverA1] },
        },
        {
          modelNo: A2,
          label: "Reflector",
          specs: { lens: ["Reflector"], driver: [SECRET.driverA2] },
        },
      ],
    },
    {
      ...base,
      name: "Soon",
      slug: SOON,
      datasheetId: null,
      specs: { cct: ["2700K"], driver: [SECRET.driverA1] },
      variants: [{ modelNo: `SN-${RUN}`.toUpperCase(), specs: {} }],
    },
  ]);
  savedCustomer = await db
    .collection("users")
    .findOne(
      { email: E2E_CUSTOMER.email },
      { projection: { mustChangePassword: 1, accessExpiresAt: 1 } },
    );
});

test.afterAll(async () => {
  await db.collection("products").deleteMany({ slug: { $in: [SLUG, SOON] } });
  await db.collection("categories").deleteOne({ _id: categoryId });
  if (savedCustomer) {
    await db.collection("users").updateOne(
      { email: E2E_CUSTOMER.email },
      {
        $set: {
          mustChangePassword: savedCustomer.mustChangePassword ?? true,
          accessExpiresAt: savedCustomer.accessExpiresAt ?? null,
        },
      },
    );
  }
  await client.close();
});

/* The seeded customer as an active one, or with access in the past. */
async function setCustomer(accessExpiresAt: Date | null) {
  await db
    .collection("users")
    .updateOne(
      { email: E2E_CUSTOMER.email },
      { $set: { mustChangePassword: false, accessExpiresAt } },
    );
}

async function asCustomer(browser: Browser, width = 1280): Promise<Page> {
  const context = await browser.newContext({
    storageState: loadState("customer"),
    viewport: { width, height: 800 },
  });
  return context.newPage();
}

/* The datasheet slot's height in the static HTML (no JavaScript). */
async function staticSlotHeight(
  browser: Browser,
  path: string,
  width = 1280,
): Promise<number | undefined> {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    storageState: loadState("customer"),
    viewport: { width, height: 800 },
  });
  const page = await context.newPage();
  await page.goto(path);
  const box = await page.locator('[data-slot="datasheet"]').boundingBox();
  await context.close();
  return box?.height;
}

const datasheet = (page: Page) => page.locator('[data-slot="datasheet"]');
const restricted = (page: Page) =>
  page.locator('[data-slot="restricted-specs"]');

/* The block has its answer once the route has been called and answered. */
async function gotoAndWaitForAnswer(page: Page, path: string) {
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/catalog/restricted/`) &&
      response.request().method() === "GET",
  );
  const response = await page.goto(path);
  const route = await answered;
  expect(route.headers()["cache-control"]).toContain("no-store");
  return response;
}

test("a visitor sees the fallback and no restricted value anywhere", async ({
  page,
}) => {
  const response = await gotoAndWaitForAnswer(page, `/product/${SLUG}`);
  const source = (await response?.text()) ?? "";
  for (const token of Object.values(SECRET)) {
    expect(source).not.toContain(token);
  }
  await expect(datasheet(page)).toContainText("Sign in to download");
  await expect(
    datasheet(page).getByRole("link", { name: "Sign in to download" }),
  ).toHaveAttribute("href", "/login");
  await expect(restricted(page)).toContainText("Sign in to see them");
  await expect(page.locator("[data-restricted]")).toHaveCount(0);
  const html = await page.content();
  for (const token of Object.values(SECRET)) {
    expect(html).not.toContain(token);
  }
});

test("without JavaScript the fallback line is the whole block", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`/product/${SLUG}`);
  await expect(datasheet(page)).toContainText("Sign in to download");
  await expect(restricted(page)).toContainText("Sign in to see them");
  await context.close();
});

test("an active customer gets the rows, which follow the switch, and the download", async ({
  browser,
}) => {
  await setCustomer(null);
  const before = await staticSlotHeight(browser, `/product/${SLUG}`);
  const page = await asCustomer(browser);
  await gotoAndWaitForAnswer(page, `/product/${SLUG}`);

  const download = datasheet(page).getByRole("link", {
    name: "Download datasheet",
  });
  await expect(download).toHaveAttribute("href", `/api/datasheet/${productId}`);
  // The panel slot keeps its reserved height (no layout shift).
  expect((await datasheet(page).boundingBox())?.height).toBe(before);

  await expect(
    restricted(page).getByRole("table", {
      name: `Specifications for approved customers: ${A1}`,
    }),
  ).toBeVisible();
  const table = restricted(page).locator("table");
  await expect(table).toBeVisible();
  await expect(table.locator('tr[data-spec="batchNo"] td')).toHaveText(
    SECRET.batchNo,
  );
  await expect(table.locator('tr[data-spec="driver"] td')).toHaveText(
    SECRET.driverA1,
  );
  await expect(
    table.getByRole("rowheader", { name: "Chip type" }),
  ).toBeVisible();

  // Keyboard, like a visitor (the native radio sits under its drawn dot).
  await page.getByRole("radio", { name: /Lens/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: /Reflector/ })).toBeChecked();
  // The caption names the shown model, like the public table's.
  await expect(table).toHaveAccessibleName(
    `Specifications for approved customers: ${A2}`,
  );
  await expect(table.locator('tr[data-spec="driver"] td')).toHaveText(
    SECRET.driverA2,
  );
  await expect(
    table.locator('tr[data-spec="driver"] [data-changed]'),
  ).toHaveCount(1);
  // Product-level values stay with every variant.
  await expect(table.locator('tr[data-spec="chipType"] td')).toHaveText(
    SECRET.chipType,
  );

  // A ?model= deep link opens on that variant's restricted values.
  await gotoAndWaitForAnswer(page, `/product/${SLUG}?model=${A2}`);
  await expect(
    restricted(page).locator('tr[data-spec="driver"] td'),
  ).toHaveText(SECRET.driverA2);
  await page.context().close();

  // At 360 px the download state keeps the reserved height too.
  const narrowBefore = await staticSlotHeight(browser, `/product/${SLUG}`, 360);
  const narrow = await asCustomer(browser, 360);
  await gotoAndWaitForAnswer(narrow, `/product/${SLUG}`);
  await expect(
    datasheet(narrow).getByRole("link", { name: "Download datasheet" }),
  ).toBeVisible();
  expect((await datasheet(narrow).boundingBox())?.height).toBe(narrowBefore);
  await narrow.context().close();
});

test("a product without a datasheet says coming soon, even to a customer", async ({
  browser,
}) => {
  await setCustomer(null);
  const page = await asCustomer(browser);
  await gotoAndWaitForAnswer(page, `/product/${SOON}`);
  await expect(datasheet(page)).toContainText("Datasheet coming soon");
  await expect(datasheet(page).getByRole("link")).toHaveCount(0);
  await expect(
    restricted(page).locator('tr[data-spec="driver"] td'),
  ).toHaveText(SECRET.driverA1);
  await page.context().close();
});

test("an expired customer is told to contact us and sees no value", async ({
  browser,
}) => {
  await setCustomer(new Date(Date.now() - 86_400_000));
  const page = await asCustomer(browser, 360);
  const before = await staticSlotHeight(browser, `/product/${SLUG}`, 360);
  await gotoAndWaitForAnswer(page, `/product/${SLUG}`);
  expect((await datasheet(page).boundingBox())?.height).toBe(before);
  const contact = datasheet(page).getByRole("link", {
    name: "Access expired — contact us",
  });
  await expect(contact).toHaveAttribute("href", "/contact");
  await expect(
    restricted(page).locator('[data-restricted="expired"]'),
  ).toBeVisible();
  const html = await page.content();
  for (const token of Object.values(SECRET)) {
    expect(html).not.toContain(token);
  }
  await page.context().close();
});
