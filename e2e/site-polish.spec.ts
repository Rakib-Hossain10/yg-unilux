// Phase 4b Q8 polish (4a open list, ADR 0064 §25):
//   - the product page's Models table is stacked at 360 px (no sideways
//     scroll, still a table for assistive tech, "Select" still works) and a
//     plain table from md;
//   - the small-screen menu dims the page with a scrim that closes it on a
//     press and holds the page still behind it;
//   - footer links are 44 px tall, and pages not built yet are never
//     prefetched.
// Never `networkidle`.

import { expect, type Page, test } from "@playwright/test";

import {
  axeViolations,
  gotoAndWaitForRestricted,
  horizontalOverflow,
  serveImages,
  waitForHydration,
} from "./fixtures/product-page-helpers";
import { EXIT } from "./fixtures/product-pages";
import { FOOTER_NAV } from "../src/components/site/nav-links";

const PAGE = `/product/${EXIT.slug}`;

const models = (page: Page) => page.locator("#models");

test.describe("Models table", () => {
  test.describe("at 360 px", () => {
    test.use({
      viewport: { width: 360, height: 780 },
      isMobile: true,
      hasTouch: true,
      // The scroll reveals and the value crossfade are covered elsewhere;
      // here axe should see the settled page.
      reducedMotion: "reduce",
    });

    test("is stacked, readable and still a table", async ({ page }) => {
      await serveImages(page);
      await gotoAndWaitForRestricted(page, PAGE);
      await models(page).scrollIntoViewIfNeeded();

      // No sideways scroll on the page or inside the table's box.
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      const box = models(page).locator('[data-slot="models-scroll"]');
      expect(
        await box.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);

      // Each model is its own block, every cell inside the viewport.
      const row = models(page).locator('tr[data-variant-index="1"]');
      await expect(row).toHaveCSS("display", "grid");
      const cells = row.locator("th, td");
      for (let i = 0; i < (await cells.count()); i += 1) {
        const rect = await cells.nth(i).boundingBox();
        expect(rect, `cell ${i}`).not.toBeNull();
        expect(rect!.x).toBeGreaterThanOrEqual(0);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(361);
      }
      // A visible label beside each value; the column header row is
      // visually hidden.
      await expect(
        row.locator("td span[aria-hidden=true]").first(),
      ).toBeVisible();
      await expect(models(page).locator("thead")).toHaveCSS(
        "position",
        "absolute",
      );

      // Assistive tech still reads a table with rows and headers.
      const table = models(page).getByRole("table");
      await expect(table).toHaveCount(1);
      await expect(
        table.getByRole("rowheader", { name: EXIT.v2 }),
      ).toBeVisible();
      expect(await table.getByRole("row").count()).toBeGreaterThanOrEqual(3);
      expect(await table.getByRole("columnheader").count()).toBeGreaterThan(2);

      // "Select" is a 44 px target on the model's first line and selects it.
      const select = row.getByRole("button", { name: `Select ${EXIT.v2}` });
      await waitForHydration(select);
      const rowRect = (await row.boundingBox())!;
      const selectRect = (await select.boundingBox())!;
      expect(selectRect.height).toBeGreaterThanOrEqual(44);
      expect(selectRect.y - rowRect.y).toBeLessThan(24);
      await select.click();
      await expect(row).toHaveAttribute("data-selected", "");
      await expect(page.locator("#variant-option-1")).toBeChecked();
      await expect(page.locator(".value-crossfade-old")).toHaveCount(0);

      expect(await axeViolations(page)).toEqual([]);
    });
  });

  test("is a plain table with a header row from md", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await serveImages(page);
    await gotoAndWaitForRestricted(page, PAGE);
    await models(page).scrollIntoViewIfNeeded();
    const row = models(page).locator('tr[data-variant-index="1"]');
    await expect(row).toHaveCSS("display", "table-row");
    await expect(models(page).locator("thead")).toBeVisible();
    await expect(models(page).locator("thead")).not.toHaveCSS(
      "position",
      "absolute",
    );
    await expect(row.locator("td span[aria-hidden=true]").first()).toBeHidden();
  });
});

test.describe("small-screen menu scrim", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const open = async (page: Page) => {
    await page.goto("/");
    const toggle = page.locator("summary[aria-label=Menu]");
    await waitForHydration(
      page.locator("header details[data-slot=mobile-menu]"),
    );
    await toggle.click();
    await expect(
      page.locator("header details[data-slot=mobile-menu]"),
    ).toHaveAttribute("open", "");
  };

  test("dims the page below the header and holds it still", async ({
    page,
  }) => {
    await open(page);
    const scrim = page.locator('[data-slot="mobile-menu-scrim"]');
    await expect(scrim).toBeVisible();
    await expect(scrim).toHaveAttribute("aria-hidden", "true");
    const rect = (await scrim.boundingBox())!;
    expect(rect.y).toBeCloseTo(64, 0);
    expect(rect.width).toBeCloseTo(390, 0);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(844);
    await expect(page.locator("html")).toHaveCSS("overflow-y", "hidden");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    // The panel sits above the scrim.
    await expect(page.locator('[data-slot="mobile-nav"]')).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });

  test("a press on the scrim closes the menu and frees the page", async ({
    page,
  }) => {
    await open(page);
    // Below the panel (its height is its content), on the scrim.
    const nav = (await page.locator('[data-slot="mobile-nav"]').boundingBox())!;
    await page.mouse.click(200, Math.min(nav.y + nav.height + 40, 830));
    await expect(
      page.locator("header details[data-slot=mobile-menu]"),
    ).not.toHaveAttribute("open", "");
    await expect(page.locator('[data-slot="mobile-menu-scrim"]')).toBeHidden();
    await expect(page.locator("html")).not.toHaveCSS("overflow-y", "hidden");
  });

  test.describe("with reduced motion", () => {
    test.use({ reducedMotion: "reduce" });

    test("the scrim appears at once", async ({ page }) => {
      await open(page);
      const scrim = page.locator('[data-slot="mobile-menu-scrim"]');
      await expect(scrim).toHaveCSS("opacity", "1");
      expect(
        await scrim.evaluate((el) =>
          parseFloat(getComputedStyle(el).transitionDuration),
        ),
      ).toBeLessThanOrEqual(0.01);
    });
  });
});

test.describe("footer links", () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test("are 44 px touch targets in two columns, with no page overflow", async ({
    page,
  }) => {
    await page.goto("/");
    const links = page.locator("footer nav a");
    const total = FOOTER_NAV.reduce((n, c) => n + c.links.length, 0);
    await expect(links).toHaveCount(total);
    for (let i = 0; i < total; i += 1) {
      const rect = (await links.nth(i).boundingBox())!;
      expect(
        rect.height,
        await links.nth(i).innerText(),
      ).toBeGreaterThanOrEqual(44);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test("never prefetch a page that is not built", async ({ page }) => {
    const unbuilt = new Set(
      FOOTER_NAV.flatMap((c) => c.links)
        .filter((link) => link.prefetch === false)
        .map((link) => link.href),
    );
    const prefetched: string[] = [];
    page.on("request", (request) => {
      const headers = request.headers();
      if (!("rsc" in headers || "next-router-prefetch" in headers)) return;
      prefetched.push(new URL(request.url()).pathname);
    });
    await page.goto("/");
    await page.locator("footer").scrollIntoViewIfNeeded();
    // Viewport prefetches run on idle; give them time, then look for the
    // built footer targets as the positive control.
    await expect
      .poll(() => prefetched.includes("/areas"), { timeout: 10_000 })
      .toBe(true);
    expect(prefetched.filter((path) => unbuilt.has(path))).toEqual([]);
  });
});
