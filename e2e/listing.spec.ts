// Phase 4b L8: the listing exit flow on the production build, with the
// fixtures seeded by e2e/test-server.ts (LISTING, AREA_PAGES, EXIT) and the
// Cloudinary/R2 fakes (images are answered by `serveImages`).
//   1. browse /products → a category → a filter → a product → browser back
//      keeps the filter (URL, box, count) and the scroll position;
//   2. a variant model no. found from the overlay AND the /search page lands
//      on /product/<slug>?model=<modelNo> with that variant shown;
//   3. a keyboard-only run: skip link, header, mega-menu, a filter, a card;
//   4. axe (WCAG 2.2 AA) at 360 and 1280 on /products, a category page and
//      an area page.
// Lighthouse (mobile >= 90 perf/a11y/SEO) runs outside Playwright, against
// the same server (see the L8 report). Never `networkidle`.

import { expect, type Page, test } from "@playwright/test";

import { AREA_RESTRICTED_TOKENS, GALLERY_PATH } from "./fixtures/area-pages";
import {
  LISTING,
  LISTING_MAIN_PATH,
  LISTING_RECESSED_PATH,
  LISTING_RESTRICTED_TOKENS,
} from "./fixtures/listing-pages";
import {
  axeViolations,
  horizontalOverflow,
  serveImages,
  waitForHydration,
} from "./fixtures/product-page-helpers";
import { EXIT, GATE_B_RESTRICTED_TOKENS } from "./fixtures/product-pages";

/* Every seeded restricted value a listing page could show by mistake. */
const RESTRICTED_TOKENS: readonly string[] = [
  ...LISTING_RESTRICTED_TOKENS,
  ...AREA_RESTRICTED_TOKENS,
  ...GATE_B_RESTRICTED_TOKENS,
];

const rail = (page: Page) => page.locator('[data-slot="filter-rail"]');
const count = (page: Page) => page.locator('[data-slot="result-count"]');
const cards = (page: Page) => page.locator("[data-product-card]");
const modelNo = (page: Page) =>
  page.locator('[data-slot="quick-spec-panel"] [data-field="model-no"]');
const menuButton = (page: Page) =>
  page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: "Product" });
const megaPanel = (page: Page) => page.locator('[data-slot="mega-menu-panel"]');
const searchTrigger = (page: Page) =>
  page.locator('[data-slot="search-trigger"]');
const overlay = (page: Page) => page.locator('[data-slot="search-overlay"]');

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

/* Does the focused element match `selector`? */
const focusedIs = (page: Page, selector: string) =>
  page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector);

/* Tabs (keyboard only) until `selector` has focus, which must be visible. */
async function tabUntil(page: Page, selector: string, max = 120) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await focusedIs(page, selector)) {
      expect(
        await page.evaluate(
          () => document.activeElement?.matches(":focus-visible") ?? false,
        ),
        `${selector} focus is visible`,
      ).toBe(true);
      return;
    }
  }
  throw new Error(`${selector} never got focus within ${max} tabs`);
}

test.describe("browse, filter, open, back", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("back from a product keeps the filters and the scroll position", async ({
    page,
  }) => {
    await serveImages(page);
    const first = await page.goto("/products");
    expect(first?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { level: 1, name: "Products" }),
    ).toBeVisible();

    // Browse: the category row inside the page (not the header menu).
    const categoryLink = page
      .locator("main")
      .getByRole("link", { name: LISTING.main.name, exact: true });
    await waitForHydration(categoryLink);
    await categoryLink.click();
    await expect(page).toHaveURL(new RegExp(`${LISTING_MAIN_PATH}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: LISTING.main.name }),
    ).toBeVisible();

    // Filter: a tick narrows the list in place.
    const box = rail(page).getByRole("checkbox", { name: /^3000K/ });
    await waitForHydration(box);
    await box.check();
    const filtered = new RegExp(`${LISTING_MAIN_PATH}\\?cct=3000$`);
    await expect(page).toHaveURL(filtered);
    const filteredCount = `${LISTING.cct3000} of ${LISTING.count} products`;
    await expect(count(page)).toHaveText(filteredCount);
    await expect(cards(page)).toHaveCount(LISTING.cct3000);
    // Let the results crossfade (L7, ~420 ms) finish: while it runs, a
    // pointer over a card hits the grid container, so Playwright's click
    // retries and scrolls the page itself, and the "before" position would
    // be its own, not the visitor's. The <html> mark outlives the crossfade.
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-listing-refine",
    );

    // Scroll down to a card in the last row and open it.
    const target = cards(page).nth(LISTING.cct3000 - 1);
    await target.scrollIntoViewIfNeeded();
    // Settle the position (no smooth-scroll in flight) before reading it.
    await expect.poll(() => scrollY(page)).toBeGreaterThan(300);
    let before = await scrollY(page);
    await expect
      .poll(async () => {
        const now = await scrollY(page);
        const same = now === before;
        before = now;
        return same;
      })
      .toBe(true);
    const href = await target.getAttribute("href");
    expect(href).toMatch(/^\/product\//);
    await target.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(modelNo(page)).toBeVisible();

    // Back: same filtered URL, box still ticked, same count, same place.
    await page.goBack();
    await expect(page).toHaveURL(filtered);
    await expect(count(page)).toHaveText(filteredCount);
    await expect(
      rail(page).getByRole("checkbox", { name: /^3000K/ }),
    ).toBeChecked();
    await expect(cards(page)).toHaveCount(LISTING.cct3000);
    await expect
      .poll(async () => Math.abs((await scrollY(page)) - before), {
        message: `scroll position restored near ${before}px`,
      })
      .toBeLessThanOrEqual(8);
    await expect(target).toBeInViewport();
  });
});

test.describe("search by a variant model no.", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the overlay lands on the product with ?model= selecting that variant", async ({
    page,
  }) => {
    await serveImages(page);
    await page.goto("/products");
    await waitForHydration(searchTrigger(page));
    await searchTrigger(page).click();
    const input = overlay(page).getByRole("combobox", {
      name: "Search products",
    });
    await expect(input).toBeFocused();
    const answered = page.waitForResponse((r) =>
      r.url().includes("/api/catalog/search?q="),
    );
    // The second variant, typed in lower case.
    await input.fill(EXIT.v2.toLowerCase());
    await answered;
    const option = overlay(page)
      .getByRole("listbox")
      .getByRole("option", { name: new RegExp(EXIT.name) });
    await expect(option).toHaveAttribute(
      "href",
      `/product/${EXIT.slug}?model=${EXIT.v2}`,
    );
    await option.click();
    await expect(page).toHaveURL(
      new RegExp(`/product/${EXIT.slug}\\?model=${EXIT.v2}$`),
    );
    await expect(modelNo(page)).toHaveText(EXIT.v2);
  });

  test("the /search page lands on the product with ?model= selecting that variant", async ({
    page,
  }) => {
    await serveImages(page);
    const response = await page.goto(
      `/search?q=${encodeURIComponent(EXIT.v2)}`,
    );
    expect(response?.status()).toBe(200);
    const card = cards(page).first();
    await expect(card).toHaveAttribute(
      "href",
      `/product/${EXIT.slug}?model=${EXIT.v2}`,
    );
    await expect(card).toContainText(EXIT.v2);
    await waitForHydration(card);
    await card.click();
    await expect(page).toHaveURL(
      new RegExp(`/product/${EXIT.slug}\\?model=${EXIT.v2}$`),
    );
    await expect(modelNo(page)).toHaveText(EXIT.v2);
    // The first variant by its own model no. too.
    await page.goto(`/search?q=${encodeURIComponent(EXIT.v1)}`);
    await expect(cards(page).first()).toHaveAttribute(
      "href",
      `/product/${EXIT.slug}?model=${EXIT.v1}`,
    );
  });
});

test.describe("keyboard only", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("skip link, header, mega-menu, a filter and a product card", async ({
    page,
  }) => {
    await serveImages(page);
    await page.goto("/products");
    await waitForHydration(menuButton(page));

    // The first Tab reaches the skip link; it moves focus past the header.
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();

    // Header: Tab to the Product menu button, Enter opens the mega-menu.
    await tabUntil(page, 'nav[aria-label="Main"] button');
    await expect(menuButton(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
    await expect(megaPanel(page)).toBeVisible();
    await expect(megaPanel(page).locator("a[href]").first()).toBeFocused();

    // Tab inside the menu to the listing category, Enter follows it.
    await tabUntil(
      page,
      `[data-slot="mega-menu-panel"] a[href="${LISTING_MAIN_PATH}"]`,
      40,
    );
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${LISTING_MAIN_PATH}$`));
    await expect(megaPanel(page)).toBeHidden();
    await expect(
      page.getByRole("heading", { level: 1, name: LISTING.main.name }),
    ).toBeVisible();

    // Filters: Tab to the IP65 box, Space ticks it, focus stays there.
    const ip65 = rail(page).getByRole("checkbox", { name: /^IP65/ });
    await waitForHydration(ip65);
    await tabUntil(
      page,
      '[data-slot="filter-rail"] input[name="ip"][value="65"]',
    );
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(new RegExp(`${LISTING_MAIN_PATH}\\?ip=65$`));
    await expect(count(page)).toHaveText(
      `${LISTING.ip65} of ${LISTING.count} products`,
    );
    await expect(ip65).toBeFocused();
    await expect(ip65).toBeChecked();

    // A product card: Tab to the first card, Enter opens the product.
    await tabUntil(page, "[data-product-card]");
    const href = await page.evaluate(
      () => document.activeElement?.getAttribute("href") ?? "",
    );
    expect(href).toMatch(/^\/product\//);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(modelNo(page)).toBeVisible();
  });
});

test.describe("accessibility of the listing pages", () => {
  const pages = [
    { name: "/products", path: "/products" },
    { name: "a category page", path: LISTING_RECESSED_PATH },
    { name: "an area page", path: GALLERY_PATH },
  ];
  for (const width of [360, 1280]) {
    for (const { name, path } of pages) {
      test(`axe WCAG 2.2 AA at ${width} px: ${name}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await serveImages(page);
        const response = await page.goto(path);
        expect(response?.status()).toBe(200);
        await waitForHydration(cards(page).first());
        expect(await axeViolations(page)).toEqual([]);
        expect(await horizontalOverflow(page)).toBe(0);
        // No seeded restricted value anywhere on the rendered page.
        const html = await page.content();
        for (const token of RESTRICTED_TOKENS) {
          expect(html, token).not.toContain(token);
        }
      });
    }
  }
});
