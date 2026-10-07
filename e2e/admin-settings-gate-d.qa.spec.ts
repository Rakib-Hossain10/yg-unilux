// QA gate D (Phase 2, T14-T15): the settings screen in a real browser. Access
// answers (visitor, customer, admin), no-store, the 28 switches with the five
// default-restricted columns, no geo-block control (ADR 0003), the warning and
// the save flow that clears filter numbers from products, persistence after a
// reload, the contact forms (digits only stored, bad values refused, audit with
// no number or address), keyboard use, and axe. The test database is shared
// with the other specs, so this file restores what it changes.
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

import { E2E_ADMIN, E2E_CUSTOMER } from "./fixtures/accounts";
import { connectE2eDb } from "./fixtures/database";

const axeSource = readFileSync(
  join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

// Its own sign-in bucket (the limiter reads this header), see gate A's spec.
const OWN_NETWORK = { "x-vercel-forwarded-for": "203.0.113.64" };

const RUN = Date.now().toString(36);
const PHONE_DIGITS = "85291234567";
const EMAIL = `gate-d-${RUN}@example.com`;
const DEFAULT_RESTRICTED = [
  "Batch No.",
  "Chip Type",
  "Holder",
  "Chip Efficiency",
  "Driver",
];

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
let adminState: StorageState;
let customerState: StorageState;
let client: MongoClient;
let db: Db;
let productId: ObjectId;
let otherProductId: ObjectId;

test.describe.configure({ mode: "serial" });

async function signInState(
  browser: Browser,
  email: string,
  password: string,
): Promise<StorageState> {
  const context = await browser.newContext({ extraHTTPHeaders: OWN_NETWORK });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  const state = await context.storageState();
  await context.close();
  return state;
}

test.beforeAll(async ({ browser }) => {
  client = await connectE2eDb();
  db = client.db();
  adminState = await signInState(browser, E2E_ADMIN.email, E2E_ADMIN.password);
  customerState = await signInState(
    browser,
    E2E_CUSTOMER.email,
    E2E_CUSTOMER.password,
  );
  await db.collection("auditLog").deleteMany({ "target.type": "settings" });
  await db.collection("siteContent").deleteMany({
    key: {
      $in: [
        "settings.columnVisibility",
        "settings.whatsappNumber",
        "settings.companyEmail",
      ],
    },
  });
  const now = new Date();
  const category = await db.collection("categories").insertOne({
    name: `QA GateD Cat ${RUN}`,
    slug: `qa-gated-cat-${RUN}`,
    parent: null,
    order: 96,
    createdAt: now,
    updatedAt: now,
  });
  const base = {
    mainCategory: category.insertedId,
    extraCategories: [],
    areas: [],
    status: "draft",
    featured: false,
    specs: {},
    extraSpecs: [],
    publicFiles: [],
    images: [],
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await db.collection("products").insertMany([
    {
      ...base,
      name: `QA ${RUN} GateD one`,
      slug: `qa-${RUN}-gated-one`,
      variants: [{ modelNo: `GD1-${RUN}` }],
      filters: { cctK: [3000, 4000], cri: [80], wattage: [12] },
    },
    {
      ...base,
      name: `QA ${RUN} GateD two`,
      slug: `qa-${RUN}-gated-two`,
      variants: [{ modelNo: `GD2-${RUN}` }],
      filters: { cctK: [2700], ugr: [19] },
    },
  ]);
  productId = inserted.insertedIds[0]!;
  otherProductId = inserted.insertedIds[1]!;
});

test.afterAll(async () => {
  if (!db) return;
  await db.collection("siteContent").deleteMany({
    key: {
      $in: [
        "settings.columnVisibility",
        "settings.whatsappNumber",
        "settings.companyEmail",
      ],
    },
  });
  await db
    .collection("products")
    .deleteMany({ _id: { $in: [productId, otherProductId] } });
  await db.collection("categories").deleteMany({ slug: `qa-gated-cat-${RUN}` });
  await db.collection("auditLog").deleteMany({ "target.type": "settings" });
  await client.close();
});

async function asAdmin(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: adminState });
  return context.newPage();
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

const restrict = (page: Page, header: string) =>
  page.getByRole("switch", { name: `Restrict ${header}`, exact: true });

test.describe("access", () => {
  test("a visitor is sent to login", async ({ request }) => {
    const response = await request.get("/admin/settings", {
      maxRedirects: 0,
      headers: OWN_NETWORK,
    });
    expect([302, 303, 307, 308]).toContain(response.status());
    expect(response.headers().location ?? "").toContain("/login");
    expect(await response.text()).not.toContain("Restricted product details");
  });

  test("a customer gets 403 for HTML and RSC, with no settings markup", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: customerState });
    // Next answers a bare RSC request with a redirect that adds `_rsc`.
    for (const [url, headers] of [
      ["/admin/settings", {}],
      ["/admin/settings?_rsc=gated", { RSC: "1" }],
    ] as [string, Record<string, string>][]) {
      const response = await context.request.get(url, {
        maxRedirects: 0,
        headers,
      });
      if (!headers.RSC) expect(response.status(), url).toBe(403);
      else expect(response.status(), url).not.toBe(200);
      const body = await response.text();
      expect(body).not.toContain("Restricted product details");
      expect(body).not.toContain("WhatsApp");
    }
    await context.close();
  });

  test("the real save action replayed by a visitor or a customer changes nothing", async ({
    browser,
    request,
  }) => {
    // Capture a genuine action id and body from an admin save, then replay it.
    const page = await asAdmin(browser);
    await page.goto("/admin/settings");
    await page.getByLabel("WhatsApp number").fill("+852 0000 1111");
    const [captured] = await Promise.all([
      page.waitForRequest(
        (r) => r.method() === "POST" && "next-action" in r.headers(),
      ),
      page.getByRole("button", { name: "Save WhatsApp number" }).click(),
    ]);
    await expect(page.getByText("WhatsApp number saved.")).toBeVisible();
    const headers: Record<string, string> = {
      ...captured.headers(),
      ...OWN_NETWORK,
    };
    delete headers.cookie;
    const data = captured.postData() ?? "";
    expect(headers["next-action"]).toMatch(/^[0-9a-f]{20,}$/);
    await page.context().close();

    const stored = () =>
      db
        .collection("siteContent")
        .countDocuments({ key: "settings.whatsappNumber" });
    const audits = () =>
      db
        .collection("auditLog")
        .countDocuments({ action: "settings.whatsapp.update" });
    // Reset to a known state: nothing stored, then replay.
    await db
      .collection("siteContent")
      .deleteMany({ key: "settings.whatsappNumber" });
    const auditsBefore = await audits();

    const visitor = await request.post("/admin/settings", {
      data,
      headers,
      maxRedirects: 0,
    });
    expect(visitor.status()).not.toBe(200);
    const context = await browser.newContext({ storageState: customerState });
    const customer = await context.request.post("/admin/settings", {
      data,
      headers,
      maxRedirects: 0,
    });
    expect(customer.status()).not.toBe(200);
    expect(await customer.text()).not.toContain("WhatsApp number saved");
    await context.close();

    expect(await stored()).toBe(0);
    expect(await audits()).toBe(auditsBefore);
  });
});

test.describe("the settings page", () => {
  test("is not cacheable and carries the admin CSP", async ({ browser }) => {
    const context = await browser.newContext({ storageState: adminState });
    const response = await context.request.get("/admin/settings");
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"] ?? "").toContain("no-store");
    expect(response.headers()["content-security-policy"] ?? "").toContain(
      "frame-ancestors 'none'",
    );
    await context.close();
  });

  test("shows 28 switches, the five defaults on and labelled, no geo-block control", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/settings");
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(28);
    for (const header of DEFAULT_RESTRICTED) {
      await expect(restrict(page, header)).toBeChecked();
    }
    await expect(restrict(page, "CCT")).not.toBeChecked();
    await expect(page.getByText("restricted by default")).toHaveCount(5);
    await expect(page.getByText(/geo|mainland|china/i)).toHaveCount(0);
    await expect(page.getByText("5 of 28 are restricted")).toBeVisible();
    await page.context().close();
  });

  test("passes axe", async ({ browser }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/settings");
    await expect(page.getByRole("switch")).toHaveCount(28);
    expect(await axeViolations(page)).toEqual([]);
    await page.context().close();
  });

  test("works on a narrow screen without horizontal scroll", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: adminState,
      viewport: { width: 375, height: 800 },
    });
    const page = await context.newPage();
    await page.goto("/admin/settings");
    await expect(page.getByRole("switch")).toHaveCount(28);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await context.close();
  });
});

test.describe("column visibility flow", () => {
  test("Save is off until something changes; Space toggles a switch from the keyboard", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/settings");
    const save = page.getByRole("button", { name: "Save column settings" });
    await expect(save).toBeDisabled();
    const cct = restrict(page, "CCT");
    await cct.focus();
    await expect(cct).toBeFocused();
    await page.keyboard.press("Space");
    await expect(cct).toBeChecked();
    await expect(save).toBeEnabled();
    await expect(
      page.getByText(/Saving will clear the CCT filter on all products/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(cct).not.toBeChecked();
    await expect(save).toBeDisabled();
    await page.context().close();
  });

  test("restricting CCT saves, clears the CCT numbers on every product, audits keys only, survives a reload", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/settings");
    await restrict(page, "CCT").click();
    await page.getByRole("button", { name: "Save column settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();

    const [one, two] = await Promise.all(
      [productId, otherProductId].map((_id) =>
        db.collection("products").findOne({ _id }),
      ),
    );
    expect(one?.filters?.cctK).toBeUndefined();
    expect(one?.filters?.cri).toEqual([80]);
    expect(one?.filters?.wattage).toEqual([12]);
    expect(two?.filters?.cctK).toBeUndefined();
    expect(two?.filters?.ugr).toEqual([19]);

    const entry = await db
      .collection("auditLog")
      .findOne({ action: "settings.columns.update" });
    expect(entry?.meta?.restricted).toEqual(["cct"]);
    expect(Object.keys(entry?.meta ?? {}).sort()).toEqual([
      "cleanupFailed",
      "madePublic",
      "restricted",
      "restrictedCount",
    ]);

    await page.reload();
    await expect(restrict(page, "CCT")).toBeChecked();
    await expect(page.getByText("6 of 28 are restricted")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save column settings" }),
    ).toBeDisabled();
    await page.context().close();
  });

  test("the product edit page no longer carries the cleared CCT numbers", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: adminState });
    const response = await context.request.get(
      `/admin/products/${productId.toHexString()}`,
    );
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).not.toMatch(/cctK\W{1,8}\[/);
    // The numbers of a column that is still public are there.
    expect(html).toMatch(/cri\W{1,8}\[\s*80/);
    await context.close();
  });

  test("making CCT public again does not restore the numbers", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/settings");
    await restrict(page, "CCT").click();
    await page.getByRole("button", { name: "Save column settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
    const one = await db.collection("products").findOne({ _id: productId });
    expect(one?.filters?.cctK).toBeUndefined();
    await expect(restrict(page, "CCT")).not.toBeChecked();
    await page.context().close();
  });
});

test.describe("contact settings", () => {
  test("whatsapp: bad values are refused in the form, a good one is stored as digits only", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/settings");
    const field = page.getByLabel("WhatsApp number");
    const save = page.getByRole("button", { name: "Save WhatsApp number" });
    await field.fill("call me maybe");
    await save.click();
    await expect(page.getByText(/Use digits only/)).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    expect(
      await db
        .collection("siteContent")
        .countDocuments({ key: "settings.whatsappNumber" }),
    ).toBe(0);

    await field.fill("+852 9123-4567");
    await save.click();
    await expect(page.getByText("WhatsApp number saved.")).toBeVisible();
    const stored = await db
      .collection("siteContent")
      .findOne({ key: "settings.whatsappNumber" });
    expect(stored?.value).toBe(PHONE_DIGITS);
    await page.reload();
    await expect(page.getByLabel("WhatsApp number")).toHaveValue(
      `+${PHONE_DIGITS}`,
    );
    await page.context().close();
  });

  test("email: invalid is refused, valid is lower-cased, clearing removes it", async ({
    browser,
  }) => {
    const page = await asAdmin(browser);
    await page.goto("/admin/settings");
    const field = page.getByLabel("Company email");
    const save = page.getByRole("button", { name: "Save company email" });
    await field.fill("not-an-email");
    await save.click();
    await expect(page.getByText("Enter a valid email address")).toBeVisible();

    await field.fill(EMAIL.toUpperCase());
    await save.click();
    await expect(page.getByText("Company email saved.")).toBeVisible();
    expect(
      (
        await db
          .collection("siteContent")
          .findOne({ key: "settings.companyEmail" })
      )?.value,
    ).toBe(EMAIL);

    await field.fill("");
    await save.click();
    await expect(page.getByText("Company email saved.")).toBeVisible();
    expect(
      await db
        .collection("siteContent")
        .countDocuments({ key: "settings.companyEmail" }),
    ).toBe(0);
    await page.context().close();
  });

  test("the audit log holds no number and no address", async () => {
    const entries = await db
      .collection("auditLog")
      .find({
        action: { $in: ["settings.whatsapp.update", "settings.email.update"] },
      })
      .toArray();
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const dump = JSON.stringify(entries);
    expect(dump).not.toContain(PHONE_DIGITS);
    expect(dump).not.toContain(EMAIL);
    expect(dump).not.toContain("@");
  });

  test("the stored contact values never appear in a page a visitor can fetch", async ({
    request,
  }) => {
    // Phone was stored above; no public page may render it yet (Phase 4 adds it).
    for (const url of ["/", "/login", "/products"]) {
      const body = await (
        await request.get(url, { headers: OWN_NETWORK })
      ).text();
      expect(body, url).not.toContain(PHONE_DIGITS);
    }
  });
});
