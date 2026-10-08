// Phase 4a P5: the optic (variant) switcher on a seeded published product.
// Arrow keys select and keep focus, the URL follows with replaceState (no
// navigation), ?model= deep links apply after hydration, single = no switch.

import { expect, type Page, test } from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";

import { connectE2eDb } from "./fixtures/database";

const RUN = Date.now().toString(36);
const SLUG = `e2e-arc-${RUN}`;
const SOLO = `e2e-solo-${RUN}`;
const A1 = `AR-${RUN}-A1`.toUpperCase();
const A2 = `AR-${RUN}-A2`.toUpperCase();

let client: MongoClient;
let db: Db;
const categoryId = new ObjectId();

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
  const now = new Date();
  await db.collection("categories").insertOne({
    _id: categoryId,
    name: `E2E Spots ${RUN}`,
    slug: `e2e-spots-${RUN}`,
    parent: null,
    order: 90,
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
    datasheetId: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection("products").insertMany([
    {
      ...base,
      name: "Arc",
      slug: SLUG,
      family: "Arc",
      modelCode: `AR-${RUN}`.toUpperCase(),
      specs: {
        housingMaterial: ["Die-cast aluminium"],
        cct: ["3000K", "4000K"],
        wattage: ["12W"],
      },
      variants: [
        {
          modelNo: A1,
          label: "Regular lens",
          specs: {
            lens: ["PC lens"],
            lumenOutput: ["1100lm"],
            lumenEfficiency: ["92lm/W"],
          },
        },
        {
          modelNo: A2,
          label: "Reflector",
          specs: {
            lens: ["Reflector"],
            lumenOutput: ["1200lm"],
            lumenEfficiency: ["100lm/W"],
          },
        },
      ],
    },
    {
      ...base,
      name: "Solo",
      slug: SOLO,
      specs: { cct: ["2700K"] },
      variants: [{ modelNo: `SO-${RUN}`.toUpperCase(), specs: {} }],
    },
  ]);
});

test.afterAll(async () => {
  await db.collection("products").deleteMany({ slug: { $in: [SLUG, SOLO] } });
  await db.collection("categories").deleteOne({ _id: categoryId });
  await client.close();
});

const panel = (page: Page) => page.locator('[data-slot="quick-spec-panel"]');
const modelNo = (page: Page) => panel(page).locator('[data-field="model-no"]');
const live = (page: Page) =>
  page.locator('[data-slot="variant-switcher"] [aria-live="polite"]');
const lumen = (page: Page) => panel(page).locator('[data-field="lumenOutput"]');

/* Hydration is done once React has attached its handlers to the radio. */
async function waitForHydration(page: Page) {
  await expect
    .poll(() =>
      page
        .locator("#variant-option-0")
        .evaluate((el) =>
          Object.keys(el).some((key) => key.startsWith("__reactProps")),
        ),
    )
    .toBe(true);
}

test("arrow keys switch the model, keep focus, update URL and announce", async ({
  page,
}) => {
  await page.goto(`/product/${SLUG}`);
  await waitForHydration(page);
  await expect(modelNo(page)).toHaveText(A1);
  await expect(lumen(page)).toHaveText("1100lm");

  const group = page.getByRole("group", { name: "Lens" });
  const first = group.getByRole("radio", { name: /Regular lens/ });
  const second = group.getByRole("radio", { name: /Reflector/ });
  await expect(first).toBeChecked();

  // A marker on window proves there was no navigation or reload.
  await page.evaluate(() => {
    (window as unknown as { __p5: number }).__p5 = 1;
  });
  const scrollBefore = await page.evaluate(() => window.scrollY);

  await first.focus();
  await page.keyboard.press("ArrowDown");

  await expect(second).toBeChecked();
  await expect(second).toBeFocused();
  await expect(modelNo(page)).toHaveText(A2);
  await expect(lumen(page)).toHaveText("1200lm");
  await expect(
    panel(page).locator('[data-field="lumenEfficiency"]'),
  ).toHaveText("100lm/W");
  // The lens row in the spec table follows; CCT (unchanged) stays put.
  await expect(page.locator('tr[data-spec="lens"] td')).toHaveText("Reflector");
  await expect(page.locator('tr[data-spec="lens"] [data-changed]')).toHaveCount(
    1,
  );
  await expect(
    panel(page).locator('[data-spec="cct"] [data-changed]'),
  ).toHaveCount(0);

  await expect(page).toHaveURL(new RegExp(`[?&]model=${A2}$`));
  await expect(live(page)).toHaveText(`${A2} selected, 1200 lumens, 100 lm/W`);
  expect(
    await page.evaluate(() => (window as unknown as { __p5?: number }).__p5),
  ).toBe(1);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

  // The Models table row follows the selection.
  await expect(
    page.locator('#models tr[data-variant-index="1"]'),
  ).toHaveAttribute("data-selected", "");

  // Arrow up goes back; the radio group wraps like any native group.
  await page.keyboard.press("ArrowUp");
  await expect(first).toBeChecked();
  await expect(modelNo(page)).toHaveText(A1);
  await expect(page).toHaveURL(new RegExp(`[?&]model=${A1}$`));
});

test("a ?model= deep link (any case) selects that model after hydration", async ({
  page,
}) => {
  await page.goto(`/product/${SLUG}?model=${A2.toLowerCase()}`);
  await waitForHydration(page);
  await expect(modelNo(page)).toHaveText(A2);
  await expect(page.getByRole("radio", { name: /Reflector/ })).toBeChecked();
  // Nothing was switched by the visitor: nothing is announced or highlighted.
  await expect(live(page)).toHaveText("");
  await expect(page.locator("[data-changed]")).toHaveCount(0);
});

test("an unknown ?model= shows variant 1 and drops the parameter", async ({
  page,
}) => {
  await page.goto(`/product/${SLUG}?model=NOPE-1&ref=x`);
  await waitForHydration(page);
  await expect(modelNo(page)).toHaveText(A1);
  await expect(page).toHaveURL(new RegExp(`/product/${SLUG}\\?ref=x$`));
});

test("Show in the Models table selects the model and focuses its radio", async ({
  page,
}) => {
  await page.goto(`/product/${SLUG}`);
  await waitForHydration(page);
  await page
    .locator("#models")
    .getByRole("button", { name: `Show ${A2}` })
    .click();
  const second = page.getByRole("radio", { name: /Reflector/ });
  await expect(second).toBeChecked();
  await expect(second).toBeFocused();
  await expect(modelNo(page)).toHaveText(A2);
  await expect(page).toHaveURL(new RegExp(`[?&]model=${A2}$`));
});

test("a single-variant product has no switcher", async ({ page }) => {
  await page.goto(`/product/${SOLO}`);
  await expect(page.locator("h1")).toHaveText("Solo");
  await expect(modelNo(page)).toHaveText(`SO-${RUN}`.toUpperCase());
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.locator('[data-slot="variant-switcher"]')).toHaveCount(0);
});

test("reduced motion: the changed value is tinted without animation", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`/product/${SLUG}`);
  await waitForHydration(page);
  await page.locator('label[for="variant-option-1"]').click();
  const changed = modelNo(page);
  await expect(changed).toHaveAttribute("data-changed", "");
  expect(
    await changed.evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
  await context.close();
});

test("at 360 px the switcher fits and the page has no horizontal scroll", async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  await page.goto(`/product/${SLUG}?model=${A2}`);
  await waitForHydration(page);
  await expect(modelNo(page)).toHaveText(A2);
  // Every option row is a 44 px+ touch target.
  for (const label of await page
    .locator('[data-slot="variant-switcher"] label')
    .all()) {
    expect((await label.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.close();
});
