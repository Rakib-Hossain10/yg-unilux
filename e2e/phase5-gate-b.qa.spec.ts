// QA gate B (Phase 5, P6-P8 + China time) against the production build.
//
// 1. Temporary password (plan Q1, ADR 0077): shown once, never in the page
//    URL or any request URL, gone after a reload and after client
//    navigation, stored only as an argon2id hash, absent from the audit
//    trail; signing in with it only leads to /change-password.
// 2. The datasheet route and the restricted-data route for the new account
//    states (temporary password, expired, blocked) and a visitor: never a
//    presigned URL, never a download log row, never a restricted value.
// 3. Guard sweep over HTTP: an admin on a temporary password is sent to
//    change it, a blocked admin gets 403, a visitor is sent to sign in, on
//    every P7/P8 page and the dashboard; no customer data in the answer.
// 4. "New link…" on a filtered customers list (ADR 0077 §4): the copy-once
//    link stays while the dialog is open (after the general copy warning,
//    §3); closing it refreshes the list; the token is never in the URL or
//    the page afterwards.
// 5. /request-access: a draft product is never named; an existing
//    customer's email and a new one get the same thanks.
// 6. China time (ADR 0076): a browser in another zone prints exactly the
//    server's dates with no hydration error, admin and customer side.
// 7. Axe WCAG 2.2 AA and no sideways scroll at 375 px on the pages the P7/P8
//    specs do not cover: request detail, dashboard, customer page with the
//    temporary password shown, the list's "New link…" dialog.

import { randomUUID } from "node:crypto";

import {
  type APIRequestContext,
  type BrowserContextOptions,
  expect,
  type Page,
  request as playwrightRequest,
  test as base,
} from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";

import { E2E_CUSTOMER, E2E_READY_CUSTOMER } from "./fixtures/accounts";
import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import {
  axeViolations,
  horizontalOverflow,
  waitForHydration,
} from "./fixtures/product-page-helpers";
import { RESTRICTED } from "./fixtures/product-pages";

const BASE_URL = "http://localhost:3000";
const PHONE = { width: 375, height: 740 };
const LIST = "/admin/customers";
const HOUR = 3_600_000;
const SECRETS = Object.values(RESTRICTED.secret);
const THANKS = "Thank you. We have received your request and will be in touch.";

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
const contexts: APIRequestContext[] = [];
const draftId = new ObjectId();
const DRAFT_NAME = `QA Draft Unreleased ${draftId.toHexString().slice(-6)}`;
const requestId = new ObjectId();

/* Customer A: made in test 1, reused by the matrix and the zone tests. */
let customerA = { id: "", email: "", password: "" };

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  adminState = loadState("admin");
  client = await connectE2eDb();
  db = client.db();
  const now = new Date();
  // Raw insert: only what /request-access reads (status, name, slug).
  await db.collection("products").insertOne({
    _id: draftId,
    name: DRAFT_NAME,
    slug: `qa-draft-${draftId.toHexString()}`,
    status: "draft",
    mainCategory: new ObjectId(),
    variants: [{ modelNo: `QA-DRAFT-${draftId.toHexString().slice(-6)}` }],
    createdAt: now,
    updatedAt: now,
  });
  await db.collection("accessRequests").insertOne({
    _id: requestId,
    name: "Gate B Requester",
    email: `gate-b-request-${randomUUID().slice(0, 8)}@example.com`,
    company: "Requester Lighting Ltd",
    country: "Hong Kong",
    phone: "+852 5555 0000",
    message: "Please send the datasheets.\nThank you.",
    kind: "new",
    source: "form",
    status: "pending",
    consentAt: now,
    createdAt: now,
    updatedAt: now,
  });
});

test.afterAll(async () => {
  await Promise.all(contexts.map((context) => context.dispose()));
  const users = await db
    .collection("users")
    .find({ email: { $in: emails } }, { projection: { _id: 1 } })
    .toArray();
  const ids = users.map((user) => user._id);
  if (ids.length > 0) {
    await Promise.all([
      db.collection("sessions").deleteMany({ userId: { $in: ids } }),
      db.collection("accounts").deleteMany({ userId: { $in: ids } }),
      db.collection("downloadLogs").deleteMany({ user: { $in: ids } }),
      db
        .collection("verifications")
        .deleteMany({ value: { $in: ids.map((id) => id.toHexString()) } }),
    ]);
    await db.collection("users").deleteMany({ _id: { $in: ids } });
  }
  await db.collection("products").deleteOne({ _id: draftId });
  await db.collection("accessRequests").deleteOne({ _id: requestId });
  await db.collection("accessRequests").deleteMany({ email: { $in: emails } });
  await client.close();
});

function newEmail(): string {
  const email = `e2e-gateb-${randomUUID().slice(0, 12)}@example.com`;
  emails.push(email);
  return email;
}

/* Creates a customer through the "New customer" form (invite emailed). */
async function createCustomer(
  page: Page,
  name: string,
): Promise<{ id: string; email: string }> {
  const email = newEmail();
  await page.goto(`${LIST}/new`);
  const submit = page.getByRole("button", { name: "Create customer" });
  await waitForHydration(submit);
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("radio", { name: "6 months" }).check();
  await submit.click();
  await expect(
    page.getByRole("heading", { name: "Customer created" }),
  ).toBeVisible();
  const user = await db.collection("users").findOne({ email });
  if (!user) throw new Error("customer not created");
  return { id: user._id.toHexString(), email };
}

/* Sets a temporary password on the customer page and returns it. */
async function setTemporaryPassword(page: Page, id: string): Promise<string> {
  await page.goto(`${LIST}/${id}`);
  const open = page.getByRole("button", { name: "Set temporary password…" });
  await waitForHydration(open);
  await open.click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Set temporary password" })
    .click();
  const field = page.getByRole("textbox", { name: "Temporary password" });
  await expect(field).toBeVisible();
  const password = await field.inputValue();
  expect(password.length).toBeGreaterThanOrEqual(12);
  return password;
}

/*
 * POSTs a sign-in and returns its status. The per-IP sign-in limit (Better
 * Auth, a few per 10 s from localhost) is shared by every spec in the run:
 * a 429 is waited out instead of failing.
 */
async function signInStatus(
  context: APIRequestContext,
  email: string,
  password: string,
): Promise<number> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await context.post("/api/auth/sign-in/email", {
      data: { email, password },
      headers: { origin: BASE_URL },
    });
    if (response.status() !== 429 || attempt >= 3) return response.status();
    const wait = Number(response.headers()["x-retry-after"] ?? "10");
    await new Promise((resolve) =>
      setTimeout(resolve, (Math.min(wait, 30) + 1) * 1000),
    );
  }
}

/* An API context signed in with email + password (fresh cookies). */
async function signedIn(
  email: string,
  password: string,
): Promise<APIRequestContext> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL });
  contexts.push(context);
  expect(await signInStatus(context, email, password), `sign in ${email}`).toBe(
    200,
  );
  return context;
}

const setUser = (id: string, fields: Record<string, unknown>) =>
  db.collection("users").updateOne({ _id: new ObjectId(id) }, { $set: fields });

test("a temporary password is shown once: never in a URL, gone after reload, stored hashed, not audited", async ({
  adminPage: page,
}) => {
  const { id, email } = await createCustomer(page, "Gate B Temp");
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));

  const password = await setTemporaryPassword(page, id);
  customerA = { id, email, password };
  await expect(
    page.getByText("Copy the password now: it is shown only once"),
  ).toBeVisible();
  // The page refreshed underneath (the action calls refresh()); the card
  // still holds the password.
  await expect(
    page.getByRole("textbox", { name: "Temporary password" }),
  ).toHaveValue(password);

  expect(page.url()).not.toContain(password);
  expect(urls.filter((url) => url.includes(password))).toEqual([]);
  expect(
    urls.filter((url) => url.includes(encodeURIComponent(password))),
  ).toEqual([]);

  // Gone after a reload...
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.content()).not.toContain(password);
  await expect(
    page.getByRole("textbox", { name: "Temporary password" }),
  ).toHaveCount(0);
  // ...and after leaving the page by client navigation and coming back.
  const again = await setTemporaryPassword(page, id);
  customerA.password = again;
  await page
    .getByRole("link", { name: "Customers", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`${LIST}$`));
  await page.getByRole("link", { name: "Gate B Temp" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Gate B Temp" }),
  ).toBeVisible();
  expect(await page.content()).not.toContain(again);

  // Stored only as an argon2id hash; never in the audit trail or the user.
  const account = await db
    .collection("accounts")
    .findOne({ userId: new ObjectId(id), providerId: "credential" });
  expect(String(account?.password ?? "")).toMatch(/^\$argon2id\$/);
  const audit = await db.collection("auditLog").find({}).toArray();
  const user = await db.collection("users").findOne({ _id: new ObjectId(id) });
  for (const secret of [password, again]) {
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(user)).not.toContain(secret);
  }
  expect(user?.mustChangePassword).toBe(true);
  // The first password died with the second.
  const old = await playwrightRequest.newContext({ baseURL: BASE_URL });
  contexts.push(old);
  expect(await signInStatus(old, email, password)).toBe(401);

  // Signing in with it leads only to /change-password.
  const customer = await signedIn(email, again);
  const downloads = await customer.get("/my-downloads", { maxRedirects: 0 });
  expect([303, 307]).toContain(downloads.status());
  expect(downloads.headers()["location"]).toMatch(/^\/change-password/);
});

test("datasheet and restricted-data routes for a temporary password, expired, blocked and signed out", async () => {
  expect(customerA.id).not.toBe("");
  const productId = RESTRICTED.productId;
  const logs = () =>
    db
      .collection("downloadLogs")
      .countDocuments({ user: new ObjectId(customerA.id) });
  const customer = await signedIn(customerA.email, customerA.password);
  const visitor = await playwrightRequest.newContext({ baseURL: BASE_URL });
  contexts.push(visitor);

  async function expectRefused(
    context: APIRequestContext,
    label: string,
    location: RegExp,
  ) {
    const datasheet = await context.get(`/api/datasheet/${productId}`, {
      maxRedirects: 0,
    });
    expect(datasheet.status(), label).toBe(303);
    const to = datasheet.headers()["location"] ?? "";
    expect(to, label).toMatch(location);
    expect(new URL(to, BASE_URL).host, label).toBe("localhost:3000");
    expect(datasheet.headers()["cache-control"], label).toBe(
      "private, no-store",
    );

    const restricted = await context.get(
      `/api/catalog/restricted/${productId}`,
    );
    const body = await restricted.text();
    expect(JSON.parse(body), label).toMatchObject({ allowed: false });
    expect(restricted.headers()["cache-control"] ?? "", label).toContain(
      "no-store",
    );
    for (const secret of SECRETS) expect(body, label).not.toContain(secret);

    const html = await (
      await context.get(`/product/${RESTRICTED.slug}`)
    ).text();
    for (const secret of SECRETS)
      expect(html, `${label} page`).not.toContain(secret);
  }

  const before = await logs();
  await expectRefused(
    customer,
    "temporary password",
    /^\/change-password\?next=%2Fproduct%2F/,
  );

  await setUser(customerA.id, {
    mustChangePassword: false,
    accessExpiresAt: new Date(Date.now() - 60_000),
  });
  await expectRefused(
    customer,
    "expired",
    new RegExp(`^/request-access\\?renew=1&product=${productId}$`),
  );

  await setUser(customerA.id, {
    accessExpiresAt: new Date(Date.now() + 30 * 24 * HOUR),
    banned: true,
    banReason: "QA gate B",
  });
  await expectRefused(customer, "blocked", /^\/(request-access|login)/);

  await expectRefused(visitor, "visitor", /^\/login\?next=%2Fproduct%2F/);
  expect(await logs()).toBe(before);

  await setUser(customerA.id, { banned: false, banReason: null });
});

test("guard sweep over HTTP: temporary-password admin, blocked admin and visitor on every P7/P8 page", async ({
  adminPage: page,
}) => {
  const { id, email } = await createCustomer(page, "Gate B Second Admin");
  const password = await setTemporaryPassword(page, id);
  await setUser(id, { role: "admin" });
  const otherAdmin = await signedIn(email, password);
  const visitor = await playwrightRequest.newContext({ baseURL: BASE_URL });
  contexts.push(visitor);

  const paths = [
    "/admin",
    "/admin/access-requests",
    "/admin/access-requests?tab=handled",
    `/admin/access-requests/${requestId.toHexString()}`,
    LIST,
    `${LIST}?status=expiring`,
    `${LIST}?status=invite_expired`,
    `${LIST}/new`,
    `${LIST}/${customerA.id}`,
  ];
  const leaks = [
    customerA.email,
    "Gate B Requester",
    "Requester Lighting Ltd",
    E2E_CUSTOMER.email,
  ];

  // The real admin's pages are never stored by a browser or CDN.
  const realAdmin = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    storageState: adminState,
  });
  contexts.push(realAdmin);
  for (const path of paths) {
    const response = await realAdmin.get(path, { maxRedirects: 0 });
    expect(response.status(), `admin ${path}`).toBe(200);
    const cache = response.headers()["cache-control"] ?? "";
    expect(cache, path).toContain("no-store");
    expect(cache, path).not.toMatch(/public|s-maxage/);
  }

  for (const path of paths) {
    const response = await otherAdmin.get(path, { maxRedirects: 0 });
    expect([303, 307], `temp admin ${path}`).toContain(response.status());
    expect(response.headers()["location"], path).toMatch(/^\/change-password/);
    const body = await response.text();
    for (const leak of leaks) expect(body, path).not.toContain(leak);
  }

  await setUser(id, {
    banned: true,
    banReason: "QA gate B",
    mustChangePassword: false,
  });
  for (const path of paths) {
    const response = await otherAdmin.get(path, { maxRedirects: 0 });
    expect(response.status(), `blocked admin ${path}`).toBe(403);
    const body = await response.text();
    for (const leak of leaks) expect(body, path).not.toContain(leak);
  }

  for (const path of paths) {
    const response = await visitor.get(path, { maxRedirects: 0 });
    expect([303, 307], `visitor ${path}`).toContain(response.status());
    expect(response.headers()["location"], path).toMatch(/^\/login/);
  }

  // The admin's own account is not a customer page.
  const admin = await db
    .collection("users")
    .findOne({ email: "e2e-admin@example.com" });
  const own = await page.goto(`${LIST}/${admin?._id.toHexString()}`);
  expect(own?.status()).toBe(404);
});

test("'New link…' on a filtered list: the link stays while the dialog is open, closing refreshes the list", async ({
  adminPage: page,
}) => {
  const { id, email } = await createCustomer(page, "Gate B Listlink");
  // The invite's 72 h run out.
  const past = new Date(Date.now() - 80 * HOUR);
  await setUser(id, {
    invitedAt: past,
    inviteExpiresAt: new Date(past.getTime() + 72 * HOUR),
  });
  await db
    .collection("verifications")
    .updateMany(
      { value: id },
      { $set: { expiresAt: new Date(Date.now() - 8 * HOUR) } },
    );

  await page.goto(
    `${LIST}?status=invite_expired&q=${encodeURIComponent(email)}`,
  );
  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row).toBeVisible();
  const open = row.getByRole("button", { name: /New link/ });
  await waitForHydration(open);
  await open.click();
  const dialog = page.getByRole("dialog", { name: "New invite link" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Show once to copy…" }).click();
  // The general warning of the customers module (ADR 0077 §3), not the
  // website-form wording.
  await expect(
    dialog.getByText("Check who you send this link to"),
  ).toBeVisible();
  await expect(dialog.getByText(/came from the website form/)).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "I understand, show the link" })
    .click();
  const link = dialog.getByRole("textbox", {
    name: "Invite link",
    exact: true,
  });
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  const token = new URL(url).searchParams.get("token") ?? "";
  expect(token.length).toBeGreaterThan(10);

  // No server refresh yet: the row (now "pending" in the database) is still
  // listed behind the dialog, so the link was not lost.
  await page.waitForTimeout(1500);
  await expect(page.locator("table").getByText(email)).toHaveCount(1);
  await expect(link).toHaveValue(url);
  expect(page.url()).not.toContain(token);
  expect(await axeViolations(page)).toEqual([]);

  // Closing refreshes the list: the row leaves the "Invite expired" filter.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("table").getByText(email)).toHaveCount(0);
  expect(page.url()).not.toContain(token);
  expect(await page.content()).not.toContain(token);
  await page.reload();
  expect(await page.content()).not.toContain(token);
});

test("/request-access: a draft product is never named; known and unknown emails get the same thanks", async ({
  page,
}) => {
  const response = await page.goto(
    `/request-access?product=${draftId.toHexString()}`,
  );
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain(DRAFT_NAME);
  expect(html).not.toContain(`qa-draft-${draftId.toHexString()}`);
  // A published product is named, but none of its restricted values.
  const named = await page.request.get(
    `/request-access?product=${RESTRICTED.productId}`,
  );
  const namedHtml = await named.text();
  expect(namedHtml).toMatch(/Restricted RS-/);
  for (const secret of SECRETS) expect(namedHtml).not.toContain(secret);

  const form = page.locator('form:has(input[name="startedAt"])');
  const answers: string[] = [];
  for (const email of [
    E2E_CUSTOMER.email,
    `nobody-${randomUUID().slice(0, 8)}@example.com`,
  ]) {
    await page.goto("/request-access");
    const send = page.getByRole("button", { name: "Send request" });
    await waitForHydration(send);
    await form.getByLabel("Name").fill("Gate B Prober");
    await form.getByLabel("Work email").fill(email);
    await form.getByLabel("Company").fill("Probe Ltd");
    await form.getByLabel("Country").selectOption("United Kingdom");
    await form.getByLabel(/I agree that YG UniLUX keeps these details/).check();
    const startedAt = Number(
      (await page.locator('input[name="startedAt"]').inputValue()).split(
        ".",
      )[0],
    );
    const left = startedAt + 3500 - Date.now();
    if (left > 0) await page.waitForTimeout(left);
    await send.click();
    await expect(page.getByText(THANKS)).toBeVisible();
    answers.push(await page.locator("main").innerText());
  }
  expect(answers[0]).toBe(answers[1]);
  await db.collection("accessRequests").deleteMany({ name: "Gate B Prober" });
});

test("China time: a browser in another zone prints the server's dates, no hydration error", async ({
  browser,
}) => {
  await setUser(customerA.id, {
    accessExpiresAt: new Date("2027-01-31T15:59:59.999Z"),
    banned: false,
    mustChangePassword: false,
  });
  for (const timezoneId of [
    "America/Los_Angeles",
    "Europe/London",
    "Asia/Dubai",
  ]) {
    const context = await browser.newContext({
      storageState: adminState,
      timezoneId,
    });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(error.message));
    await page.goto(`${LIST}/${customerA.id}`);
    const save = page.getByRole("button", { name: "Save access" });
    await waitForHydration(save);
    await expect(
      page.getByText("Access until the end of 31 Jan 2027 (China time).", {
        exact: true,
      }),
    ).toBeVisible();
    // The picker's preview (computed in the browser): 12 months from the
    // current end, the same day the server would store.
    await expect(
      page.getByText("Access until the end of 31 Jan 2028 (China time).", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("radio", { name: "Choose a date" }).check();
    const chinaToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
    }).format(new Date());
    await expect(page.getByLabel("Last day of access")).toHaveAttribute(
      "min",
      chinaToday,
    );
    // The current end is ahead: the custom day starts on it (no "tonight" trap).
    await expect(page.getByLabel("Last day of access")).toHaveValue(
      "2027-01-31",
    );
    expect(
      problems.filter((text) =>
        /hydrat|#418|#423|#425|did not match/i.test(text),
      ),
      timezoneId,
    ).toEqual([]);
    await context.close();
  }

  // Customer side: the same end day on /my-downloads, from any zone.
  const context = await browser.newContext({
    timezoneId: "America/Los_Angeles",
  });
  expect(
    await signInStatus(
      context.request,
      E2E_READY_CUSTOMER.email,
      E2E_READY_CUSTOMER.password,
    ),
  ).toBe(200);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  await page.goto("/my-downloads");
  await expect(page.getByText("31 Mar 2099").first()).toBeVisible();
  expect(
    problems.filter((text) =>
      /hydrat|#418|#423|#425|did not match/i.test(text),
    ),
  ).toEqual([]);
  await context.close();
});

test("axe and 375 px: request detail, dashboard, customer page with the temporary password shown", async ({
  adminPage: page,
}) => {
  for (const size of [{ width: 1280, height: 900 }, PHONE]) {
    await page.setViewportSize(size);
    for (const path of [
      "/admin",
      `/admin/access-requests/${requestId.toHexString()}`,
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await axeViolations(page), `${path} @${size.width}`).toEqual([]);
      expect(await horizontalOverflow(page), `${path} @${size.width}`).toBe(0);
    }
  }
  // The request page renders the untrusted message as text, never markup.
  await page.goto(`/admin/access-requests/${requestId.toHexString()}`);
  await expect(page.getByText("Please send the datasheets.")).toBeVisible();

  await setTemporaryPassword(page, customerA.id);
  expect(await axeViolations(page)).toEqual([]);
  expect(await horizontalOverflow(page)).toBe(0);
  // Keyboard: the Copy button is reachable and labelled.
  await expect(
    page.getByRole("button", { name: "Copy password" }),
  ).toBeVisible();
});
