// Phase 5 P2 account pages: where /login sends each user (plan Q7), the forced
// password change, forgot → reset through the emailed link (Resend sink),
// dead links, /my-downloads (status + history + paging), sign out, no-JS
// submits that never put a secret in the URL, and axe at 360 and 1280 px.
// Each password-changing flow has its own seeded account (fixtures/accounts.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type Browser,
  type BrowserContext,
  type Page,
  expect,
  test,
} from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";

import {
  E2E_EXPIRED_CUSTOMER,
  E2E_MAIL_CUSTOMER,
  E2E_READY_CUSTOMER,
  E2E_TEMP_CUSTOMER,
} from "./fixtures/accounts";
import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import { clearEmails, linkIn, waitForEmail } from "./fixtures/emails";
import { RESTRICTED } from "./fixtures/product-pages";

const axeSource = readFileSync(
  join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

/* A token of the right shape that was never issued. */
const UNKNOWN_TOKEN = "aB3d".repeat(6);
const PRODUCT_PATH = `/product/${RESTRICTED.slug}`;

/* Matches exactly this path (and query) on the test server. */
function at(path: string): RegExp {
  return new RegExp(
    `^https?://[^/]+${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  );
}

async function signIn(
  page: Page,
  account: { email: string; password: string },
  path = "/login",
): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
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
}

let client: MongoClient;
let db: Db;
let readyUserId: ObjectId;
const sheetId = new ObjectId();
const removedProductId = new ObjectId();
const SHEET_NAME = "E2E account pages sheet.xlsx";

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
  const ready = await db
    .collection<{ _id: ObjectId; email: string }>("users")
    .findOne({ email: E2E_READY_CUSTOMER.email }, { projection: { _id: 1 } });
  if (!ready) throw new Error("ready customer not seeded");
  readyUserId = ready._id;

  // 21 downloads of a published product + 1 of a removed one (newest), so
  // the history has two pages and a row without a product.
  await db.collection("datasheets").insertOne({
    _id: sheetId,
    storageKey: "datasheets/e2e-account-pages.xlsx",
    fileName: SHEET_NAME,
    size: 1024,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    uploadedBy: new ObjectId(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const base = Date.UTC(2026, 8, 1, 9, 0);
  await db.collection("downloadLogs").insertMany([
    ...Array.from({ length: 21 }, (_, i) => ({
      user: readyUserId,
      product: new ObjectId(RESTRICTED.productId),
      datasheet: sheetId,
      downloadedAt: new Date(base + i * 60_000),
    })),
    {
      user: readyUserId,
      product: removedProductId,
      datasheet: new ObjectId(),
      downloadedAt: new Date(base + 60 * 60_000),
    },
  ]);
});

test.afterAll(async () => {
  await db.collection("downloadLogs").deleteMany({ user: readyUserId });
  await db.collection("datasheets").deleteOne({ _id: sheetId });
  await client.close();
});

test.describe("where /login sends people", () => {
  test("a visitor is sent from the account pages to /login", async ({
    page,
  }) => {
    await page.goto("/my-downloads");
    await expect(page).toHaveURL(/\/login\?next=%2Fmy-downloads$/);
    await page.goto("/change-password");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a temporary password is forced through /change-password, then on to next", async ({
    page,
  }) => {
    await signIn(page, E2E_TEMP_CUSTOMER, `/login?next=${PRODUCT_PATH}`);
    await expect(page).toHaveURL(
      at(`/change-password?next=${encodeURIComponent(PRODUCT_PATH)}`),
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Choose your own password" }),
    ).toBeVisible();

    // /my-downloads is no way around it.
    await page.goto("/my-downloads");
    await expect(page).toHaveURL(/\/change-password\?next=%2Fmy-downloads$/);
    await page.goto(
      `/change-password?next=${encodeURIComponent(PRODUCT_PATH)}`,
    );

    const newPassword = "a brand new e2e password";
    // Client-side checks: too short, and the repeat must match.
    await page.getByLabel("Current password").fill(E2E_TEMP_CUSTOMER.password);
    await page.getByLabel("New password", { exact: true }).fill("short");
    await page.getByLabel("Repeat new password").fill("other");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.locator("#new-password-error")).toHaveText(
      "Use at least 12 characters.",
    );
    await expect(page.locator("#confirm-password-error")).toHaveText(
      "The two passwords don't match.",
    );

    // Wrong current password: the server's answer, on the right field.
    await page.getByLabel("Current password").fill("not-the-password-123");
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("Repeat new password").fill(newPassword);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.locator("#current-password-error")).toHaveText(
      "Your current password is incorrect.",
    );

    await page.getByLabel("Current password").fill(E2E_TEMP_CUSTOMER.password);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page).toHaveURL(at(PRODUCT_PATH));

    // The flag is cleared: /my-downloads opens, /change-password is the
    // voluntary version.
    await page.goto("/my-downloads");
    await expect(
      page.getByRole("heading", { level: 1, name: "My downloads" }),
    ).toBeVisible();
    await page.goto("/change-password");
    await expect(
      page.getByRole("heading", { level: 1, name: "Change password" }),
    ).toBeVisible();
  });

  test("a signed-in user opening /login is sent straight on", async ({
    browser,
    page,
  }) => {
    await signIn(page, E2E_READY_CUSTOMER);
    await expect(page).toHaveURL(at("/my-downloads"));
    await page.goto("/login");
    await expect(page).toHaveURL(at("/my-downloads"));
    await page.goto(`/login?next=${PRODUCT_PATH}`);
    await expect(page).toHaveURL(at(PRODUCT_PATH));
    // An unsafe next is ignored.
    await page.goto("/login?next=//evil.example");
    await expect(page).toHaveURL(at("/my-downloads"));

    const asAdmin = await browser.newContext({
      storageState: loadState("admin"),
    });
    const adminPage = await asAdmin.newPage();
    await adminPage.goto("/login");
    await expect(adminPage).toHaveURL(at("/admin"));
    await asAdmin.close();

    // The shared customer is still on its temporary password.
    const asTemp = await browser.newContext({
      storageState: loadState("customer"),
    });
    const tempPage = await asTemp.newPage();
    await tempPage.goto("/login");
    await expect(tempPage).toHaveURL(at("/change-password"));
    await asTemp.close();
  });
});

test.describe("forgot and reset password", () => {
  test("forgot → emailed link → new password → sign in with it", async ({
    page,
  }) => {
    await clearEmails();
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(E2E_MAIL_CUSTOMER.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("status")).toContainText(
      "If an account uses that address",
    );

    const email = await waitForEmail(E2E_MAIL_CUSTOMER.email, /Reset your/);
    const link = linkIn(email, /\/api\/auth\/reset-password\//);
    await page.goto(link);
    await expect(page).toHaveURL(/\/reset-password\?token=/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Choose a new password" }),
    ).toBeVisible();
    // The URL holds the token: the page sends no Referer anywhere.
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
      "content",
      "no-referrer",
    );

    const newPassword = "my fresh reset e2e password";
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("Repeat new password").fill(newPassword);
    await page.getByRole("button", { name: "Save new password" }).click();
    await expect(page).toHaveURL(at("/login?reset=1"));
    await expect(page.getByRole("status")).toHaveText(
      "Password changed. Sign in with your new password.",
    );

    await page.getByLabel("Email").fill(E2E_MAIL_CUSTOMER.email);
    await page.getByLabel("Password", { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    // A completed reset also clears the temporary-password flag.
    await expect(page).toHaveURL(at("/my-downloads"));

    // The link is single use: following it again lands on the expired view.
    await page.goto(link);
    await expect(page).toHaveURL(/\/reset-password\?error=INVALID_TOKEN/);
    await expect(
      page.getByRole("heading", { level: 1, name: "This link has expired" }),
    ).toBeVisible();
  });

  test("a dead token posted from the form shows the expired view", async ({
    page,
  }) => {
    await page.goto(`/reset-password?token=${UNKNOWN_TOKEN}&invite=1`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Set your password" }),
    ).toBeVisible();
    await page
      .getByLabel("Password", { exact: true })
      .fill("long enough password");
    await page.getByLabel("Repeat password").fill("long enough password");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "This link has expired" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Request access" }),
    ).toHaveAttribute("href", "/request-access");
  });

  test("a missing or malformed token is the expired view, without WhatsApp when no number is set", async ({
    page,
  }) => {
    for (const path of [
      "/reset-password",
      "/reset-password?error=INVALID_TOKEN",
      "/reset-password?token=%3Cscript%3E",
    ]) {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { level: 1, name: "This link has expired" }),
        path,
      ).toBeVisible();
      await expect(page.locator('a[href^="https://wa.me/"]')).toHaveCount(0);
    }
  });
});

test.describe("/my-downloads", () => {
  test("shows access, the history newest first in pages of 20, and signs out", async ({
    page,
  }) => {
    await signIn(page, E2E_READY_CUSTOMER);
    await expect(page).toHaveURL(at("/my-downloads"));
    await expect(page.getByText("Active until 31 March 2099")).toBeVisible();

    const rows = page
      .getByRole("list")
      .filter({ has: page.locator("time") })
      .getByRole("listitem");
    await expect(rows).toHaveCount(20);
    await expect(page.getByText("22 downloads")).toBeVisible();
    // Newest first: the removed product.
    await expect(rows.first()).toContainText("A product that has been removed");
    await expect(
      rows.first().getByRole("link", { name: /Download again/ }),
    ).toHaveCount(0);
    const second = rows.nth(1);
    await expect(second).toContainText(SHEET_NAME);
    await expect(
      second.getByRole("link", { name: /Download again/ }),
    ).toHaveAttribute("href", `/api/datasheet/${RESTRICTED.productId}`);
    await expect(second.getByRole("link").first()).toHaveAttribute(
      "href",
      PRODUCT_PATH,
    );

    await page.getByRole("link", { name: "Older" }).click();
    await expect(page).toHaveURL(at("/my-downloads?page=2"));
    await expect(rows).toHaveCount(2);
    await expect(page.getByText("Page 2 of 2")).toBeVisible();
    // A page past the end shows the last page; junk is page 1.
    await page.goto("/my-downloads?page=9");
    await expect(page.getByText("Page 2 of 2")).toBeVisible();
    await page.goto("/my-downloads?page=abc");
    await expect(page.getByText("Page 1 of 2")).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(at("/"));
    await page.goto("/my-downloads");
    await expect(page).toHaveURL(/\/login\?next=%2Fmy-downloads$/);
  });

  test("expired access: renewal link, empty history", async ({ page }) => {
    await signIn(page, E2E_EXPIRED_CUSTOMER);
    await expect(page).toHaveURL(at("/my-downloads"));
    await expect(page.getByText("Ended on 31 January 2026")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Renew access" }),
    ).toHaveAttribute("href", "/request-access?renew=1");
    await expect(page.getByText("No downloads yet.")).toBeVisible();
  });

  test("the admin can open it", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: loadState("admin"),
    });
    const page = await context.newPage();
    await page.goto("/my-downloads");
    await expect(page.getByText("Full access")).toBeVisible();
    await context.close();
  });
});

test.describe("without JavaScript, nothing secret goes into the URL", () => {
  async function noJs(
    browser: Browser,
    storageState?: ReturnType<typeof loadState>,
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      storageState,
    });
    return { context, page: await context.newPage() };
  }

  test("forgot, reset and change password submit as POST", async ({
    browser,
  }) => {
    const { context, page } = await noJs(browser);
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill("qa-nojs@example.com");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await page.waitForLoadState("domcontentloaded");
    expect(page.url()).not.toContain("qa-nojs");

    await page.goto(`/reset-password?token=${UNKNOWN_TOKEN}`);
    await page
      .getByLabel("New password", { exact: true })
      .fill("nojs-secret-password");
    await page.getByLabel("Repeat new password").fill("nojs-secret-password");
    await page.getByRole("button", { name: "Save new password" }).click();
    await page.waitForLoadState("domcontentloaded");
    expect(page.url()).not.toContain("nojs-secret");
    await context.close();

    const signedIn = await noJs(browser, loadState("customer"));
    await signedIn.page.goto("/change-password");
    await signedIn.page
      .getByLabel("Current password")
      .fill("nojs-current-secret");
    await signedIn.page
      .getByLabel("New password", { exact: true })
      .fill("nojs-new-secret-password");
    await signedIn.page
      .getByLabel("Repeat new password")
      .fill("nojs-new-secret-password");
    await signedIn.page
      .getByRole("button", { name: "Save and continue" })
      .click();
    await signedIn.page.waitForLoadState("domcontentloaded");
    expect(signedIn.page.url()).not.toContain("nojs");
    await signedIn.context.close();
  });
});

test.describe("axe WCAG 2.2 AA on every account page", () => {
  for (const width of [360, 1280]) {
    test(`at ${width} px`, async ({ browser }) => {
      const viewport = { width, height: 900 };
      const visitor = await browser.newContext({ viewport });
      const page = await visitor.newPage();
      for (const path of [
        "/login",
        "/login?reset=1",
        "/forgot-password",
        `/reset-password?token=${UNKNOWN_TOKEN}`,
        `/reset-password?token=${UNKNOWN_TOKEN}&invite=1`,
        "/reset-password?error=INVALID_TOKEN",
      ]) {
        await page.goto(path);
        expect(await axeViolations(page), path).toEqual([]);
        // No horizontal page scroll.
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          path,
        ).toBe(true);
      }
      // Error states.
      await page.goto("/login");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.locator("#email-error")).toBeVisible();
      expect(await axeViolations(page), "/login errors").toEqual([]);
      await page.goto("/forgot-password");
      await page.getByLabel("Email").fill(`axe-${width}@example.com`);
      await page.getByRole("button", { name: "Send reset link" }).click();
      await expect(page.getByRole("status")).toBeVisible();
      expect(await axeViolations(page), "/forgot-password sent").toEqual([]);
      await visitor.close();

      // Signed in: the forced change-password page (shared temp customer).
      const temp = await browser.newContext({
        viewport,
        storageState: loadState("customer"),
      });
      const tempPage = await temp.newPage();
      await tempPage.goto("/change-password");
      await tempPage.getByRole("button", { name: "Save and continue" }).click();
      await expect(tempPage.locator("#current-password-error")).toBeVisible();
      expect(await axeViolations(tempPage), "/change-password").toEqual([]);
      await temp.close();

      // /my-downloads with a full history page (the ready customer).
      const ready = await browser.newContext({ viewport });
      const readyPage = await ready.newPage();
      await signIn(readyPage, E2E_READY_CUSTOMER);
      await expect(readyPage).toHaveURL(at("/my-downloads"));
      expect(await axeViolations(readyPage), "/my-downloads").toEqual([]);
      expect(
        await readyPage.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        "/my-downloads",
      ).toBe(true);
      await ready.close();
    });
  }
});
