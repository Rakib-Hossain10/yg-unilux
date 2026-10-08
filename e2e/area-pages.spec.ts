// Phase 4b L5: the application area pages on the production build (fixtures
// AREA_PAGES, seeded by e2e/test-server.ts before `next start`).
//   /areas lists the seeded areas as linked tiles (photo or name field);
//   an area page lists its products, the category facet narrows them (JS
//   and no-JS), chips use the category name; unknown area and a page past
//   the end are 404s; the product page's Applications row links to the area;
//   no restricted value or draft in the HTML; 360 px without horizontal
//   scroll; axe clean at 360 and 1280. Never `networkidle`.

import { expect, type Page, test } from "@playwright/test";

import {
  AREA_PAGES,
  AREA_RESTRICTED_TOKENS,
  GALLERY_PATH,
  LOBBY_PATH,
} from "./fixtures/area-pages";
import {
  axeViolations,
  horizontalOverflow,
  serveImages,
  waitForHydration,
} from "./fixtures/product-page-helpers";

const A = AREA_PAGES;
const rail = (page: Page) => page.locator('[data-slot="filter-rail"]');
const count = (page: Page) => page.locator('[data-slot="result-count"]');
const cards = (page: Page) => page.locator("[data-product-card]");
const tiles = (page: Page) => page.locator('[data-slot="area-tile"]');
const downsQuery = `?cat=${A.down.slug}`;

test.describe("/areas index", () => {
  test("lists the areas from the database as tiles linking to their pages", async ({
    page,
  }) => {
    await serveImages(page);
    const response = await page.goto("/areas");
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { level: 1, name: "Applications" }),
    ).toBeVisible();
    // Seeded first in admin order (other specs may add areas after them).
    await expect(tiles(page).nth(0)).toContainText(A.gallery.name);
    await expect(tiles(page).nth(1)).toContainText(A.lobby.name);
    // Gallery has a photo, Lobby a name field instead.
    await expect(tiles(page).nth(0).locator("img")).toHaveCount(1);
    await expect(tiles(page).nth(1).locator("img")).toHaveCount(0);

    await page.getByRole("link", { name: A.gallery.name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${GALLERY_PATH}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: A.gallery.name }),
    ).toBeVisible();
  });
});

test.describe("area listing", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("shows the area's products; the category facet narrows them", async ({
    page,
  }) => {
    await serveImages(page);
    await page.goto(GALLERY_PATH);
    await expect(count(page)).toHaveText(`${A.galleryCount} products`);
    await expect(cards(page)).toHaveCount(A.galleryCount);
    await expect(page.getByText(A.lobbyOnlyName)).toHaveCount(0);
    // The black-and-white cover fills its frame in greyscale.
    await expect(page.locator('[data-slot="listing-header"] img')).toHaveClass(
      /(^|\s)object-cover(\s|$)/,
    );
    await expect(page.locator('[data-slot="listing-header"] img')).toHaveClass(
      /(^|\s)grayscale(\s|$)/,
    );
    // The breadcrumb leads back to the index; the other areas are linked.
    await expect(
      page
        .getByRole("navigation", { name: "Breadcrumb" })
        .getByRole("link", { name: "Applications" }),
    ).toHaveAttribute("href", "/areas");
    const areaLinks = page.getByRole("navigation", { name: "Applications" });
    await expect(
      areaLinks.getByRole("link", { name: A.gallery.name }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      areaLinks.getByRole("link", { name: A.lobby.name }),
    ).toHaveAttribute("href", LOBBY_PATH);

    const box = rail(page).getByRole("checkbox", {
      name: new RegExp(`^${A.down.name}`),
    });
    await waitForHydration(box);
    await box.check();
    await expect(page).toHaveURL(new RegExp(`${GALLERY_PATH}\\${downsQuery}$`));
    await expect(count(page)).toHaveText(
      `${A.galleryCount - A.gallerySpots} of ${A.galleryCount} products`,
    );
    await expect(cards(page)).toHaveCount(A.galleryCount - A.gallerySpots);

    // The chip carries the category name and removes the filter.
    await page
      .getByRole("link", { name: `Remove filter Category ${A.down.name}` })
      .click();
    await expect(page).toHaveURL(new RegExp(`${GALLERY_PATH}$`));
    await expect(box).not.toBeChecked();
    await expect(cards(page)).toHaveCount(A.galleryCount);
  });

  test("the category facet works without JavaScript", async ({ browser }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(GALLERY_PATH);
    await rail(page)
      .getByRole("checkbox", { name: new RegExp(`^${A.spot.name}`) })
      .check();
    await rail(page).getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(
      new RegExp(`${GALLERY_PATH}\\?cat=${A.spot.slug}$`),
    );
    await expect(cards(page)).toHaveCount(A.gallerySpots);
    await context.close();
  });

  test("robots and canonical follow the query", async ({ page }) => {
    await page.goto(GALLERY_PATH);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      new RegExp(`${GALLERY_PATH}$`),
    );
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    await page.goto(`${GALLERY_PATH}${downsQuery}`);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, follow",
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      new RegExp(`${GALLERY_PATH}$`),
    );
  });

  test("the product page's Applications row links to the area", async ({
    page,
  }) => {
    await serveImages(page);
    await page.goto(GALLERY_PATH);
    await cards(page).filter({ hasText: "Area Down 2" }).click();
    await expect(page).toHaveURL(/\/product\/e2e-area-down-2-fx1$/);
    const row = page.locator('[data-section="applications"]');
    await expect(row.getByRole("link", { name: A.lobby.name })).toHaveAttribute(
      "href",
      LOBBY_PATH,
    );
    await row.getByRole("link", { name: A.gallery.name }).click();
    await expect(page).toHaveURL(new RegExp(`${GALLERY_PATH}$`));
  });

  test("the HTML holds no restricted value and no draft", async ({
    request,
  }) => {
    for (const path of [
      "/areas",
      GALLERY_PATH,
      `${GALLERY_PATH}${downsQuery}`,
      LOBBY_PATH,
    ]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      const html = await response.text();
      for (const token of AREA_RESTRICTED_TOKENS) {
        expect(html, `${path}: ${token}`).not.toContain(token);
      }
      expect(html, path).not.toContain(A.draftName);
    }
  });
});

test.describe("area 404s", () => {
  for (const path of [
    "/areas/no-such-area-fx1",
    "/areas/BAD%20SLUG",
    `${GALLERY_PATH}?page=2`,
    `${LOBBY_PATH}?page=9`,
  ]) {
    test(`${path} is a 404`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
      await expect(
        page.getByRole("heading", { level: 1, name: "Page not found" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "All applications" }),
      ).toBeVisible();
    });
  }
});

test.describe("area accessibility", () => {
  for (const width of [360, 1280]) {
    test(`axe WCAG 2.2 AA and no horizontal scroll at ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await serveImages(page);
      for (const path of ["/areas", GALLERY_PATH, LOBBY_PATH]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        if (path !== "/areas") {
          await waitForHydration(cards(page).first());
        }
        expect(await axeViolations(page), path).toEqual([]);
        expect(await horizontalOverflow(page), path).toBe(0);
      }
    });
  }
});
