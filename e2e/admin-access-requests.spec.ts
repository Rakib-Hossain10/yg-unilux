// Phase 5 P7: the admin access-request queue against the production build.
// Manual WhatsApp entry → pending list + dashboard count; approve by email →
// the customer exists and the invite email is captured; approve with "show
// once to copy" → the link is shown once and is gone after a reload; the
// unverified-contact warning for website-form requests; the existing-customer
// notice; reject with the decline email, then delete; unknown ids 404; a
// customer gets 403; axe WCAG 2.2 AA and no sideways scroll at 375 px.
// Everything this spec creates is removed in afterAll, so list counts in
// other specs are unaffected.

import { randomUUID } from "node:crypto";

import {
  type BrowserContextOptions,
  expect,
  type Page,
  test as base,
} from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";

import { E2E_READY_CUSTOMER } from "./fixtures/accounts";
import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import { linkIn, waitForEmail } from "./fixtures/emails";
import {
  axeViolations,
  horizontalOverflow,
  waitForHydration,
} from "./fixtures/product-page-helpers";

const PHONE = { width: 375, height: 740 };
const LIST = "/admin/access-requests";

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
  const all = [...emails, E2E_READY_CUSTOMER.email];
  await db.collection("accessRequests").deleteMany({ email: { $in: all } });
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
  const email = `e2e-queue-${randomUUID().slice(0, 12)}@example.com`;
  emails.push(email);
  return email;
}

/* A pending request as the website form leaves it. */
async function insertFormRequest(email: string, name = "Form Person") {
  const now = new Date();
  const { insertedId } = await db.collection("accessRequests").insertOne({
    name,
    email,
    company: "Form Lighting Ltd",
    country: "Hong Kong",
    kind: "new",
    source: "form",
    status: "pending",
    message: "Please send the Arc datasheet.",
    consentAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return insertedId.toHexString();
}

async function openApprove(page: Page) {
  const approve = page.getByRole("button", { name: "Approve…" });
  await waitForHydration(approve);
  await approve.click();
  await expect(
    page.getByRole("dialog", { name: "Approve request" }),
  ).toBeVisible();
  // Unnamed: the title becomes "Request approved" once it is saved.
  return page.getByRole("dialog");
}

test("a WhatsApp request added by hand waits in the pending list and on the dashboard", async ({
  adminPage: page,
}) => {
  const email = newEmail();
  await page.goto(LIST);
  const add = page.getByRole("button", { name: "Add WhatsApp request" });
  await waitForHydration(add);
  await add.click();
  const dialog = page.getByRole("dialog", { name: "Add a WhatsApp request" });

  // Client-side Zod: nothing is sent while the name is missing.
  await dialog.getByRole("button", { name: "Add request" }).click();
  await expect(dialog.getByLabel("Name")).toHaveAttribute(
    "aria-invalid",
    "true",
  );

  await dialog.getByLabel("Name").fill("Wang Hoi Lam");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel(/Company/).fill("Harbour Lighting Ltd");
  await dialog.getByLabel(/Country/).fill("Hong Kong");
  await dialog.getByRole("radio", { name: "Renewal" }).check();
  await dialog.getByRole("button", { name: "Add request" }).click();

  await expect(page).toHaveURL(
    /\/admin\/access-requests\/[0-9a-f]{24}\?notice=created$/,
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Wang Hoi Lam" }),
  ).toBeVisible();
  await expect(page.getByText("Request added.")).toBeVisible();
  await expect(page.getByText(/Renewal · WhatsApp/)).toBeVisible();

  const stored = await db.collection("accessRequests").findOne({ email });
  expect(stored).toMatchObject({
    source: "whatsapp",
    status: "pending",
    kind: "renewal",
  });

  // The same email can't be added twice while pending.
  await page.goto(LIST);
  await waitForHydration(add);
  await add.click();
  await dialog.getByLabel("Name").fill("Wang Hoi Lam");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByRole("button", { name: "Add request" }).click();
  await expect(dialog.getByText(/already in the queue/)).toBeVisible();
  await page.keyboard.press("Escape");

  const main = page.locator("main#main");
  await expect(main.getByRole("link", { name: "Wang Hoi Lam" })).toBeVisible();

  const pendingCount = await db
    .collection("accessRequests")
    .countDocuments({ status: "pending" });
  await page.goto("/admin");
  const card = page
    .locator("main#main")
    .getByRole("listitem")
    .filter({
      has: page.getByRole("heading", { level: 2, name: "Access requests" }),
    });
  // The headline is followed by the "Action needed" badge.
  await expect(card.getByRole("definition").first()).toHaveText(
    new RegExp(`^${pendingCount}(?:Action needed)?$`),
  );
});

test("approve by email creates the customer and emails the invite", async ({
  adminPage: page,
}) => {
  const email = newEmail();
  const id = await insertFormRequest(email, "Chan Tai Man");
  await page.goto(`${LIST}/${id}`);
  await expect(page.getByText("No account uses this email yet.")).toBeVisible();

  const dialog = await openApprove(page);
  await dialog.getByLabel("Name").fill("Chan Tai-man");
  await dialog.getByRole("radio", { name: "6 months" }).check();
  await expect(
    dialog.getByText(/Access until the end of .* \(China time\)\./),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Approve and create account" })
    .click();

  await expect(
    dialog.getByRole("heading", { name: "Request approved" }),
  ).toBeVisible();
  await expect(dialog.getByText("Invite emailed")).toBeVisible();
  // No link on screen for an emailed invite.
  await expect(dialog.getByLabel("Invite link")).toHaveCount(0);

  const user = await db.collection("users").findOne({ email });
  expect(user).toMatchObject({
    name: "Chan Tai-man",
    role: "customer",
    mustChangePassword: true,
    company: "Form Lighting Ltd",
  });
  const days =
    ((user?.accessExpiresAt as Date).getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(175);
  expect(days).toBeLessThan(186);

  const invite = await waitForEmail(email, /Set your .* password/);
  expect(linkIn(invite, /\/reset-password\?token=/)).toMatch(/invite=1/);

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Approved", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve…" })).toHaveCount(0);
  const stored = await db
    .collection("accessRequests")
    .findOne({ _id: new ObjectId(id) });
  expect(stored?.status).toBe("approved");
});

test("show once to copy: the warning for form requests, the link once, gone after reload", async ({
  adminPage: page,
}) => {
  const email = newEmail();
  const id = await insertFormRequest(email, "Lee Ka Yan");
  await page.goto(`${LIST}/${id}`);

  const dialog = await openApprove(page);
  await expect(dialog.getByText("Check who you send this link to")).toHaveCount(
    0,
  );
  await dialog.getByRole("radio", { name: /Show once to copy/ }).check();
  await expect(
    dialog.getByText("Check who you send this link to"),
  ).toBeVisible();
  await dialog.getByRole("radio", { name: "No expiry" }).check();
  await dialog
    .getByRole("button", { name: "Approve and create account" })
    .click();

  const link = dialog.getByLabel("Invite link");
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  expect(url).toMatch(/\/reset-password\?token=[^&]+&invite=1$/);
  expect(page.url()).not.toContain("token");

  const user = await db.collection("users").findOne({ email });
  expect(user).toMatchObject({ role: "customer", accessExpiresAt: null });

  const token = new URL(url).searchParams.get("token") ?? "";
  expect(token.length).toBeGreaterThan(10);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.content()).not.toContain(token);
});

test("an existing customer's request extends access instead of a second account", async ({
  adminPage: page,
}) => {
  const id = await insertFormRequest(E2E_READY_CUSTOMER.email, "Ready Again");
  await page.goto(`${LIST}/${id}`);
  await expect(
    page.getByText(/Already a customer\. Approving extends their access/),
  ).toBeVisible();

  const dialog = await openApprove(page);
  await expect(dialog.getByText("Existing customer")).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Approve and extend access" }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("Email the customer their new end date"),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The list marks the row too.
  await page.goto(LIST);
  const row = page.getByRole("row").filter({ hasText: "Ready Again" });
  await expect(row.getByText("Existing customer")).toBeVisible();
});

test("reject with the decline email, then delete the handled request", async ({
  adminPage: page,
}) => {
  const email = newEmail();
  const id = await insertFormRequest(email, "Reject Me");
  await page.goto(`${LIST}/${id}`);

  const reject = page.getByRole("button", { name: "Reject…" });
  await waitForHydration(reject);
  await reject.click();
  const dialog = page.getByRole("dialog", { name: "Reject request" });
  await dialog.getByLabel(/Reason/).fill("Not a trade buyer");
  await expect(
    dialog.getByLabel("Send a polite decline email"),
  ).not.toBeChecked();
  await dialog.getByLabel("Send a polite decline email").check();
  await dialog.getByRole("button", { name: "Reject request" }).click();

  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Request rejected. The decline email was sent."),
  ).toBeVisible();
  await expect(page.getByText("Not a trade buyer")).toBeVisible();
  await waitForEmail(email, /datasheet access request/);
  const stored = await db
    .collection("accessRequests")
    .findOne({ _id: new ObjectId(id) });
  expect(stored).toMatchObject({
    status: "rejected",
    rejectReason: "Not a trade buyer",
  });

  const remove = page.getByRole("button", { name: "Delete request…" });
  await waitForHydration(remove);
  await remove.click();
  const confirm = page.getByRole("alertdialog", {
    name: "Delete this request?",
  });
  await confirm.getByRole("button", { name: "Delete request" }).click();
  await expect(page).toHaveURL(
    /\/admin\/access-requests\?tab=handled&notice=deleted$/,
  );
  await expect(page.getByText("Request deleted.")).toBeVisible();
  expect(
    await db
      .collection("accessRequests")
      .countDocuments({ _id: new ObjectId(id) }),
  ).toBe(0);
});

test("reject with the reason left blank sends no email", async ({
  adminPage: page,
}) => {
  const email = newEmail();
  const id = await insertFormRequest(email, "Blank Reason");
  await page.goto(`${LIST}/${id}`);
  const reject = page.getByRole("button", { name: "Reject…" });
  await waitForHydration(reject);
  await reject.click();
  const dialog = page.getByRole("dialog", { name: "Reject request" });
  await dialog.getByRole("button", { name: "Reject request" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Request rejected. No email was sent."),
  ).toBeVisible();
  const stored = await db
    .collection("accessRequests")
    .findOne({ _id: new ObjectId(id) });
  expect(stored?.status).toBe("rejected");
  expect(stored?.rejectReason ?? null).toBeNull();
});

test("unknown and malformed ids answer 404", async ({ adminPage: page }) => {
  for (const id of [new ObjectId().toHexString(), "not-an-id"]) {
    const response = await page.goto(`${LIST}/${id}`);
    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { level: 1, name: "Request not found" }),
    ).toBeVisible();
  }
});

test("a customer gets 403 on the queue", async ({ browser }) => {
  const context = await browser.newContext({
    storageState: loadState("customer"),
  });
  const page = await context.newPage();
  const response = await page.goto(LIST);
  expect(response?.status()).toBe(403);
  await expect(
    page.getByRole("button", { name: "Add WhatsApp request" }),
  ).toHaveCount(0);
  await context.close();
});

test("axe passes on the list and an open approve dialog, at 375 px without sideways scroll", async ({
  adminPage: page,
}) => {
  const id = await insertFormRequest(newEmail(), "Axe Check");
  for (const size of [{ width: 1280, height: 900 }, PHONE]) {
    await page.setViewportSize(size);
    await page.goto(LIST);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBe(0);

    await page.goto(`${LIST}/${id}`);
    expect(await axeViolations(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBe(0);

    const dialog = await openApprove(page);
    await dialog.getByRole("radio", { name: "Choose a date" }).check();
    await expect(dialog.getByLabel("Last day of access")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
  }
});
