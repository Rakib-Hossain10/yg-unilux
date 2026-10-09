// Phase 4b L6: the header's product mega-menu, the small-screen nested
// categories, the search overlay and the /search page, on the production
// build with the listing fixtures (seeded by e2e/test-server.ts).
//   mega-menu: keyboard open (focus moves in), Escape closes and returns
//   focus, scrim / outside press / Tab-out close it, a category without a
//   published product (Surface) is hidden, a link navigates and closes;
//   mobile: nested disclosures;
//   overlay: Escape returns focus, type-ahead by a variant model no. (any
//   case) → arrow + Enter lands on the product with ?model= selecting that
//   variant, Enter without an option opens /search;
//   /search works without JavaScript; axe clean. Never `networkidle`.
// Listing pages render on request, so the header there always has the menu
// (statically prerendered pages were built without a database).

import { expect, type Page, test } from "@playwright/test";

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

/* Product 1 has two variants: …-A and …-B (fixtures/listing-pages.ts). */
const VARIANT_B = "LS-1-FX1-B";
const PRODUCT_1_SLUG = "e2e-listing-1-fx1";

const menuButton = (page: Page) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("button", {
    name: "Product",
  });
const panel = (page: Page) => page.locator('[data-slot="mega-menu-panel"]');
const searchButton = (page: Page) =>
  page.locator('[data-slot="search-trigger"]');
const overlay = (page: Page) => page.locator('[data-slot="search-overlay"]');

async function openListing(page: Page, path = LISTING_MAIN_PATH) {
  await serveImages(page);
  await page.goto(path);
  await waitForHydration(menuButton(page));
}

test.describe("mega-menu (1280)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("keyboard: Enter opens and focuses inside, Escape closes and returns focus", async ({
    page,
  }) => {
    await openListing(page);
    const button = menuButton(page);
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(panel(page)).toBeHidden();

    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator("a[href]").first()).toBeFocused();

    // Focusing a category shows its sub-categories; empty ones are hidden.
    const main = panel(page).getByRole("link", {
      name: LISTING.main.name,
      exact: true,
    });
    await main.focus();
    await expect(main).toHaveAttribute("href", LISTING_MAIN_PATH);
    const recessed = panel(page).getByRole("link", {
      name: LISTING.recessed.name,
      exact: true,
    });
    await expect(recessed).toHaveAttribute("href", LISTING_RECESSED_PATH);
    // Tab goes from the category into its own block: "View all", then
    // its sub-categories.
    await page.keyboard.press("Tab");
    await expect(
      panel(page).getByRole("link", { name: `View all ${LISTING.main.name}` }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(recessed).toBeFocused();
    // A sub-category without a published product (Surface) is hidden.
    await expect(panel(page).getByText(LISTING.surface.name)).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(button).toBeFocused();
  });

  test("a press on the scrim, outside, or Tab past the end closes it", async ({
    page,
  }) => {
    await openListing(page);
    const button = menuButton(page);

    await button.click();
    await expect(panel(page)).toBeVisible();
    const scrim = page.locator('[data-slot="mega-menu-scrim"]');
    await expect(scrim).toBeVisible();
    // Below the panel: the dimmed page.
    const box = await panel(page).boundingBox();
    await page.mouse.click(640, (box?.y ?? 0) + (box?.height ?? 0) + 40);
    await expect(panel(page)).toBeHidden();
    await expect(scrim).toBeHidden();

    // A press on blank header space outside the menu (left of the search
    // icon) closes it and navigates nowhere.
    await button.click();
    await expect(panel(page)).toBeVisible();
    const icon = await searchButton(page).boundingBox();
    await page.mouse.click(
      (icon?.x ?? 0) - 40,
      (icon?.y ?? 0) + (icon?.height ?? 0) / 2,
    );
    await expect(page).toHaveURL(new RegExp(`${LISTING_MAIN_PATH}$`));
    await expect(panel(page)).toBeHidden();

    // Tab out of the last link closes it.
    await page.goto(LISTING_MAIN_PATH);
    await waitForHydration(menuButton(page));
    await menuButton(page).click();
    await panel(page).getByRole("link", { name: "All products" }).focus();
    await page.keyboard.press("Tab");
    await expect(panel(page)).toBeHidden();
  });

  test("a sub-category link navigates and closes the menu", async ({
    page,
  }) => {
    await openListing(page, "/products");
    await menuButton(page).click();
    const main = panel(page).getByRole("link", {
      name: LISTING.main.name,
      exact: true,
    });
    await main.hover();
    const recessed = panel(page).getByRole("link", {
      name: LISTING.recessed.name,
      exact: true,
    });
    await recessed.click();
    await expect(page).toHaveURL(new RegExp(`${LISTING_RECESSED_PATH}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: LISTING.recessed.name }),
    ).toBeVisible();
    await expect(panel(page)).toBeHidden();
  });

  test("axe clean with the menu open", async ({ page }) => {
    await openListing(page);
    await menuButton(page).click();
    await expect(panel(page)).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
});

test.describe("mega-menu on a touch screen at desktop width", () => {
  test.use({ viewport: { width: 1280, height: 900 }, hasTouch: true });

  test("the first tap on another category shows it, the second follows", async ({
    page,
  }) => {
    await openListing(page, "/products");
    await menuButton(page).tap();
    await expect(panel(page)).toBeVisible();
    const id = await panel(page)
      .locator("[data-menu-category]:not([data-active])")
      .first()
      .getAttribute("data-menu-category");
    const other = panel(page).locator(`[data-menu-category="${id}"]`);
    const href = await other.getAttribute("href");
    await other.tap();
    await expect(other).toHaveAttribute("data-active", "");
    await expect(page).toHaveURL(/\/products$/);
    await other.tap();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });
});

test.describe("small-screen menu (360)", () => {
  test.use({ viewport: { width: 360, height: 760 } });

  test("Product nests the categories; a sub-category link navigates", async ({
    page,
  }) => {
    await serveImages(page);
    await page.goto("/products");
    const toggle = page.locator("summary[aria-label=Menu]");
    await waitForHydration(toggle);
    await toggle.click();
    const nav = page.locator('[data-slot="mobile-nav"]');
    await expect(nav).toBeVisible();
    await nav.locator('[data-slot="mobile-products"] > summary').click();
    await nav.getByText(LISTING.main.name, { exact: true }).click();
    await expect(nav.getByText(LISTING.surface.name)).toHaveCount(0);
    await nav
      .getByRole("link", { name: LISTING.recessed.name, exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`${LISTING_RECESSED_PATH}$`));
    await expect(nav).toBeHidden();
    expect(await horizontalOverflow(page)).toBe(0);
  });
});

test.describe("search overlay", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("opens from the icon, Escape closes and returns focus", async ({
    page,
  }) => {
    await openListing(page);
    const trigger = searchButton(page);
    await waitForHydration(trigger);
    await trigger.focus();
    await page.keyboard.press("Enter");
    const input = overlay(page).getByRole("combobox", {
      name: "Search products",
    });
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("maxlength", "64");
    await page.keyboard.press("Escape");
    await expect(overlay(page)).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("a variant model no. (any case) → arrow + Enter opens that variant", async ({
    page,
  }) => {
    await openListing(page);
    await waitForHydration(searchButton(page));
    await searchButton(page).click();
    const input = overlay(page).getByRole("combobox");
    const answered = page.waitForResponse((r) =>
      r.url().includes("/api/catalog/search?q="),
    );
    await input.fill(VARIANT_B.toLowerCase());
    await answered;
    const listbox = overlay(page).getByRole("listbox");
    const option = listbox.getByRole("option", {
      name: new RegExp(listingName(1)),
    });
    await expect(option).toHaveAttribute(
      "href",
      `/product/${PRODUCT_1_SLUG}?model=${VARIANT_B}`,
    );
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await expect(
      overlay(page).locator('[data-slot="search-status"]'),
    ).toContainText(/1 product/);
    // No restricted value in the overlay.
    const html = await overlay(page).innerHTML();
    for (const token of LISTING_RESTRICTED_TOKENS) {
      expect(html).not.toContain(token);
    }
    expect(await axeViolations(page)).toEqual([]);

    await page.keyboard.press("ArrowDown");
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      (await option.getAttribute("id")) ?? "",
    );
    await expect(option).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(
      new RegExp(`/product/${PRODUCT_1_SLUG}\\?model=${VARIANT_B}$`),
    );
    await expect(
      page.locator('[data-slot="quick-spec-panel"] [data-field="model-no"]'),
    ).toHaveText(VARIANT_B);
  });

  test("Enter without an active option opens the results page", async ({
    page,
  }) => {
    await openListing(page);
    await waitForHydration(searchButton(page));
    await searchButton(page).click();
    const input = overlay(page).getByRole("combobox");
    await input.fill("Listing 0");
    await input.press("Enter");
    await expect(page).toHaveURL(/\/search\?q=Listing%200$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Search" }),
    ).toBeVisible();
    await expect(page.locator("[data-product-card]").first()).toBeVisible();
  });
});

test.describe("/search without JavaScript", () => {
  test("the header link and the GET form find a variant by model no.", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 360, height: 800 },
    });
    const page = await context.newPage();
    await page.goto("/products");
    await page.getByRole("link", { name: "Search" }).click();
    await expect(page).toHaveURL(/\/search$/);
    const input = page.getByRole("searchbox", { name: "Search products" });
    await input.fill(VARIANT_B.toLowerCase());
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/\/search\?q=ls-1-fx1-b$/);
    const card = page.locator(`[data-product-card]`).first();
    await expect(card).toHaveAttribute(
      "href",
      `/product/${PRODUCT_1_SLUG}?model=${VARIANT_B}`,
    );
    await expect(card).toContainText(VARIANT_B);
    const html = await page.content();
    for (const token of LISTING_RESTRICTED_TOKENS) {
      expect(html).not.toContain(token);
    }
    expect(html).not.toContain(LISTING.draftName);
    expect(await horizontalOverflow(page)).toBe(0);
    await context.close();
  });

  test("noindex and axe clean at 360 and 1280", async ({ page }) => {
    await serveImages(page);
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/search?q=listing");
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        "content",
        /noindex/,
      );
      await expect(page.locator("[data-product-card]").first()).toBeVisible();
      expect(await axeViolations(page), `width ${width}`).toEqual([]);
    }
  });
});
