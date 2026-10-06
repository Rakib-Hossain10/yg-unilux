// Admin shell and dashboard (Phase 2 T3) against the production build: the
// dashboard counts and module links, the active nav link, the skip link, the
// mobile <details> menu, and axe WCAG 2.2 AA on /admin at desktop and phone
// width. Signs in once (sign-in is rate-limited per email) and reuses the state.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type BrowserContextOptions,
  type Page,
  test as base,
  expect,
} from "@playwright/test";

import { E2E_ADMIN } from "./fixtures/accounts";

const axeSource = readFileSync(
  join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

const PHONE = { width: 375, height: 740 };

type StorageState = Exclude<BrowserContextOptions["storageState"], undefined>;
let adminState: StorageState;

/* `adminPage`: a page in a fresh context holding the admin session, closed
   after the test so no signed-in page lingers into later tests. */
const test = base.extend<{ adminPage: Page }>({
  adminPage: async ({ browser }, provide) => {
    const context = await browser.newContext({ storageState: adminState });
    await provide(await context.newPage());
    await context.close();
  },
});

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_ADMIN.email);
  await page.getByLabel("Password").fill(E2E_ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  adminState = await context.storageState();
  await context.close();
});

test("the dashboard shows counts and links every card to its module", async ({
  adminPage: page,
}) => {
  const response = await page.goto("/admin");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("Dashboard | Admin | YG UniLUX");
  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeVisible();

  const main = page.locator("main#main");
  const cards: [string, string][] = [
    ["Products", "/admin/products"],
    ["Categories", "/admin/categories"],
    ["Areas", "/admin/areas"],
    ["Datasheets", "/admin/datasheets"],
    ["Customers", "/admin/customers"],
    ["Access requests", "/admin/access-requests"],
    ["Whistleblower", "/admin/whistleblower"],
  ];
  for (const [name, href] of cards) {
    await expect(main.getByRole("link", { name, exact: true })).toHaveAttribute(
      "href",
      href,
    );
  }

  // The test server seeds exactly one customer (and the admin, not counted).
  const customers = main.getByRole("listitem").filter({
    has: page.getByRole("heading", { level: 2, name: "Customers" }),
  });
  await expect(customers.getByRole("definition").first()).toHaveText("1");
});

test("the sidebar marks the dashboard as the current page", async ({
  adminPage: page,
}) => {
  await page.goto("/admin");
  const nav = page.locator("aside").getByRole("navigation", { name: "Admin" });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(nav.getByRole("link", { name: "Products" })).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(nav.getByRole("link")).toHaveCount(9);
});

test("the skip link is the first focusable element and targets #main", async ({
  adminPage: page,
}) => {
  await page.goto("/admin");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toHaveAttribute("href", "#main");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
});

test("on a phone the nav is a native <details> menu", async ({
  adminPage: page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto("/admin");
  await expect(page.locator("aside")).toBeHidden();
  const menu = page.locator("details");
  await expect(menu).not.toHaveAttribute("open", "");
  await menu.locator("summary").click();
  await expect(menu).toHaveAttribute("open", "");
  await expect(
    menu.getByRole("navigation", { name: "Admin" }).getByRole("link", {
      name: "Products",
    }),
  ).toBeVisible();
});

for (const viewport of [{ width: 1280, height: 800 }, PHONE]) {
  test(`axe WCAG 2.2 AA: /admin at ${viewport.width}px`, async ({
    adminPage: page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { level: 1, name: "Dashboard" }),
    ).toBeVisible();
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
