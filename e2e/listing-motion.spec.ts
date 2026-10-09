// Phase 4b L7: the listing + header motion pass. Motion is an enhancement:
//   - card -> product: the card's frame and the product stage share one
//     view-transition name and morph (no-preference);
//   - a filter or chip change settles the results in on the LIVE element
//     (no view-transition snapshot, so a card stays clickable with the mouse
//     right after the change); reduced motion and the mobile sheet swap at
//     once;
//   - mega-menu panel fades/drops in and fades out; reduced motion shows and
//     hides it at once;
//   - search overlay fades in/out, the page behind it does not scroll, the
//     lock lifts on close;
//   - a long facet (12 CCT values) shows 6 + "Show 6 more", with and without
//     JavaScript, and stays open once a hidden value is applied;
//   - leaving and coming back leaks no document listeners; no console errors.
// Never `networkidle`.

import { type Browser, expect, type Page, test } from "@playwright/test";

import { LISTING_MOTION, LISTING_MOTION_PATH } from "./fixtures/listing-motion";
import {
  LISTING,
  LISTING_RECESSED_PATH,
  listingName,
} from "./fixtures/listing-pages";
import { serveImages, waitForHydration } from "./fixtures/product-page-helpers";

test.describe.configure({ mode: "serial" });

type VtRecord = { refine: boolean; pseudos: string[] };

/*
 * Before any script: records every view transition (whether the refine
 * mark was on <html>, and, once it
 * is ready, the pseudo-elements that animate), document listener balance,
 * and console errors.
 */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const vts: { refine: boolean; pseudos: string[] }[] = [];
    const listeners = new Map<string, number>();
    const settles: number[] = [];
    w.__l7 = { vts, listeners, settles };

    // Every results settle-in (a Web Animation on the live results).
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (
      this: Element,
      ...args: Parameters<Element["animate"]>
    ) {
      const options = args[1];
      if (typeof options === "object" && options?.id === "listing-results-in") {
        settles.push(performance.now());
      }
      return animate.apply(this, args);
    };

    const start = document.startViewTransition?.bind(document);
    if (start) {
      document.startViewTransition = ((arg?: unknown) => {
        const record = {
          refine: document.documentElement.hasAttribute("data-listing-refine"),
          pseudos: [] as string[],
        };
        vts.push(record);
        const transition = start(arg as never);
        void transition.ready
          .then(() => {
            for (const animation of document.getAnimations()) {
              const effect = animation.effect as KeyframeEffect | null;
              if (effect?.pseudoElement) {
                record.pseudos.push(
                  `${effect.pseudoElement}|${effect.getComputedTiming().duration}`,
                );
              }
            }
          })
          .catch(() => {});
        return transition;
      }) as typeof document.startViewTransition;
    }

    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    document.addEventListener = ((
      ...args: Parameters<typeof document.addEventListener>
    ) => {
      listeners.set(args[0], (listeners.get(args[0]) ?? 0) + 1);
      return add(...args);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((
      ...args: Parameters<typeof document.removeEventListener>
    ) => {
      listeners.set(args[0], (listeners.get(args[0]) ?? 0) - 1);
      return remove(...args);
    }) as typeof document.removeEventListener;
  });
}

const viewTransitions = (page: Page): Promise<VtRecord[]> =>
  page.evaluate(() =>
    (window as unknown as { __l7: { vts: VtRecord[] } }).__l7.vts.map((v) => ({
      refine: v.refine,
      pseudos: [...v.pseudos],
    })),
  );

const settleCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (window as unknown as { __l7: { settles: number[] } }).__l7.settles
        .length,
  );

const documentListeners = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(() =>
    Object.fromEntries(
      (window as unknown as { __l7: { listeners: Map<string, number> } }).__l7
        .listeners,
    ),
  );

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.text().startsWith("Failed to load resource")) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function newPage(
  browser: Browser,
  reduced: boolean,
  viewport = { width: 1280, height: 900 },
) {
  const context = await browser.newContext({
    reducedMotion: reduced ? "reduce" : "no-preference",
    viewport,
  });
  const page = await context.newPage();
  await instrument(page);
  await serveImages(page);
  const errors = watchErrors(page);
  return { context, page, errors };
}

const rail = (page: Page) => page.locator('[data-slot="filter-rail"]');
const grid = (page: Page) => page.locator('[data-slot="listing-grid"]');
const count = (page: Page) => page.locator('[data-slot="result-count"]');
const menuButton = (page: Page) =>
  page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: "Product" });
const panel = (page: Page) => page.locator('[data-slot="mega-menu-panel"]');
const overlay = (page: Page) => page.locator('[data-slot="search-overlay"]');
const searchButton = (page: Page) =>
  page.locator('[data-slot="search-trigger"]');

/** Animations with a real duration still running inside `selector`. */
const runningIn = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return [];
    return root
      .getAnimations({ subtree: true })
      .filter(
        (a) =>
          a.playState === "running" &&
          Number(a.effect?.getComputedTiming().duration) > 1,
      )
      .map((a) =>
        "animationName" in a
          ? String((a as CSSAnimation).animationName)
          : String((a as CSSTransition).transitionProperty),
      );
  }, selector);

test.describe("card -> product morph", () => {
  test("the card frame and the product stage morph as one element", async ({
    browser,
  }) => {
    const { context, page, errors } = await newPage(browser, false);
    await page.goto(LISTING_RECESSED_PATH);
    const card = page.getByRole("link", { name: new RegExp(listingName(1)) });
    await waitForHydration(card);
    const id = await card.getAttribute("data-product-card");
    expect(id).toBeTruthy();
    // The product page is prefetched (static), so it renders in the same
    // commit as the navigation and the pair forms.
    const prefetched = page.waitForResponse(
      (r) => r.url().includes("/product/e2e-listing-1-fx1") && r.ok(),
    );
    await card.hover();
    await prefetched.catch(() => {});
    await card.click();
    await expect(page).toHaveURL(/\/product\/e2e-listing-1-fx1$/);
    await expect
      .poll(async () =>
        (await viewTransitions(page)).some((v) =>
          v.pseudos.some((p) =>
            p.startsWith(`::view-transition-group(product-image-${id})|`),
          ),
        ),
      )
      .toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("reduced motion: the navigation swaps at once", async ({ browser }) => {
    const { context, page, errors } = await newPage(browser, true);
    await page.goto(LISTING_RECESSED_PATH);
    const card = page.getByRole("link", { name: new RegExp(listingName(1)) });
    await waitForHydration(card);
    await card.click();
    await expect(page).toHaveURL(/\/product\/e2e-listing-1-fx1$/);
    await expect(page.locator('[data-slot="product-gallery"]')).toBeVisible();
    for (const vt of await viewTransitions(page)) {
      for (const pseudo of vt.pseudos) {
        expect(Number(pseudo.split("|")[1]), pseudo).toBeLessThanOrEqual(1);
      }
    }
    expect(errors).toEqual([]);
    await context.close();
  });
});

test.describe("filter result settle-in", () => {
  test("a filter change settles the live results in; focus stays", async ({
    browser,
  }) => {
    const { context, page, errors } = await newPage(browser, false);
    await page.goto(LISTING_RECESSED_PATH);
    const box = rail(page).getByRole("checkbox", { name: /^3000K/ });
    await waitForHydration(box);
    await box.check();
    await expect(page).toHaveURL(/\?cct=3000$/);
    await expect(count(page)).toHaveText(
      `${LISTING.cct3000} of ${LISTING.count} products`,
    );
    await expect(box).toBeFocused();
    await expect.poll(() => settleCount(page)).toBe(1);
    // Nothing is captured into a snapshot during a refinement: not the root,
    // not the results, not a card (captured elements are not hit-testable).
    for (const vt of (await viewTransitions(page)).filter((v) => v.refine)) {
      expect(vt.pseudos).toEqual([]);
    }
    // A chip removal settles in too.
    await page.getByRole("link", { name: "Remove filter CCT 3000K" }).click();
    await expect(count(page)).toHaveText(`${LISTING.count} products`);
    await expect.poll(() => settleCount(page)).toBe(2);
    for (const vt of (await viewTransitions(page)).filter((v) => v.refine)) {
      expect(vt.pseudos).toEqual([]);
    }
    // Once settled, nothing stays on the results.
    await expect(grid(page)).toHaveCSS("opacity", "1");
    expect(errors).toEqual([]);
    await context.close();
  });

  test("a card is clickable with the mouse right after a filter change", async ({
    browser,
  }) => {
    const { context, page, errors } = await newPage(browser, false);
    await page.goto(LISTING_RECESSED_PATH);
    const box = rail(page).getByRole("checkbox", { name: /^3000K/ });
    await waitForHydration(box);
    await box.check();
    // QA regression: during the old snapshot crossfade a mouse click on a
    // card in the first ~0.4 s hit the grid container and was lost. No wait
    // on data-listing-refine or the settle-in: the first refined card is
    // clicked as soon as it is in the DOM, while the settle-in still runs.
    await expect(count(page)).toHaveText(
      `${LISTING.cct3000} of ${LISTING.count} products`,
    );
    const card = grid(page).locator("[data-product-card]").first();
    const href = await card.getAttribute("href");
    expect(href).toBeTruthy();
    const rect = await card.boundingBox();
    expect(rect).toBeTruthy();
    const x = rect!.x + rect!.width / 2;
    const y = rect!.y + rect!.height / 2;
    // The point hit-tests to the card itself, not a container above it.
    expect(
      await page.evaluate(
        ([px, py]) =>
          Boolean(
            document.elementFromPoint(px!, py!)?.closest("[data-product-card]"),
          ),
        [x, y],
      ),
    ).toBe(true);
    await page.mouse.click(x, y);
    await expect(page).toHaveURL(new RegExp(`${href!.split("?")[0]}`));
    expect(errors).toEqual([]);
    await context.close();
  });

  test("reduced motion: no animation, results still update", async ({
    browser,
  }) => {
    const { context, page, errors } = await newPage(browser, true);
    await page.goto(LISTING_RECESSED_PATH);
    const box = rail(page).getByRole("checkbox", { name: /^3000K/ });
    await waitForHydration(box);
    await box.check();
    await expect(count(page)).toHaveText(
      `${LISTING.cct3000} of ${LISTING.count} products`,
    );
    await expect(grid(page).locator("li")).toHaveCount(LISTING.cct3000);
    expect((await viewTransitions(page)).filter((v) => v.refine)).toEqual([]);
    expect(await settleCount(page)).toBe(0);
    await expect(grid(page)).toHaveCSS("opacity", "1");
    expect(errors).toEqual([]);
    await context.close();
  });

  test("the mobile filter sheet swaps the results at once", async ({
    browser,
  }) => {
    const { context, page, errors } = await newPage(browser, false, {
      width: 390,
      height: 844,
    });
    await page.goto(LISTING_RECESSED_PATH);
    const open = page.getByRole("button", { name: /^Filters/ });
    await waitForHydration(open);
    await open.click();
    const sheet = page.locator('[data-slot="filter-sheet"]');
    await sheet.getByRole("checkbox", { name: /^3000K/ }).check();
    await expect(page).toHaveURL(/\?cct=3000$/);
    await expect(sheet).toBeVisible();
    expect((await viewTransitions(page)).filter((v) => v.refine)).toEqual([]);
    expect(await settleCount(page)).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });
});

test.describe("mega-menu reveal", () => {
  test("fades in and out with motion", async ({ browser }) => {
    const { context, page, errors } = await newPage(browser, false);
    await page.goto(LISTING_RECESSED_PATH);
    await waitForHydration(menuButton(page));
    await menuButton(page).click();
    await expect(panel(page)).toBeVisible();
    await expect
      .poll(() => runningIn(page, '[data-slot="mega-menu"]'))
      .not.toEqual([]);
    await expect(panel(page)).toHaveCSS("opacity", "1");
    await expect
      .poll(() => runningIn(page, '[data-slot="mega-menu"]'))
      .toEqual([]);
    await page.keyboard.press("Escape");
    await expect(menuButton(page)).toBeFocused();
    await expect(panel(page)).toBeHidden();
    expect(errors).toEqual([]);
    await context.close();
  });

  test("reduced motion: appears and disappears at once", async ({
    browser,
  }) => {
    const { context, page, errors } = await newPage(browser, true);
    await page.goto(LISTING_RECESSED_PATH);
    await waitForHydration(menuButton(page));
    await menuButton(page).click();
    await expect(panel(page)).toBeVisible();
    expect(await runningIn(page, '[data-slot="mega-menu"]')).toEqual([]);
    expect(
      await panel(page).evaluate((el) => getComputedStyle(el).opacity),
    ).toBe("1");
    await page.keyboard.press("Escape");
    expect(
      await panel(page).evaluate((el) => getComputedStyle(el).display),
    ).toBe("none");
    expect(errors).toEqual([]);
    await context.close();
  });
});

test.describe("search overlay", () => {
  for (const reduced of [false, true]) {
    test(`opens, locks the page scroll, closes (reduced: ${reduced})`, async ({
      browser,
    }) => {
      const { context, page, errors } = await newPage(browser, reduced);
      await page.goto(LISTING_RECESSED_PATH);
      await waitForHydration(searchButton(page));
      await page.evaluate(() => window.scrollTo(0, 300));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(300);
      await searchButton(page).click();
      await expect(overlay(page)).toBeVisible();
      await expect(page.locator("html")).toHaveCSS("overflow", "hidden");
      if (reduced) {
        expect(await runningIn(page, '[data-slot="search-overlay"]')).toEqual(
          [],
        );
      }
      await expect(overlay(page)).toHaveCSS("opacity", "1");
      // The page under the modal does not move.
      await page.mouse.move(640, 800);
      await page.mouse.wheel(0, 600);
      await page.keyboard.press("End");
      expect(await page.evaluate(() => window.scrollY)).toBe(300);

      await page.keyboard.press("Escape");
      await expect(searchButton(page)).toBeFocused();
      await expect(overlay(page)).toBeHidden();
      await expect(page.locator("html")).not.toHaveCSS("overflow", "hidden");
      expect(await page.evaluate(() => window.scrollY)).toBe(300);
      expect(errors).toEqual([]);
      await context.close();
    });
  }
});

test.describe("long facet collapse", () => {
  const MORE = LISTING_MOTION.ccts.length - 6;
  const hiddenK = LISTING_MOTION.ccts[9]!;

  test("shows 6 values + 'Show n more'; a hidden value applied keeps it open", async ({
    browser,
  }) => {
    const { context, page, errors } = await newPage(browser, false);
    await page.goto(LISTING_MOTION_PATH);
    const summary = rail(page).getByText(`Show ${MORE} more`);
    await waitForHydration(rail(page).getByRole("checkbox").first());
    // Every value is a box in the form; only 6 are shown.
    await expect(rail(page).locator('input[type="checkbox"]')).toHaveCount(
      LISTING_MOTION.ccts.length,
    );
    await expect(rail(page).getByRole("checkbox")).toHaveCount(6);
    const hiddenBox = rail(page).getByRole("checkbox", {
      name: new RegExp(`^${hiddenK}K`),
      includeHidden: true,
    });
    await expect(hiddenBox).toBeHidden();
    await expect(summary).toBeVisible();
    await summary.click();
    await expect(hiddenBox).toBeVisible();
    await expect(rail(page).getByText("Show fewer")).toBeVisible();
    await hiddenBox.check();
    await expect(page).toHaveURL(new RegExp(`\\?cct=${hiddenK}$`));
    await expect(count(page)).toHaveText(
      `1 of ${LISTING_MOTION.ccts.length} products`,
    );
    await expect(hiddenBox).toBeVisible();
    await expect(hiddenBox).toBeChecked();

    // A fresh load with the hidden value applied starts open.
    await page.goto(`${LISTING_MOTION_PATH}?cct=${hiddenK}`);
    await expect(
      rail(page).getByRole("checkbox", { name: new RegExp(`^${hiddenK}K`) }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
  });

  test("works without JavaScript", async ({ browser }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      // The settle-in animation of the opened list would keep Playwright's
      // stability check waiting while it scrolls; reduced motion has none.
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(LISTING_MOTION_PATH);
    const box = rail(page).getByRole("checkbox", {
      name: new RegExp(`^${hiddenK}K`),
      includeHidden: true,
    });
    await expect(box).toBeHidden();
    await rail(page).getByText(`Show ${MORE} more`).click();
    await box.check();
    await rail(page).getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(new RegExp(`\\?cct=${hiddenK}$`));
    await expect(count(page)).toHaveText(
      `1 of ${LISTING_MOTION.ccts.length} products`,
    );
    await context.close();
  });
});

test("no leaked document listeners after menu, overlay and navigation", async ({
  browser,
}) => {
  const { context, page, errors } = await newPage(browser, false);
  await page.goto(LISTING_RECESSED_PATH);
  await waitForHydration(menuButton(page));
  await waitForHydration(searchButton(page));
  const baseline = await documentListeners(page);

  await menuButton(page).click();
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await searchButton(page).click();
  await expect(overlay(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toBeHidden();

  // Away to a product and back through the header link.
  await page.getByRole("link", { name: new RegExp(listingName(2)) }).click();
  await expect(page).toHaveURL(/\/product\//);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${LISTING_RECESSED_PATH}$`));
  await expect(grid(page)).toBeVisible();

  const after = await documentListeners(page);
  for (const type of ["keydown", "pointerdown"]) {
    expect(after[type] ?? 0, type).toBeLessThanOrEqual(baseline[type] ?? 0);
  }
  expect(errors).toEqual([]);
  await context.close();
});
