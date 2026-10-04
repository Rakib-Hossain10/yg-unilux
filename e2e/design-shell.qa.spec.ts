// QA e2e for the task 11 design shell against a production build: axe
// (WCAG 2.2 AA) on the shell pages, a visible keyboard focus in the ink
// footer, the skip link, the mobile <details> menu and no third-party requests.
// Never waits for "networkidle": Link prefetches of not-yet-built routes
// (404) leave unread response bodies, so it never settles (QA task 11).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

const axeSource = readFileSync(
  join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

const PAGES = ["/", "/qa-route-that-does-not-exist", "/blocked"];

/* WCAG relative luminance from a computed "rgb(r, g, b)" string. */
function lum(rgb: string): number {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 740 },
]) {
  for (const path of PAGES) {
    test(`axe WCAG 2.2 AA: ${path} at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto(path);
      await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async () => {
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
      expect(violations).toEqual([]);
    });
  }
}

test("keyboard focus is visible on the ink footer links", async ({ page }) => {
  await page.goto("/");
  const link = page.locator("footer a").first();
  await link.focus();
  // Re-focus with the keyboard so :focus-visible applies, then let the
  // colour transition finish.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(link).toBeFocused();
  await page.waitForTimeout(400);
  const { outline, background, width } = await link.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      outline: cs.outlineColor,
      width: parseFloat(cs.outlineWidth),
      background: getComputedStyle(el.closest("footer")!).backgroundColor,
    };
  });
  expect(width).toBeGreaterThanOrEqual(2);
  // WCAG 1.4.11: the indicator needs 3:1 against the adjacent colour.
  expect(ratio(outline, background)).toBeGreaterThanOrEqual(3);
});

test("the skip link is the first tab stop and becomes visible", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
});

test("mobile menu: native disclosure with the five sections", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/");
  const summary = page.locator("header summary");
  await expect(summary).toHaveAccessibleName("Menu");
  await summary.focus();
  await page.keyboard.press("Enter");
  const menu = page.locator("header details nav");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link")).toHaveText([
    "Product",
    "Services",
    "OEM/ODM",
    "R&D",
    "About us",
  ]);
});

test("no horizontal scroll at 320px (WCAG 1.4.10 reflow)", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  for (const path of PAGES) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});

test("shell pages make no third-party requests", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.protocol.startsWith("http") && url.origin !== origin)
      foreign.push(r.url());
  });
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState("load");
  }
  expect(foreign).toEqual([]);
});
