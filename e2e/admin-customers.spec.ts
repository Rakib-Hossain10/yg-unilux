// Phase 5 P8: the admin customers module against the production build.
// Create → invite emailed (Resend sink) → the clock moved past 72 h (the
// invite's stored expiry and its token row are moved into the past) →
// "Invite expired" on the page and in the list filter → a new link in copy
// mode → the old link shows the expired page, the new one sets the password
// → extend access → block → sessions gone; the copied link is not in the page
// after a reload; unknown ids 404; a customer gets 403; axe WCAG 2.2 AA and
// no sideways scroll at 375 px. Everything this spec creates is removed in
// afterAll, so list counts in other specs are unaffected.

import { randomUUID } from "node:crypto";

import {
  type BrowserContextOptions,
  expect,
  type Page,
  test as base,
} from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";

import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import { linkIn, waitForEmail } from "./fixtures/emails";
import {
  axeViolations,
  horizontalOverflow,
  waitForHydration,
} from "./fixtures/product-page-helpers";

const PHONE = { width: 375, height: 740 };
const LIST = "/admin/customers";
const HOUR = 3_600_000;

type StorageState = Exclude<BrowserContextOptions["storageState"], undefined>;
let adminState: StorageState;

const test = base.extend<{ adminPage: Page }>({
  adminPage: async ({ browser }, provide) => {
    const context = await browser.newContext({ storageState: adminState });
    await provide(await context.newPage());
    await context.close();
  },
});

let client: MongoClient;
let db: Db;
const emails: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  adminState = loadState("admin");
  client = await connectE2eDb();
  db = client.db();
});

test.afterAll(async () => {
  const users = await db
    .collection("users")
    .find({ email: { $in: emails } }, { projection: { _id: 1 } })
    .toArray();
  const ids = users.map((user) => user._id);
  if (ids.length > 0) {
    await Promise.all([
      db.collection("sessions").deleteMany({ userId: { $in: ids } }),
      db.collection("accounts").deleteMany({ userId: { $in: ids } }),
      db
        .collection("verifications")
        .deleteMany({ value: { $in: ids.map((id) => id.toHexString()) } }),
    ]);
    await db.collection("users").deleteMany({ _id: { $in: ids } });
  }
  await client.close();
});

function newEmail(): string {
  const email = `e2e-cust-${randomUUID().slice(0, 12)}@example.com`;
  emails.push(email);
  return email;
}

/* Creates a customer through the "New customer" form; returns its id. */
async function createCustomer(
  page: Page,
  email: string,
  name: string,
): Promise<string> {
  await page.goto(`${LIST}/new`);
  const submit = page.getByRole("button", { name: "Create customer" });
  await waitForHydration(submit);
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page
    .getByRole("textbox", { name: /Company/ })
    .fill("Harbour Lighting Ltd");
  await page.getByRole("radio", { name: "6 months" }).check();
  await submit.click();
  await expect(
    page.getByRole("heading", { name: "Customer created" }),
  ).toBeVisible();
  const user = await db.collection("users").findOne({ email });
  if (!user) throw new Error("customer not created");
  return user._id.toHexString();
}

/* The invite's 72 h run out: its stored expiry and token row move back. */
async function expireInvite(userId: string) {
  const past = new Date(Date.now() - 80 * HOUR);
  await db.collection("users").updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: {
        invitedAt: past,
        inviteExpiresAt: new Date(past.getTime() + 72 * HOUR),
      },
    },
  );
  await db
    .collection("verifications")
    .updateMany(
      { value: userId },
      { $set: { expiresAt: new Date(Date.now() - 8 * HOUR) } },
    );
}

/* Fills the "Set your password" page and submits it. */
async function setPassword(page: Page, link: string, password: string) {
  await page.goto(link);
  await expect(
    page.getByRole("heading", { level: 1, name: "Set your password" }),
  ).toBeVisible();
  const submit = page.getByRole("button", { name: "Set password" });
  await waitForHydration(submit);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Repeat password").fill(password);
  await submit.click();
}

test("create → invite expired → new link to copy → password set → extend → block", async ({
  adminPage: page,
  browser,
}) => {
  const email = newEmail();
  const id = await createCustomer(page, email, "Chan Tai Man");

  // Emailed by default: no link on screen.
  await expect(page.getByText("Invite emailed")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Invite link", exact: true }),
  ).toHaveCount(0);
  const user = await db.collection("users").findOne({ email });
  expect(user).toMatchObject({
    role: "customer",
    mustChangePassword: true,
    company: "Harbour Lighting Ltd",
  });
  const firstLink = linkIn(
    await waitForEmail(email, /Set your .* password/),
    /\/reset-password\?token=/,
  );

  await page.getByRole("link", { name: "Open customer" }).click();
  await expect(page).toHaveURL(new RegExp(`${LIST}/${id}$`));
  await expect(
    page.getByText(/Invite pending: the link works until .* \(China time\)\./),
  ).toBeVisible();

  // 72 hours pass.
  await expireInvite(id);
  await page.reload();
  await expect(page.getByText(/^Invite expired on /)).toBeVisible();

  // The list's "Invite expired" filter finds the customer.
  await page.goto(`${LIST}?status=invite_expired`);
  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row).toBeVisible();
  await expect(row.getByText("Invite expired")).toBeVisible();
  await page.goto(`${LIST}?status=invite_pending`);
  await expect(page.getByRole("row").filter({ hasText: email })).toHaveCount(0);

  // A new link, shown once to copy (after the warning).
  await page.goto(`${LIST}/${id}`);
  const accessBefore = (await db.collection("users").findOne({ email }))
    ?.accessExpiresAt as Date;
  const copyFirst = page.getByRole("button", { name: "Show once to copy…" });
  await waitForHydration(copyFirst);
  await copyFirst.click();
  await expect(page.getByText("Check who you send this link to")).toBeVisible();
  await page
    .getByRole("button", { name: "I understand, show the link" })
    .click();
  const linkInput = page.getByRole("textbox", {
    name: "Invite link",
    exact: true,
  });
  await expect(linkInput).toBeVisible();
  const newLink = await linkInput.inputValue();
  expect(newLink).toMatch(/\/reset-password\?token=[^&]+&invite=1$/);
  expect(page.url()).not.toContain("token");
  // The page refreshes underneath: the status is pending again, the access
  // end date did not move.
  await expect(page.getByText(/^Invite pending: /)).toBeVisible();
  expect(
    (await db.collection("users").findOne({ email }))?.accessExpiresAt,
  ).toEqual(accessBefore);

  // The copied link is not in the page after a reload.
  const token = new URL(newLink).searchParams.get("token") ?? "";
  expect(token.length).toBeGreaterThan(10);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.content()).not.toContain(token);

  // The old link is dead; the new one sets the password.
  const visitor = await browser.newContext();
  const customerPage = await visitor.newPage();
  await setPassword(customerPage, firstLink, "first link must not work 1");
  await expect(
    customerPage.getByRole("heading", {
      level: 1,
      name: "This link has expired",
    }),
  ).toBeVisible();
  const password = "my own e2e customer password";
  await setPassword(customerPage, newLink, password);
  await expect(customerPage).toHaveURL(/\/login\?reset=1$/);
  await customerPage.getByLabel("Email").fill(email);
  await customerPage.getByLabel("Password", { exact: true }).fill(password);
  await customerPage.getByRole("button", { name: "Sign in" }).click();
  await expect(customerPage).toHaveURL(/\/my-downloads$/);
  expect(
    await db
      .collection("sessions")
      .countDocuments({ userId: new ObjectId(id) }),
  ).toBeGreaterThan(0);

  await page.reload();
  await expect(
    page.getByText("Invite accepted: the customer has set a password."),
  ).toBeVisible();

  // Extend by 3 months: counted from the current end.
  const save = page.getByRole("button", { name: "Save access" });
  await waitForHydration(save);
  await page.getByRole("radio", { name: "3 months" }).check();
  await save.click();
  await expect(
    page.getByText(/^Access saved: until the end of .* \(China time\)\./),
  ).toBeVisible();
  const extended = (await db.collection("users").findOne({ email }))
    ?.accessExpiresAt as Date;
  const days = (extended.getTime() - accessBefore.getTime()) / 86_400_000;
  expect(days).toBeGreaterThan(88);
  expect(days).toBeLessThan(93);

  // Block with a reason: the customer's sessions are gone.
  const block = page.getByRole("button", { name: "Block…" });
  await waitForHydration(block);
  await block.click();
  const dialog = page.getByRole("dialog", { name: "Block customer" });
  await dialog.getByRole("button", { name: "Block customer" }).click();
  await expect(dialog.getByLabel("Reason")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await dialog.getByLabel("Reason").fill("Left the company");
  await dialog.getByRole("button", { name: "Block customer" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Customer blocked. Their sessions have ended."),
  ).toBeVisible();
  await expect(page.getByText("Left the company")).toBeVisible();
  expect(
    await db
      .collection("sessions")
      .countDocuments({ userId: new ObjectId(id) }),
  ).toBe(0);
  expect(await db.collection("users").findOne({ email })).toMatchObject({
    banned: true,
  });
  // The customer's open page is signed out.
  await customerPage.goto("/my-downloads");
  await expect(customerPage).toHaveURL(/\/login/);
  await visitor.close();

  // The audit trail lists what happened.
  for (const label of [
    "Account created",
    "New invite link made",
    "Access changed",
    "Blocked",
  ]) {
    await expect(
      page.getByRole("listitem").filter({ hasText: label }).first(),
    ).toBeVisible();
  }
});

test("search and the dashboard card", async ({ adminPage: page }) => {
  const email = newEmail();
  await createCustomer(page, email, "Searchable Person");
  await page.goto(`${LIST}?q=${encodeURIComponent("Searchable Pers")}`);
  await expect(
    page.getByRole("link", { name: "Searchable Person" }),
  ).toBeVisible();
  await page.goto(`${LIST}?q=${encodeURIComponent("no such customer zz")}`);
  await expect(page.getByText("No customers match")).toBeVisible();

  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { level: 2, name: "Expiring in 30 days" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Expiring in 30 days" }).click();
  await expect(page).toHaveURL(/\/admin\/customers\?status=expiring$/);
});

test("a custom date starts empty and must be picked before saving", async ({
  adminPage: page,
}) => {
  const email = newEmail();
  await page.goto(`${LIST}/new`);
  const submit = page.getByRole("button", { name: "Create customer" });
  await waitForHydration(submit);
  await page.getByRole("textbox", { name: "Name" }).fill("Date Picker");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("radio", { name: "Choose a date" }).check();
  const day = page.getByLabel("Last day of access");
  await expect(day).toHaveValue("");
  // The earliest day offered is today in China time.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  await expect(day).toHaveAttribute("min", today);
  await expect(
    page.getByText("Pick a day to see when access ends."),
  ).toBeVisible();

  await submit.click();
  await expect(page.getByText("Pick the last day of access.")).toBeVisible();
  await expect(day).toHaveAttribute("aria-invalid", "true");
  expect(await db.collection("users").countDocuments({ email })).toBe(0);
});

test("unknown and malformed ids answer 404", async ({ adminPage: page }) => {
  for (const id of [new ObjectId().toHexString(), "not-an-id"]) {
    const response = await page.goto(`${LIST}/${id}`);
    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { level: 1, name: "Customer not found" }),
    ).toBeVisible();
  }
});

test("a customer gets 403 on the customers pages", async ({ browser }) => {
  const context = await browser.newContext({
    storageState: loadState("customer"),
  });
  const page = await context.newPage();
  for (const path of [LIST, `${LIST}/new`]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(403);
  }
  await expect(
    page.getByRole("button", { name: "Create customer" }),
  ).toHaveCount(0);
  await context.close();
});

test("axe passes on the list, new and customer pages, at 375 px without sideways scroll", async ({
  adminPage: page,
}) => {
  const email = newEmail();
  const id = await createCustomer(page, email, "Axe Check");
  for (const size of [{ width: 1280, height: 900 }, PHONE]) {
    await page.setViewportSize(size);
    for (const path of [LIST, `${LIST}/new`, `${LIST}/${id}`]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      expect(await horizontalOverflow(page)).toBe(0);
    }
    const block = page.getByRole("button", { name: "Block…" });
    await waitForHydration(block);
    await block.click();
    await expect(
      page.getByRole("dialog", { name: "Block customer" }),
    ).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
  }
});
