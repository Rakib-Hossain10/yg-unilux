// Phase 5 P9 exit e2e: the whole restricted-access journey on the production
// build, in one serial flow, against the in-memory database and the R2/Resend
// fakes (e2e/fake-providers):
//   1. a visitor sends /request-access for a published product (signed form
//      stamp, ADR 0078: waits past the minimum fill time);
//   2. the admin approves it in /admin/access-requests with 12 months →
//      the customer exists and the invite email lands in the Resend sink;
//   3. invite link → set password → sign in → /my-downloads shows the end
//      day in China time (ADR 0076);
//   4. product page → "Download datasheet" → 303 to a presigned GET that the
//      R2 fake serves as an attachment (a real browser download event), a
//      downloadLogs row exists, the history lists it;
//   5. the admin sets the last day in the past (customers module) → the
//      button says expired, the route sends the customer to
//      /request-access?renew=1&product=<id>, no new log row;
//   6. the admin moves the last day 5 China days ahead → the cron
//      (GET /api/cron/access-expiry, Bearer E2E_CRON_SECRET) sends exactly
//      one reminder to the customer and a digest to the company inbox; a
//      second run sends nothing.
// Plus: a Chromium speculation-rules prerender of /api/datasheet/<id> writes
// no log row and the click afterwards still downloads (gate C manual item),
// and axe on the six public account pages at 360 and 1280 px.
//
// page.route()/context.route() never see a navigation's REDIRECTED request,
// so the browser would try the real R2 host. The download click is therefore
// routed: the route handler sends the real request to the app (route.fetch,
// no redirects followed, the context's cookies), and when the app answers 303
// to the R2 host it fetches that presigned URL from the R2 fake and fulfils
// the navigation with the fake's answer. Any other answer is passed through.
// Everything this spec creates is removed in afterAll.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  expect,
  type Page,
  request as playwrightRequest,
  test,
} from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";

import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import { linkIn, sentEmails, waitForEmail } from "./fixtures/emails";
import {
  axeViolations,
  gotoAndWaitForRestricted,
  waitForHydration,
} from "./fixtures/product-page-helpers";
import { RESTRICTED } from "./fixtures/product-pages";
import { putR2Object } from "./fixtures/providers";
import {
  E2E_CRON_SECRET,
  E2E_FAKE_PROVIDERS_URL,
} from "./fixtures/providers-port";

const BASE_URL = "http://localhost:3000";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PRODUCT_ID = RESTRICTED.productId;
const PRODUCT_PATH = `/product/${RESTRICTED.slug}`;
const ROUTE_PATH = `/api/datasheet/${PRODUCT_ID}`;
const RENEW_PATH = `/request-access?renew=1&product=${PRODUCT_ID}`;
const MIN_FILL_MS = 3000;
const THANKS = "Thank you. We have received your request and will be in touch.";
const TIME_ZONE = "Asia/Shanghai";
const DAY = 86_400_000;

// Its own per-IP buckets (sign-in, request form), apart from other specs'.
const NETWORK = { "x-vercel-forwarded-for": "203.0.113.91" };

const RUN = randomUUID().slice(0, 8);
const CUSTOMER = {
  name: "Journey Customer",
  email: `e2e-journey-${RUN}@example.com`,
  company: "Journey Lighting Ltd",
  password: `journey password ${RUN} long`,
};
const COMPANY_INBOX = `e2e-company-${RUN}@example.com`;
const FILE_NAME = `Restricted journey ${RUN}.xlsx`;
const BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from(`e2e-journey-datasheet-${RUN}`),
]);

type StorageState = Exclude<BrowserContextOptions["storageState"], undefined>;

let client: MongoClient;
let db: Db;
let adminState: StorageState;
let datasheetId: ObjectId;
let datasheetInserted = false;
let savedCompanyEmail: Record<string, unknown> | null = null;
let customerId = "";
let customerContext: BrowserContext | undefined;
let customerPage: Page;

test.describe.configure({ mode: "serial" });

/* "YYYY-MM-DD" in China time, `offset` days from today. */
function chinaDayKey(offset = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(
    new Date(Date.now() + offset * DAY),
  );
}

/* "10 Oct 2026": the day of `instant` in China time (formatDate's shape). */
function chinaDay(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("day")} ${part("month")} ${part("year")}`;
}

/* The end of a China day: 23:59:59.999 at +08:00 = 15:59:59.999Z. */
function expectEndOfChinaDay(instant: Date): void {
  expect(instant.toISOString()).toMatch(/T15:59:59\.999Z$/);
}

const logsForCustomer = () =>
  db
    .collection("downloadLogs")
    .countDocuments({ user: new ObjectId(customerId) });

async function customerDoc() {
  return db.collection("users").findOne({ email: CUSTOMER.email });
}

/*
 * Routes the datasheet route for `context`: the app's real answer, and when
 * it is a 303 to the R2 host, the R2 fake's answer to that presigned GET.
 * Returns the app answers seen, for assertions.
 */
async function routeDownloads(context: BrowserContext) {
  const seen: { status: number; location: string; purpose: string }[] = [];
  await context.route(/\/api\/datasheet\//, async (route) => {
    const headers = route.request().headers();
    const reply = await route.fetch({ maxRedirects: 0 });
    const location = reply.headers()["location"] ?? "";
    seen.push({
      status: reply.status(),
      location,
      purpose: headers["sec-purpose"] ?? headers["purpose"] ?? "",
    });
    if (
      reply.status() === 303 &&
      /\.r2\.cloudflarestorage\.com$/.test(
        location ? new URL(location, BASE_URL).hostname : "",
      )
    ) {
      const target = new URL(location);
      const file = await fetch(
        `${E2E_FAKE_PROVIDERS_URL}${target.pathname}${target.search}`,
        { headers: { "x-e2e-host": target.hostname } },
      );
      await route.fulfill({
        status: file.status,
        headers: {
          "content-type": file.headers.get("content-type") ?? "",
          "content-disposition": file.headers.get("content-disposition") ?? "",
        },
        body: Buffer.from(await file.arrayBuffer()),
      });
      return;
    }
    await route.fulfill({ response: reply });
  });
  return seen;
}

/* Runs the expiry cron the way Vercel Cron calls it. */
async function runCron() {
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const reply = await api.get("/api/cron/access-expiry", {
      headers: { authorization: `Bearer ${E2E_CRON_SECRET}` },
      maxRedirects: 0,
    });
    expect(reply.headers()["cache-control"]).toBe("private, no-store");
    return {
      status: reply.status(),
      body: (await reply.json()) as Record<string, unknown>,
    };
  } finally {
    await api.dispose();
  }
}

test.beforeAll(async () => {
  adminState = loadState("admin");
  client = await connectE2eDb();
  db = client.db();

  // The seeded RESTRICTED product points at a datasheet id with no record
  // ("only datasheetId != null matters to the page"): give it a real file.
  const product = await db
    .collection("products")
    .findOne(
      { _id: new ObjectId(PRODUCT_ID) },
      { projection: { datasheetId: 1 } },
    );
  if (!product?.datasheetId) throw new Error("RESTRICTED has no datasheetId");
  datasheetId = product.datasheetId as ObjectId;
  if (
    (await db.collection("datasheets").countDocuments({ _id: datasheetId })) ===
    0
  ) {
    const storageKey = `datasheets/${randomUUID()}.xlsx`;
    const now = new Date();
    await db.collection("datasheets").insertOne({
      _id: datasheetId,
      storageKey,
      fileName: FILE_NAME,
      size: BYTES.length,
      mimeType: XLSX,
      uploadedBy: new ObjectId(),
      createdAt: now,
      updatedAt: now,
    });
    datasheetInserted = true;
    await putR2Object(storageKey, BYTES);
  }

  // The company inbox for the request alert and the cron digest.
  savedCompanyEmail = await db
    .collection("siteContent")
    .findOne({ key: "settings.companyEmail" });
  await db
    .collection("siteContent")
    .updateOne(
      { key: "settings.companyEmail" },
      { $set: { key: "settings.companyEmail", value: COMPANY_INBOX } },
      { upsert: true },
    );
});

test.afterAll(async () => {
  await customerContext?.close();
  if (datasheetInserted) {
    await db.collection("datasheets").deleteOne({ _id: datasheetId });
  }
  if (savedCompanyEmail) {
    await db
      .collection("siteContent")
      .replaceOne({ key: "settings.companyEmail" }, savedCompanyEmail);
  } else {
    await db
      .collection("siteContent")
      .deleteOne({ key: "settings.companyEmail" });
  }
  await db.collection("accessRequests").deleteMany({ email: CUSTOMER.email });
  const user = await customerDoc();
  if (user) {
    const id = user._id as ObjectId;
    await Promise.all([
      db.collection("sessions").deleteMany({ userId: id }),
      db.collection("accounts").deleteMany({ userId: id }),
      db.collection("verifications").deleteMany({ value: id.toHexString() }),
      db.collection("downloadLogs").deleteMany({ user: id }),
    ]);
    await db.collection("users").deleteOne({ _id: id });
  }
  await client.close();
});

test("1. a visitor asks for access from the product page", async ({
  browser,
}) => {
  customerContext = await browser.newContext({ extraHTTPHeaders: NETWORK });
  customerPage = await customerContext.newPage();
  const page = customerPage;

  await gotoAndWaitForRestricted(page, PRODUCT_PATH);
  const slot = page.locator('[data-slot="datasheet"]');
  await expect(
    slot.getByRole("link", { name: "Request access" }),
  ).toHaveAttribute("href", `/request-access?product=${PRODUCT_ID}`);
  await slot.getByRole("link", { name: "Request access" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/request-access\\?product=${PRODUCT_ID}$`),
  );

  const form = page.locator('form:has(input[name="startedAt"])');
  const send = page.getByRole("button", { name: "Send request" });
  await waitForHydration(send);
  await form.getByLabel("Name").fill(CUSTOMER.name);
  await form.getByLabel("Work email").fill(CUSTOMER.email);
  await form.getByLabel("Company").fill(CUSTOMER.company);
  await form.getByLabel("Country").selectOption("Hong Kong");
  await page.getByLabel(/^Message/).fill("Datasheets for a hotel lobby.");
  await form.getByLabel(/I agree that YG UniLUX keeps these details/).check();

  // The signed stamp "<ms>.<MAC>": wait out the minimum fill time from it.
  const stamp = await page.locator('input[name="startedAt"]').inputValue();
  expect(stamp).toMatch(/^\d{1,15}\.[A-Za-z0-9_-]{43}$/);
  const left = Number(stamp.split(".")[0]) + MIN_FILL_MS + 500 - Date.now();
  if (left > 0) await page.waitForTimeout(left);
  await send.click();
  await expect(page.getByText(THANKS)).toBeVisible();

  const rows = await db
    .collection("accessRequests")
    .find({ email: CUSTOMER.email })
    .toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "pending",
    source: "form",
    kind: "new",
    company: CUSTOMER.company,
  });
  expect(String(rows[0]?.product)).toBe(PRODUCT_ID);

  // The company alert names no message content in its subject.
  const alert = await waitForEmail(
    COMPANY_INBOX,
    /New datasheet access request/,
  );
  expect(alert.subject).not.toContain(CUSTOMER.name);
});

test("2. the admin approves with 12 months and the invite is emailed", async ({
  browser,
}) => {
  const request = await db
    .collection("accessRequests")
    .findOne({ email: CUSTOMER.email });
  const admin = await browser.newContext({ storageState: adminState });
  try {
    const page = await admin.newPage();
    await page.goto("/admin/access-requests");
    await page
      .locator("main#main")
      .getByRole("link", { name: CUSTOMER.name })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/admin/access-requests/${String(request?._id)}$`),
    );
    await expect(
      page.getByText("No account uses this email yet."),
    ).toBeVisible();

    const approve = page.getByRole("button", { name: "Approve…" });
    await waitForHydration(approve);
    await approve.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "12 months" }).check();
    await expect(
      dialog.getByText(/Access until the end of .* \(China time\)\./),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Approve and create account" })
      .click();
    await expect(dialog.getByText("Invite emailed")).toBeVisible();
    await expect(dialog.getByLabel("Invite link")).toHaveCount(0);
  } finally {
    await admin.close();
  }

  const user = await customerDoc();
  expect(user).toMatchObject({
    role: "customer",
    mustChangePassword: true,
    company: CUSTOMER.company,
  });
  customerId = (user?._id as ObjectId).toHexString();
  const until = user?.accessExpiresAt as Date;
  expectEndOfChinaDay(until);
  const days = (until.getTime() - Date.now()) / DAY;
  expect(days).toBeGreaterThan(360);
  expect(days).toBeLessThan(368);
  expect(
    (await db.collection("accessRequests").findOne({ email: CUSTOMER.email }))
      ?.status,
  ).toBe("approved");
});

test("3. the invite link sets the password, sign-in lands on /my-downloads in China time", async () => {
  const page = customerPage;
  const invite = await waitForEmail(CUSTOMER.email, /Set your .* password/);
  const link = linkIn(invite, /\/reset-password\?token=/);
  expect(link).toMatch(/invite=1/);
  // The emailed link points at the app; open it on the test server.
  const url = new URL(link);
  await page.goto(`${url.pathname}${url.search}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Set your password" }),
  ).toBeVisible();
  const submit = page.getByRole("button", { name: "Set password" });
  await waitForHydration(submit);
  await page.getByLabel("Password", { exact: true }).fill(CUSTOMER.password);
  await page.getByLabel("Repeat password").fill(CUSTOMER.password);
  await submit.click();
  await expect(page).toHaveURL(/\/login\?reset=1$/);

  await page.getByLabel("Email").fill(CUSTOMER.email);
  await page.getByLabel("Password", { exact: true }).fill(CUSTOMER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/my-downloads$/);

  const user = await customerDoc();
  expect(user?.mustChangePassword).toBe(false);
  const until = user?.accessExpiresAt as Date;
  await expect(page.getByText(`Active until ${chinaDay(until)}`)).toBeVisible();
  await expect(
    page.locator(`time[datetime="${until.toISOString()}"]`),
  ).toBeVisible();
  await expect(page.getByText("No downloads yet.")).toBeVisible();
});

test("4. the product page downloads through the R2 fake, logs it, and the history shows it", async () => {
  const page = customerPage;
  const seen = await routeDownloads(page.context());
  const before = await logsForCustomer();

  await gotoAndWaitForRestricted(page, PRODUCT_PATH);
  const button = page
    .locator('[data-slot="datasheet"]')
    .getByRole("link", { name: "Download datasheet" });
  await expect(button).toHaveAttribute("href", ROUTE_PATH);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    button.click(),
  ]);
  expect(download.suggestedFilename()).toBe(FILE_NAME);
  const saved = await download.path();
  expect(saved).not.toBeNull();
  expect(readFileSync(saved).equals(BYTES)).toBe(true);

  // The app's answer: 303 to a 60 s presigned GET on the R2 host.
  expect(seen).toHaveLength(1);
  expect(seen[0]?.status).toBe(303);
  const location = new URL(seen[0]?.location ?? "");
  expect(location.hostname).toMatch(/\.r2\.cloudflarestorage\.com$/);
  expect(location.searchParams.get("X-Amz-Expires")).toBe("60");

  expect(await logsForCustomer()).toBe(before + 1);
  const log = await db
    .collection("downloadLogs")
    .findOne({ user: new ObjectId(customerId) });
  expect(String(log?.product)).toBe(PRODUCT_ID);
  expect(String(log?.datasheet)).toBe(datasheetId.toHexString());

  await page.goto("/my-downloads");
  const rows = page
    .getByRole("list")
    .filter({ has: page.locator("time") })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await expect(
    rows.first().getByRole("link", { name: /Download again/ }),
  ).toHaveAttribute("href", ROUTE_PATH);
  await page.context().unroute(/\/api\/datasheet\//);
});

/*
 * A page of our own on the app's origin (no CSP) carrying speculation rules
 * for the route, as a prefetching page or an address-bar prerender would.
 * Chromium's speculative requests never reach Playwright's route handlers,
 * so their effect is read from the database and from the click.
 */
async function speculationPage(browser: Browser) {
  const context = await browser.newContext({
    storageState: await customerPage.context().storageState(),
    extraHTTPHeaders: NETWORK,
  });
  const page = await context.newPage();
  await page.route(`${BASE_URL}/__e2e-speculation`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><title>spec</title>
<script type="speculationrules">${JSON.stringify({
        prerender: [{ source: "list", urls: [ROUTE_PATH] }],
        prefetch: [{ source: "list", urls: [ROUTE_PATH] }],
      })}</script>
<a id="dl" href="${ROUTE_PATH}">Download</a></html>`,
    }),
  );
  return { context, page };
}

test("gate C: a Chromium prefetch/prerender of the datasheet route writes no log row", async ({
  browser,
}) => {
  const { context, page } = await speculationPage(browser);
  try {
    const before = await logsForCustomer();
    await page.goto("/__e2e-speculation");
    // Give Chromium time to act on the rules.
    await page.waitForTimeout(3000);
    expect(await logsForCustomer()).toBe(before);

    // What the route answers to those headers, directly.
    for (const purpose of ["prefetch;prerender", "prefetch"]) {
      const reply = await context.request.get(ROUTE_PATH, {
        headers: { "sec-purpose": purpose },
        maxRedirects: 0,
      });
      expect(reply.status(), purpose).toBe(503);
      expect(reply.headers()["retry-after"], purpose).toBe("0");
      expect(reply.headers()["cache-control"]).toBe("private, no-store");
    }
    expect(await logsForCustomer()).toBe(before);
  } finally {
    await context.close();
  }
});

test("gate C: the click after a Chromium prefetch/prerender still downloads", async ({
  browser,
}) => {
  // FINDING (gate C manual item, ADR 0073), fixed: Chromium kept the 204 it
  // got for the speculative request and served the click from it (aborted
  // navigation, no log row, no file). The route now answers speculation with
  // 503 + Retry-After: 0, which Chromium discards and refetches on the click
  // (next test).
  const { context, page } = await speculationPage(browser);
  try {
    await routeDownloads(context);
    await page.goto("/__e2e-speculation");
    await page.waitForTimeout(3000);
    const before = await logsForCustomer();
    const download = page.waitForEvent("download", { timeout: 8000 });
    await page.locator("#dl").click();
    expect((await download).suggestedFilename()).toBe(FILE_NAME);
    expect(await logsForCustomer()).toBe(before + 1);
  } finally {
    await context.close();
  }
});

test("Chromium refetches on click when the speculative answer is not 2xx (the fix the finding relies on)", async ({
  browser,
}) => {
  // A throwaway loopback server (not the app): the speculative request gets
  // `answer`, a normal request gets an attachment.
  for (const answer of [204, 503]) {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          `<!doctype html><title>s</title><script type="speculationrules">${JSON.stringify(
            {
              prerender: [{ source: "list", urls: ["/dl"] }],
              prefetch: [{ source: "list", urls: ["/dl"] }],
            },
          )}</script><a id="dl" href="/dl">D</a>`,
        );
        return;
      }
      const purpose = String(req.headers["sec-purpose"] ?? "");
      hits.push(purpose || "normal");
      if (purpose) {
        res.writeHead(answer, {
          "cache-control": "private, no-store",
          ...(answer === 503 ? { "retry-after": "60" } : {}),
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": XLSX,
        "content-disposition": 'attachment; filename="x.xlsx"',
        "cache-control": "private, no-store",
      });
      res.end("PK");
    });
    await new Promise<void>((resolve) =>
      server.listen(3121, "127.0.0.1", () => resolve()),
    );
    const context = await browser.newContext({
      baseURL: "http://127.0.0.1:3121",
    });
    try {
      const page = await context.newPage();
      await page.goto("/page");
      await page.waitForTimeout(2000);
      const downloaded = page.waitForEvent("download", { timeout: 5000 }).then(
        () => true,
        () => false,
      );
      await page.locator("#dl").click();
      expect(await downloaded, `speculative answer ${answer}`).toBe(
        answer !== 204,
      );
      expect(hits.includes("normal"), `speculative answer ${answer}`).toBe(
        answer !== 204,
      );
      expect(hits.some((hit) => hit.includes("prefetch"))).toBe(true);
    } finally {
      await context.close();
      server.close();
    }
  }
});

test("5. the admin ends access: the button says expired, the route sends to renewal, nothing logged", async ({
  browser,
}) => {
  const admin = await browser.newContext({ storageState: adminState });
  try {
    const page = await admin.newPage();
    await page.goto(`/admin/customers/${customerId}`);
    const save = page.getByRole("button", { name: "Save access" });
    await waitForHydration(save);
    await page.getByRole("radio", { name: "Choose a date" }).check();
    await page.getByLabel("Last day of access").fill(chinaDayKey(-1));
    await page
      .getByLabel("Email the customer when access is extended")
      .uncheck();
    await save.click();
    await expect(page.getByText(/^Access saved: /)).toBeVisible();
  } finally {
    await admin.close();
  }
  const until = (await customerDoc())?.accessExpiresAt as Date;
  expectEndOfChinaDay(until);
  expect(until.getTime()).toBeLessThan(Date.now());

  const page = customerPage;
  const before = await logsForCustomer();
  await gotoAndWaitForRestricted(page, PRODUCT_PATH);
  const slot = page.locator('[data-slot="datasheet"]');
  await expect(
    slot.getByRole("link", { name: "Download datasheet" }),
  ).toHaveCount(0);
  await expect(
    slot.getByRole("link", { name: "Contact us to renew" }),
  ).toHaveAttribute("href", RENEW_PATH);

  // The route itself (the old link, "Download again", a bookmark).
  const api = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    storageState: await page.context().storageState(),
  });
  try {
    const reply = await api.get(ROUTE_PATH, { maxRedirects: 0 });
    expect(reply.status()).toBe(303);
    expect(reply.headers()["location"]).toBe(RENEW_PATH);
    expect(reply.headers()["cache-control"]).toBe("private, no-store");
  } finally {
    await api.dispose();
  }
  // And in the browser: straight to the renewal form, prefilled.
  await page.goto(ROUTE_PATH);
  await expect(page).toHaveURL(
    new RegExp(`${RENEW_PATH.replace(/[?]/g, "\\?")}$`),
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Renew datasheet access" }),
  ).toBeVisible();
  await expect(page.getByLabel("Work email")).toHaveValue(CUSTOMER.email);
  expect(await logsForCustomer()).toBe(before);

  await page.goto("/my-downloads");
  await expect(page.getByText(`Ended on ${chinaDay(until)}`)).toBeVisible();
});

test("6. extended to 5 China days ahead: the cron reminds once, with a digest; a second run sends nothing", async ({
  browser,
}) => {
  const admin = await browser.newContext({ storageState: adminState });
  try {
    const page = await admin.newPage();
    await page.goto(`/admin/customers/${customerId}`);
    const save = page.getByRole("button", { name: "Save access" });
    await waitForHydration(save);
    await page.getByRole("radio", { name: "Choose a date" }).check();
    await page.getByLabel("Last day of access").fill(chinaDayKey(5));
    await save.click();
    await expect(
      page.getByText(/^Access saved: until the end of .* \(China time\)\./),
    ).toBeVisible();
  } finally {
    await admin.close();
  }
  const until = (await customerDoc())?.accessExpiresAt as Date;
  expectEndOfChinaDay(until);
  const days = (until.getTime() - Date.now()) / DAY;
  expect(days).toBeGreaterThan(4);
  expect(days).toBeLessThan(6);

  const reminder = /datasheet access ends soon/;
  const digest = /datasheet access ends within 7 days/;
  const remindersBefore = (await sentEmails(CUSTOMER.email)).filter((e) =>
    reminder.test(e.subject),
  ).length;
  expect(remindersBefore).toBe(0);
  const inboxBefore = (await sentEmails(COMPANY_INBOX)).length;

  const first = await runCron();
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    status: "completed",
    failed: 0,
    digest: "sent",
  });
  expect(first.body.sent as number).toBeGreaterThanOrEqual(1);
  // Counts only: no address or name in the answer.
  expect(JSON.stringify(first.body)).not.toContain(CUSTOMER.email);

  const sent = await waitForEmail(CUSTOMER.email, reminder);
  expect(sent.text).toContain(chinaDay(until));
  const report = await waitForEmail(COMPANY_INBOX, digest);
  expect(report.text).toContain(CUSTOMER.name);
  const inboxAfterFirst = (await sentEmails(COMPANY_INBOX)).length;
  expect(inboxAfterFirst).toBe(inboxBefore + 1);
  expect(
    (await sentEmails(CUSTOMER.email)).filter((e) => reminder.test(e.subject)),
  ).toHaveLength(1);
  expect((await customerDoc())?.expiryReminderFor?.toISOString?.()).toBe(
    until.toISOString(),
  );

  const second = await runCron();
  expect(second.status).toBe(200);
  expect(second.body).toMatchObject({
    status: "completed",
    due: 0,
    sent: 0,
    digest: "skipped",
  });
  // Nothing more for the customer or the inbox (give background sends a moment).
  await customerPage.waitForTimeout(1500);
  expect(
    (await sentEmails(CUSTOMER.email)).filter((e) => reminder.test(e.subject)),
  ).toHaveLength(1);
  expect(
    (await sentEmails(COMPANY_INBOX)).filter((e) => digest.test(e.subject)),
  ).toHaveLength(1);
  expect((await sentEmails(COMPANY_INBOX)).length).toBe(inboxAfterFirst);
});

test("axe WCAG 2.2 AA on the public account pages at 360 and 1280 px", async ({
  browser,
}) => {
  const visitor = await browser.newContext({ extraHTTPHeaders: NETWORK });
  const signedIn = customerPage;
  try {
    const visitorPage = await visitor.newPage();
    for (const width of [360, 1280]) {
      for (const [page, path, heading] of [
        [visitorPage, "/login", "Sign in"],
        [visitorPage, "/forgot-password", null],
        [
          visitorPage,
          "/reset-password?error=INVALID_TOKEN",
          "This link has expired",
        ],
        [visitorPage, "/request-access", "Request datasheet access"],
        [signedIn, "/change-password", null],
        [signedIn, "/my-downloads", "My downloads"],
      ] as const) {
        await page.setViewportSize({ width, height: 900 });
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(200);
        const h1 = page.getByRole("heading", { level: 1 });
        if (heading) await expect(h1).toHaveText(heading);
        else await expect(h1).toBeVisible();
        expect(await axeViolations(page), `${path} @${width}`).toEqual([]);
      }
    }
  } finally {
    await visitor.close();
  }
});
