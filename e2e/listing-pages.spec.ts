// Phase 4b L4: the listing pages on the production build (fixtures LISTING,
// seeded by e2e/test-server.ts before `next start`).
//   no JS: the filter rail is a plain GET form (Apply), the sort form too;
//   JS: a tick updates the URL in place (router.replace), the count is
//   announced, chips and "Clear all" reset the boxes; the mobile sheet;
//   unknown category and page past the end are 404s; 360 px: 2 columns, no
//   horizontal scroll; axe clean at 360 and 1280; no restricted value or
//   draft in the HTML. Never `networkidle`.

import { type Browser, expect, type Page, test } from "@playwright/test";

import {
  LISTING,
  LISTING_MAIN_PATH,
  LISTING_RECESSED_PATH,
  LISTING_RESTRICTED_TOKENS,
  listingName,
} from "./fixtures/listing-pages";
import {
  axeViolations,
  horizontalOverflow,
  serveImages,
  waitForHydration,
} from "./fixtures/product-page-helpers";

const PATH = LISTING_RECESSED_PATH;
const rail = (page: Page) => page.locator('[data-slot="filter-rail"]');
const sheet = (page: Page) => page.locator('[data-slot="filter-sheet"]');
const count = (page: Page) => page.locator('[data-slot="result-count"]');
const cards = (page: Page) => page.locator("[data-product-card]");

async function noJsPage(browser: Browser, width = 1280) {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width, height: 900 },
  });
  return { context, page: await context.newPage() };
}

test.describe("listing without JavaScript", () => {
  test("the filter rail submits as a GET form and narrows the list", async ({
    browser,
  }) => {
    // 360 px: without JS the rail shows inline (no sheet button).
    const { context, page } = await noJsPage(browser, 360);
    const response = await page.goto(PATH);
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { level: 1, name: LISTING.recessed.name }),
    ).toBeVisible();
    await expect(count(page)).toHaveText(`${LISTING.count} products`);
    await expect(cards(page)).toHaveCount(24);
    await expect(rail(page)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Filters/ })).toBeHidden();

    await rail(page)
      .getByRole("checkbox", { name: /^3000K/ })
      .check();
    await rail(page).getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/\?cct=3000$/);
    await expect(count(page)).toHaveText(
      `${LISTING.cct3000} of ${LISTING.count} products`,
    );
    await expect(
      page.getByRole("link", { name: "Remove filter CCT 3000K" }),
    ).toBeVisible();
    await expect(
      rail(page).getByRole("checkbox", { name: /^3000K/ }),
    ).toBeChecked();

    // The sort form carries the filters along.
    await page.getByLabel("Sort by").selectOption("name");
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    await expect(page).toHaveURL(/\?cct=3000&sort=name$/);
    await expect(count(page)).toHaveText(
      `${LISTING.cct3000} of ${LISTING.count} products`,
    );
    await context.close();
  });

  test("numbered pagination links work without JS", async ({ browser }) => {
    const { context, page } = await noJsPage(browser);
    await page.goto(PATH);
    const pagination = page.getByRole("navigation", { name: "Pagination" });
    await pagination.getByRole("link", { name: "Page 2" }).click();
    await expect(page).toHaveURL(new RegExp(`${PATH}\\?page=2$`));
    await expect(cards(page)).toHaveCount(LISTING.count - 24);
    await expect(pagination.locator('[aria-current="page"]')).toContainText(
      "2",
    );
    await context.close();
  });
});

test.describe("listing with JavaScript", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("a tick updates the URL in place, announces the count, chips reset", async ({
    page,
  }) => {
    await serveImages(page);
    await page.goto(PATH);
    const box = rail(page).getByRole("checkbox", { name: /^IP65/ });
    await waitForHydration(box);
    // JS applies changes itself: no Apply button.
    await expect(
      rail(page).getByRole("button", { name: "Apply filters" }),
    ).toHaveCount(0);

    await box.focus();
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(new RegExp(`${PATH}\\?ip=65$`));
    await expect(count(page)).toHaveText(
      `${LISTING.ip65} of ${LISTING.count} products`,
    );
    await expect(cards(page)).toHaveCount(LISTING.ip65);
    await expect(rail(page).locator('p[aria-live="polite"]')).toHaveText(
      `${LISTING.ip65} products found`,
    );
    // Focus stays on the box the visitor used.
    await expect(box).toBeFocused();
    await expect(box).toBeChecked();

    // A second facet ANDs with the first.
    await rail(page)
      .getByRole("checkbox", { name: /^3000K/ })
      .check();
    await expect(page).toHaveURL(new RegExp(`${PATH}\\?cct=3000&ip=65$`));
    await expect(count(page)).toHaveText(`2 of ${LISTING.count} products`);

    // Removing a chip unticks its box without a reload.
    await page
      .getByRole("link", { name: "Remove filter IP rating IP65" })
      .click();
    await expect(page).toHaveURL(new RegExp(`${PATH}\\?cct=3000$`));
    await expect(box).not.toBeChecked();
    // Clear all.
    await rail(page).getByRole("link", { name: "Clear all" }).click();
    await expect(page).toHaveURL(new RegExp(`${PATH}$`));
    await expect(
      rail(page).getByRole("checkbox", { name: /^3000K/ }),
    ).not.toBeChecked();
    await expect(count(page)).toHaveText(`${LISTING.count} products`);

    // Sort applies on change, and the back button restores the old order.
    await page.getByLabel("Sort by").selectOption("newest");
    await expect(page).toHaveURL(new RegExp(`${PATH}\\?sort=newest$`));
    await expect(cards(page).first()).toContainText(listingName(1));
    await page.getByLabel("Sort by").selectOption("name");
    await expect(page).toHaveURL(new RegExp(`${PATH}\\?sort=name$`));
  });

  test("a card opens its product; the breadcrumb leads back to the listing", async ({
    page,
  }) => {
    await serveImages(page);
    await page.goto(PATH);
    const first = cards(page).first();
    await expect(first).toContainText(listingName(1));
    await expect(first).toContainText("2 models");
    await expect(first).toContainText("Lyra");
    await first.click();
    await expect(page).toHaveURL(/\/product\/e2e-listing-1-fx1$/);
    const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(
      crumb.getByRole("link", { name: LISTING.recessed.name }),
    ).toHaveAttribute("href", PATH);
    await crumb.getByRole("link", { name: LISTING.main.name }).click();
    await expect(page).toHaveURL(new RegExp(`${LISTING_MAIN_PATH}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: LISTING.main.name }),
    ).toBeVisible();
  });

  test("the HTML holds no restricted value and no draft", async ({
    request,
  }) => {
    for (const path of [
      PATH,
      `${PATH}?cct=3000`,
      `${PATH}?page=2`,
      LISTING_MAIN_PATH,
      "/products",
    ]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      const html = await response.text();
      for (const token of LISTING_RESTRICTED_TOKENS) {
        expect(html, `${path}: ${token}`).not.toContain(token);
      }
      expect(html, path).not.toContain(LISTING.draftName);
    }
  });

  test("robots and canonical follow the query", async ({ page }) => {
    await page.goto(`${PATH}?page=2`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      new RegExp(`${PATH}\\?page=2$`),
    );
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    await page.goto(`${PATH}?cct=3000`);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, follow",
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      new RegExp(`${PATH}$`),
    );
  });
});

test.describe("listing 404s", () => {
  for (const path of [
    "/products/no-such-category",
    `/products/${LISTING.recessed.slug}`,
    `${LISTING_MAIN_PATH}/nope`,
    `${PATH}/too-deep`,
    `${PATH}?page=3`,
    `${PATH}?cct=9000&page=2`,
  ]) {
    test(`${path} is a 404`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(404);
      expect(await response.text()).toContain("Page not found");
    });
  }

  test("page 1 of an empty filter result is the empty state, not a 404", async ({
    page,
  }) => {
    const response = await page.goto(`${PATH}?cct=9000`);
    expect(response?.status()).toBe(200);
    await expect(
      page.getByText("No products match these filters"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Remove filter CCT 9000K" }),
    ).toBeVisible();
  });
});

test.describe("listing at 360 px", () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test("two columns, no horizontal scroll, the filter sheet works", async ({
    page,
  }) => {
    await serveImages(page);
    await page.goto(PATH);
    await expect(rail(page)).toBeHidden();
    expect(await horizontalOverflow(page)).toBe(0);
    const [a, b, c] = await Promise.all(
      [0, 1, 2].map((i) => cards(page).nth(i).boundingBox()),
    );
    expect(a && b && c).toBeTruthy();
    // Cards 1 and 2 share a row; card 3 starts the next one.
    expect(Math.abs((a?.y ?? 0) - (b?.y ?? 1))).toBeLessThan(2);
    expect(b?.x ?? 0).toBeGreaterThan(a?.x ?? 0);
    expect(c?.y ?? 0).toBeGreaterThan(a?.y ?? 0);

    const open = page.getByRole("button", { name: /^Filters/ });
    await waitForHydration(open);
    await open.click();
    const dialog = page.getByRole("dialog", { name: "Filters" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("checkbox", { name: /^4000K/ }).check();
    await expect(page).toHaveURL(new RegExp(`${PATH}\\?cct=4000$`));
    await expect(sheet(page).locator('p[aria-live="polite"]')).toHaveText(
      `${LISTING.count - LISTING.cct3000} products found`,
    );
    await dialog
      .getByRole("button", {
        name: `Show ${LISTING.count - LISTING.cct3000} products`,
      })
      .click();
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
    await expect(open).toHaveText("Filters(1)");
    await expect(count(page)).toHaveText(
      `${LISTING.count - LISTING.cct3000} of ${LISTING.count} products`,
    );
    expect(await horizontalOverflow(page)).toBe(0);

    // Esc closes the sheet too.
    await open.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

test.describe("listing accessibility", () => {
  for (const width of [360, 1280]) {
    test(`axe WCAG 2.2 AA at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await serveImages(page);
      await page.goto(`${PATH}?cct=3000`);
      await waitForHydration(page.locator("[data-product-card]").first());
      expect(await axeViolations(page)).toEqual([]);
      if (width === 360) {
        await page.getByRole("button", { name: /^Filters/ }).click();
        await expect(
          page.getByRole("dialog", { name: "Filters" }),
        ).toBeVisible();
        expect(await axeViolations(page)).toEqual([]);
      }
    });
  }

  test("axe on /products and the main category", async ({ page }) => {
    await serveImages(page);
    for (const path of ["/products", LISTING_MAIN_PATH]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await axeViolations(page), path).toEqual([]);
    }
  });
});
