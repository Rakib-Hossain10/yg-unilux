// Phase 4b gate C polish (ui-reviewer H-1, M-2, M-3, M-5, M-6, L-3, L-4,
// L-8) on the production build: card pictures shown whole, the sub-link
// row keeps the 16 px gutter while it scrolls, card names line up, the area
// band (photo and no-photo), /areas rows without a hole, one "Clear all" at
// lg+, a full-width "Show n products" in the sheet, the site's sort select.
// Axe clean, no restricted value, never `networkidle`.

import { expect, type Page, test } from "@playwright/test";

import {
  AREA_PAGES,
  AREA_RESTRICTED_TOKENS,
  GALLERY_PATH,
  LOBBY_PATH,
} from "./fixtures/area-pages";
import {
  LISTING_MAIN_PATH,
  LISTING_RESTRICTED_TOKENS,
} from "./fixtures/listing-pages";
import {
  axeViolations,
  horizontalOverflow,
  serveImages,
  waitForHydration,
} from "./fixtures/product-page-helpers";

const cards = (page: Page) => page.locator("[data-product-card]");

test.describe("listing cards and header at 360", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("pictures are contained, names line up, the link row keeps its gutter", async ({
    page,
  }) => {
    await serveImages(page);
    await page.goto("/products");
    await expect(cards(page).first()).toBeVisible();

    // H-1: every card picture is shown whole, inset on the grey frame.
    const fits = await cards(page)
      .locator("img")
      .evaluateAll((images) =>
        images.map((image) => getComputedStyle(image).objectFit),
      );
    expect(fits.length).toBeGreaterThan(0);
    expect(new Set(fits)).toEqual(new Set(["contain"]));

    // M-3: the names of a row start at the same height.
    const tops = await cards(page)
      .locator("h3")
      .evaluateAll((headings) =>
        headings
          .slice(0, 4)
          .map((h) => Math.round(h.getBoundingClientRect().y)),
      );
    expect(tops[0]).toBe(tops[1]);
    expect(tops[2]).toBe(tops[3]);
    // ...and the model line never wraps under itself.
    const metaHeights = await cards(page)
      .locator("h3 + p")
      .evaluateAll((lines) =>
        lines.map((line) => {
          const style = getComputedStyle(line);
          return (
            line.getBoundingClientRect().height / parseFloat(style.lineHeight)
          );
        }),
      );
    for (const lines of metaHeights) expect(lines).toBeLessThan(1.5);

    // M-2: snapping keeps the 16 px gutter at the start of the row.
    const row = page.locator(
      '[data-slot="listing-header"] nav:not([aria-label="Breadcrumb"]) > ul',
    );
    await expect(row).toHaveCSS("scroll-padding-left", "16px");

    // M-1: the display face sets lining figures.
    await expect(cards(page).first().locator("h3")).toHaveCSS(
      "font-variant-numeric",
      /lining-nums/,
    );
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test("the filter sheet's main action spans the row", async ({ page }) => {
    await serveImages(page);
    await page.goto(`${LISTING_MAIN_PATH}?cct=3000`);
    const open = page.getByRole("button", { name: /^Filters/ });
    await waitForHydration(open);
    await open.click();
    const sheet = page.locator('[data-slot="filter-sheet"]');
    const show = sheet.getByRole("button", { name: /^Show \d+ products?$/ });
    await expect(show).toBeVisible();
    const box = await show.boundingBox();
    // 360 minus the gutters and "Clear all" beside it: well over half.
    expect(box?.width ?? 0).toBeGreaterThan(200);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await axeViolations(page)).toEqual([]);
  });
});

test.describe("listing toolbar at 1280", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("one visible Clear all, and the sort select uses the site chevron", async ({
    page,
  }) => {
    await serveImages(page);
    await page.goto(`${LISTING_MAIN_PATH}?cct=3000`);
    await expect(
      page.getByRole("link", { name: "Clear all", exact: true }),
    ).toHaveCount(1);
    const select = page.getByLabel("Sort by");
    await expect(select).toHaveCSS("appearance", "none");
    const html = await page.content();
    for (const token of LISTING_RESTRICTED_TOKENS) {
      expect(html).not.toContain(token);
    }
  });
});

for (const width of [360, 1280]) {
  test.describe(`area band at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("full bleed with the photo, solid ink without; axe clean", async ({
      page,
    }) => {
      await serveImages(page);
      await page.goto(GALLERY_PATH);
      const band = page.locator('[data-slot="area-band"]');
      await expect(band).toHaveAttribute("data-media", "photo");
      const box = await band.boundingBox();
      expect(box?.x).toBe(0);
      expect(box?.width).toBe(width);
      await expect(
        band.getByRole("heading", {
          level: 1,
          name: AREA_PAGES.gallery.name,
        }),
      ).toBeVisible();
      expect(await horizontalOverflow(page)).toBe(0);
      expect(await axeViolations(page)).toEqual([]);
      const html = await page.content();
      for (const token of AREA_RESTRICTED_TOKENS) {
        expect(html).not.toContain(token);
      }

      await page.goto(LOBBY_PATH);
      await expect(band).toHaveAttribute("data-media", "none");
      await expect(band.locator("img")).toHaveCount(0);
      await expect(
        band.getByRole("heading", { level: 1, name: AREA_PAGES.lobby.name }),
      ).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
    });
  });
}

test.describe("/areas at 1280", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("every tile row reaches the grid's right edge (no hole)", async ({
    page,
  }) => {
    await serveImages(page);
    await page.goto("/areas");
    const grid = page.locator('[data-slot="area-tiles"]');
    await expect(grid).toBeVisible();
    const gaps = await grid.evaluate((list) => {
      const right = Math.round(list.getBoundingClientRect().right);
      const rows = new Map<number, number>();
      for (const tile of list.querySelectorAll('[data-slot="area-tile"]')) {
        const rect = tile.getBoundingClientRect();
        const top = Math.round(rect.top);
        rows.set(top, Math.max(rows.get(top) ?? 0, Math.round(rect.right)));
      }
      return [...rows.values()].map((rowRight) => right - rowRight);
    });
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) expect(Math.abs(gap)).toBeLessThanOrEqual(1);
  });
});
