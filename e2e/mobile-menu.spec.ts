// The small-screen menu (src/components/site/mobile-menu.tsx) closes on
// Escape, giving focus back to its toggle, and on a press outside (QA M1,
// task 11). The summary has no button role, so it is located directly.

import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("Escape closes the menu and returns focus to the toggle", async ({
  page,
}) => {
  await page.goto("/");
  const toggle = page.locator("summary[aria-label=Menu]");
  const menu = page.locator("header details");
  await toggle.click();
  await expect(menu).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open", "");
  await expect(toggle).toBeFocused();
});

test("a press outside the open menu closes it", async ({ page }) => {
  await page.goto("/");
  const menu = page.locator("header details");
  await page.locator("summary[aria-label=Menu]").click();
  await expect(menu).toHaveAttribute("open", "");
  await page.mouse.click(200, 700);
  await expect(menu).not.toHaveAttribute("open", "");
});
