// Phase 5 P6: /request-access (plan Q2/Q3/Q6, ADR 0069). Submits with and
// without JavaScript, the honeypot and a repeated request get the very same
// thanks, field errors are shown and wired (aria-invalid/-describedby) with
// the typed values kept, a signed-in user is prefilled from the session, the
// product page links here (sign-in `next`, request access, expired → renew),
// WhatsApp stays hidden without a number, and axe passes at 360 and 1280 px.
// The service drops a form sent within 3 s of rendering (silently, same
// thanks), so each real submit waits that long first.

import { randomUUID } from "node:crypto";

import { type Browser, expect, type Page, test } from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";

import { E2E_CUSTOMER } from "./fixtures/accounts";
import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import {
  axeViolations,
  gotoAndWaitForRestricted,
  horizontalOverflow,
  waitForHydration,
} from "./fixtures/product-page-helpers";
import { RESTRICTED } from "./fixtures/product-pages";

const THANKS = "Thank you. We have received your request and will be in touch.";
const MIN_FILL_MS = 3000;
const PRODUCT_ID = RESTRICTED.productId;
const PRODUCT_PATH = `/product/${RESTRICTED.slug}`;
const PRODUCT_NAME = /Restricted RS-/;

let client: MongoClient;
let db: Db;
let savedCustomer: Record<string, unknown> | null = null;
const emails: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
  savedCustomer = await db
    .collection("users")
    .findOne(
      { email: E2E_CUSTOMER.email },
      { projection: { mustChangePassword: 1, accessExpiresAt: 1 } },
    );
});

test.afterAll(async () => {
  await db.collection("accessRequests").deleteMany({ email: { $in: emails } });
  if (savedCustomer) {
    await db.collection("users").updateOne(
      { email: E2E_CUSTOMER.email },
      {
        $set: {
          mustChangePassword: savedCustomer.mustChangePassword ?? true,
          accessExpiresAt: savedCustomer.accessExpiresAt ?? null,
        },
      },
    );
  }
  await client.close();
});

/* A fresh address per submission (the per-email limit is 3 a day). */
function newEmail(): string {
  const email = `e2e-request-${randomUUID().slice(0, 12)}@example.com`;
  emails.push(email);
  return email;
}

const rowsFor = (email: string) =>
  db.collection("accessRequests").find({ email }).toArray();

/* The request form (labels like "Company" also name footer navigation). */
const requestForm = (page: Page) =>
  page.locator('form:has(input[name="startedAt"])');

/* Fills the visible fields with valid values. */
async function fillValid(page: Page, email: string): Promise<void> {
  await requestForm(page).getByLabel("Name").fill("Ada Lovelace");
  await requestForm(page).getByLabel("Work email").fill(email);
  await requestForm(page).getByLabel("Company").fill("Analytical Engines Ltd");
  await requestForm(page).getByLabel("Country").selectOption("United Kingdom");
  await requestForm(page)
    .getByLabel(/^Phone/)
    .fill("+44 20 7946 0000");
  await page
    .getByLabel(/^Message/)
    .fill("Lighting for a gallery refit.\nTwo floors.");
  await requestForm(page)
    .getByLabel(/I agree that YG UniLUX keeps these details/)
    .check();
}

/*
 * Waits out the service's minimum fill time, counted from the start time
 * the server rendered into the form (the clock the service compares with).
 */
async function waitMinimumFill(page: Page): Promise<void> {
  const startedAt = Number(
    await page.locator('input[name="startedAt"]').inputValue(),
  );
  expect(startedAt).toBeGreaterThan(0);
  const left = startedAt + MIN_FILL_MS + 500 - Date.now();
  if (left > 0) await page.waitForTimeout(left);
}

const submit = (page: Page, name = "Send request") =>
  page.getByRole("button", { name }).click();

async function noJsPage(browser: Browser, width = 1280): Promise<Page> {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width, height: 900 },
  });
  return context.newPage();
}

test.describe("the page", () => {
  test("is private, never indexed, accessible at 360 and 1280 px, and has no WhatsApp without a number", async ({
    page,
  }) => {
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto("/request-access");
      expect(response?.status()).toBe(200);
      const cacheControl = response?.headers()["cache-control"] ?? "";
      expect(cacheControl).toContain("private");
      expect(cacheControl).toContain("no-store");
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Request datasheet access",
        }),
      ).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        "content",
        /noindex/,
      );
      await expect(page.locator('a[href^="https://wa.me/"]')).toHaveCount(0);
      await expect(page.locator("[data-request-product]")).toHaveCount(0);
      expect(await horizontalOverflow(page)).toBe(0);
      expect(await axeViolations(page), `axe at ${width}px`).toEqual([]);
    }
  });

  test("the honeypot is out of sight, out of the tab order and hidden from assistive technology", async ({
    page,
  }) => {
    await page.goto("/request-access");
    const trap = page.locator('input[name="website"]');
    await expect(trap).toHaveAttribute("tabindex", "-1");
    await expect(trap).toHaveAttribute("autocomplete", "off");
    await expect(
      page.locator('[aria-hidden="true"]:has(input[name="website"])'),
    ).toHaveCount(1);
    const box = await page
      .locator('[aria-hidden="true"]:has(input[name="website"])')
      .boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(0);
    // The start time is rendered by the server.
    const startedAt = Number(
      await page.locator('input[name="startedAt"]').inputValue(),
    );
    expect(Math.abs(Date.now() - startedAt)).toBeLessThan(60_000);
  });

  test("ignores a malformed or unknown product and words a renewal", async ({
    page,
  }) => {
    for (const product of ["nope", new ObjectId().toHexString()]) {
      await page.goto(`/request-access?product=${product}`);
      await expect(page.locator("[data-request-product]")).toHaveCount(0);
      await expect(page.locator('input[name="product"]')).toHaveCount(0);
    }
    await page.goto(`/request-access?renew=1&product=${PRODUCT_ID}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Renew datasheet access" }),
    ).toBeVisible();
    await expect(page.locator("[data-request-product]")).toContainText(
      PRODUCT_NAME,
    );
    await expect(page.locator('input[name="kind"]')).toHaveValue("renewal");
    await expect(page.locator('input[name="product"]')).toHaveValue(PRODUCT_ID);
    await expect(
      page.getByRole("button", { name: "Send renewal request" }),
    ).toBeVisible();
  });
});

test.describe("submitting", () => {
  test("with JavaScript: thanks in place, one pending row with the product", async ({
    page,
  }) => {
    const email = newEmail();
    await page.goto(`/request-access?product=${PRODUCT_ID}`);
    await waitForHydration(page.getByRole("button", { name: "Send request" }));
    await fillValid(page, email);
    await waitMinimumFill(page);
    await submit(page);

    const thanks = page.getByRole("status");
    await expect(thanks).toHaveText(THANKS);
    await expect(thanks).toBeFocused();
    // Stayed on the page, and nothing typed went into the URL.
    expect(page.url()).not.toContain(encodeURIComponent(email));
    await expect(
      page.getByRole("link", { name: /^Back to Restricted RS-/ }),
    ).toHaveAttribute("href", PRODUCT_PATH);

    const rows = await rowsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "pending",
      source: "form",
      kind: "new",
      name: "Ada Lovelace",
      company: "Analytical Engines Ltd",
      country: "United Kingdom",
      message: "Lighting for a gallery refit.\nTwo floors.",
    });
    expect(String(rows[0]?.product)).toBe(PRODUCT_ID);
    expect(rows[0]?.consentAt).toBeInstanceOf(Date);
    expect(rows[0]).not.toHaveProperty("user");
    // No address of any kind is stored with the request.
    expect(JSON.stringify(rows[0])).not.toMatch(/"ip"|127\.0\.0\.1|::1/);
  });

  test("without JavaScript: the same thanks after a plain POST", async ({
    browser,
  }) => {
    const page = await noJsPage(browser);
    const email = newEmail();
    await page.goto(`/request-access?renew=1&product=${PRODUCT_ID}`);
    await fillValid(page, email);
    await waitMinimumFill(page);
    await submit(page, "Send renewal request");

    await expect(page.getByRole("status")).toHaveText(THANKS);
    expect(page.url()).not.toContain(encodeURIComponent(email));
    const rows = await rowsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "renewal", status: "pending" });
    await page.context().close();
  });

  test("without JavaScript: field errors come back with the values kept", async ({
    browser,
  }) => {
    const page = await noJsPage(browser, 360);
    const email = newEmail();
    await page.goto("/request-access");
    await fillValid(page, email);
    await requestForm(page).getByLabel("Name").fill("<b>Ada</b>");
    await page
      .getByLabel(/I agree that YG UniLUX keeps these details/)
      .uncheck();
    await waitMinimumFill(page);
    await submit(page);

    const name = requestForm(page).getByLabel("Name");
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toHaveValue("<b>Ada</b>");
    await expect(requestForm(page).getByLabel("Work email")).toHaveValue(email);
    await expect(requestForm(page).getByLabel("Country")).toHaveValue(
      "United Kingdom",
    );
    await expect(page.locator("#request-consent-error")).toHaveText(
      "Please accept the privacy notice",
    );
    expect(await rowsFor(email)).toHaveLength(0);
    await page.context().close();
  });

  test("field errors are announced, wired to their fields, and the fix goes through", async ({
    page,
  }) => {
    const email = newEmail();
    await page.goto("/request-access");
    await waitForHydration(page.getByRole("button", { name: "Send request" }));
    await requestForm(page).getByLabel("Name").fill("Ada");
    await requestForm(page).getByLabel("Work email").fill("not-an-address");
    await requestForm(page).getByLabel("Company").fill("Acme");
    await waitMinimumFill(page);
    await submit(page);

    await expect(page.locator("[data-request-message]")).toContainText(
      "Some details need another look",
    );
    const emailField = requestForm(page).getByLabel("Work email");
    await expect(emailField).toHaveAttribute("aria-invalid", "true");
    await expect(emailField).toHaveAttribute(
      "aria-describedby",
      "request-email-error",
    );
    await expect(page.locator("#request-email-error")).toHaveText(
      "Enter a valid email address",
    );
    await expect(requestForm(page).getByLabel("Country")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(requestForm(page).getByLabel(/I agree/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    // Focus lands on the first field to fix; typed values stay.
    await expect(emailField).toBeFocused();
    await expect(requestForm(page).getByLabel("Name")).toHaveValue("Ada");
    await expect(requestForm(page).getByLabel("Name")).not.toHaveAttribute(
      "aria-invalid",
    );
    await expect(requestForm(page).getByLabel("Company")).toHaveValue("Acme");
    // An untouched select gets the schema's own words, not a type error.
    await expect(page.locator("#request-country-error")).toHaveText(
      "Choose a country",
    );
    await expect(page).toHaveTitle(/Request datasheet access/);

    // Fixed straight away: the first render's start time still counts.
    await emailField.fill(email);
    await requestForm(page).getByLabel("Country").selectOption("Japan");
    await requestForm(page)
      .getByLabel(/I agree/)
      .check();
    await submit(page);
    await expect(page.getByRole("status")).toHaveText(THANKS);
    expect(await rowsFor(email)).toHaveLength(1);
  });

  test("a filled honeypot gets the very same thanks and stores nothing", async ({
    page,
  }) => {
    const email = newEmail();
    await page.goto("/request-access");
    await waitForHydration(page.getByRole("button", { name: "Send request" }));
    await fillValid(page, email);
    await page
      .locator('input[name="website"]')
      .fill("https://spam.example", { force: true });
    await waitMinimumFill(page);
    await submit(page);
    await expect(page.getByRole("status")).toHaveText(THANKS);
    expect(await rowsFor(email)).toHaveLength(0);
  });

  test("the same request twice gets the same thanks and stays one row", async ({
    page,
  }) => {
    const email = newEmail();
    const answers: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      await page.goto("/request-access");
      await waitForHydration(
        page.getByRole("button", { name: "Send request" }),
      );
      await fillValid(page, email);
      await waitMinimumFill(page);
      await submit(page);
      await expect(page.getByRole("status")).toBeVisible();
      answers.push((await page.getByRole("status").textContent()) ?? "");
    }
    expect(answers).toEqual([THANKS, THANKS]);
    expect(await rowsFor(email)).toHaveLength(1);
  });
});

test.describe("signed in", () => {
  test("prefills from the session, not the URL", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: loadState("customer"),
    });
    const page = await context.newPage();
    await page.goto("/request-access?renew=1&email=evil%40example.com");
    await expect(requestForm(page).getByLabel("Work email")).toHaveValue(
      E2E_CUSTOMER.email,
    );
    await expect(requestForm(page).getByLabel("Name")).toHaveValue(
      E2E_CUSTOMER.name,
    );
    await context.close();
  });
});

test.describe("links from the product page", () => {
  test("a visitor: sign in comes back to the product, request access names it", async ({
    page,
  }) => {
    await page.goto(PRODUCT_PATH);
    const slot = page.locator('[data-slot="datasheet"]');
    await expect(
      slot.getByRole("link", { name: "Sign in to download" }),
    ).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent(PRODUCT_PATH)}`,
    );
    const restricted = page.locator('[data-slot="restricted-specs"]');
    await expect(
      restricted.getByRole("link", { name: "Sign in to see them" }),
    ).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent(PRODUCT_PATH)}`,
    );
    await expect(
      restricted.getByRole("link", { name: "request access" }),
    ).toHaveAttribute("href", `/request-access?product=${PRODUCT_ID}`);

    await slot.getByRole("link", { name: "Request access" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/request-access\\?product=${PRODUCT_ID}$`),
    );
    await expect(page.locator("[data-request-product]")).toContainText(
      PRODUCT_NAME,
    );
  });

  test("sign in from the product page returns there", async ({ page }) => {
    await page.goto(PRODUCT_PATH);
    await page
      .locator('[data-slot="datasheet"]')
      .getByRole("link", { name: "Sign in to download" })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/login\\?next=${encodeURIComponent(PRODUCT_PATH)}$`),
    );
    await expect(page.locator('input[name="next"], form')).not.toHaveCount(0);
  });

  test("an expired customer is sent to the renewal form for this product", async ({
    browser,
  }) => {
    await db.collection("users").updateOne(
      { email: E2E_CUSTOMER.email },
      {
        $set: {
          mustChangePassword: false,
          accessExpiresAt: new Date(Date.now() - 86_400_000),
        },
      },
    );
    const context = await browser.newContext({
      storageState: loadState("customer"),
    });
    const page = await context.newPage();
    await gotoAndWaitForRestricted(page, PRODUCT_PATH);
    const renew = `/request-access?renew=1&product=${PRODUCT_ID}`;
    await expect(
      page
        .locator('[data-slot="datasheet"]')
        .getByRole("link", { name: "Access expired — contact us" }),
    ).toHaveAttribute("href", renew);
    await expect(
      page
        .locator('[data-slot="restricted-specs"]')
        .getByRole("link", { name: "Access expired — contact us" }),
    ).toHaveAttribute("href", renew);

    await page
      .locator('[data-slot="datasheet"]')
      .getByRole("link", { name: "Access expired — contact us" })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Renew datasheet access" }),
    ).toBeVisible();
    await expect(requestForm(page).getByLabel("Work email")).toHaveValue(
      E2E_CUSTOMER.email,
    );
    await context.close();
  });
});
