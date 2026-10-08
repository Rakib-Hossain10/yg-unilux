// Phase 4a P9: the product-page exit flow on one seeded product (two variants,
// three images, every default-restricted column filled; fixtures EXIT,
// seeded by e2e/test-server.ts before `next start`).
//   visitor: quick panel + spec table + gallery; the optic switch changes the
//   model no., lumen, efficacy, the URL (?model=) and the stage picture;
//   a keyboard-only run through gallery, lightbox, switcher and Models table;
//   restricted values absent for a visitor, present for the admin and an
//   active customer; axe clean at 375 and 1280 px.
// Images come from the next/image route answered in the browser (the
// Cloudinary fake serves no pictures). Never `networkidle`.

import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { type Db, type MongoClient } from "mongodb";

import { E2E_CUSTOMER } from "./fixtures/accounts";
import { loadState } from "./fixtures/auth-state";
import { connectE2eDb } from "./fixtures/database";
import {
  axeViolations,
  gotoAndWaitForRestricted,
  horizontalOverflow,
  serveImages,
  waitForHydration,
} from "./fixtures/product-page-helpers";
import { EXIT } from "./fixtures/product-pages";

const PAGE = `/product/${EXIT.slug}`;
const ROUTE = `/api/catalog/restricted/${EXIT.productId}`;
const TOKENS: readonly string[] = Object.values(EXIT.restricted);

let client: MongoClient;
let db: Db;
let savedCustomer: Record<string, unknown> | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
  savedCustomer = await db.collection("users").findOne(
    { email: E2E_CUSTOMER.email },
    {
      projection: {
        mustChangePassword: 1,
        accessExpiresAt: 1,
        banned: 1,
        banExpires: 1,
      },
    },
  );
});

test.afterAll(async () => {
  if (savedCustomer) {
    await db.collection("users").updateOne(
      { email: E2E_CUSTOMER.email },
      {
        $set: {
          mustChangePassword: savedCustomer.mustChangePassword ?? true,
          accessExpiresAt: savedCustomer.accessExpiresAt ?? null,
          banned: savedCustomer.banned ?? false,
          banExpires: savedCustomer.banExpires ?? null,
        },
      },
    );
  }
  await client.close();
});

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

const panel = (page: Page) => page.locator('[data-slot="quick-spec-panel"]');
const field = (page: Page, name: string) =>
  panel(page).locator(`[data-field="${name}"]`);
const specTable = (page: Page) =>
  page.locator('[data-section="specifications"]');
const track = (page: Page) => page.locator('[data-slot="gallery-track"]');
const counter = (page: Page) => page.locator('[data-slot="gallery-counter"]');
const slideButton = (page: Page, index: number) =>
  page.locator(`[data-gallery-slide="${index}"] button`);
const currentSlideImage = (page: Page) =>
  page.locator("[data-gallery-slide][data-current] img");
const lightbox = (page: Page) => page.locator('dialog[data-slot="lightbox"]');
const frame = (page: Page) => page.locator('[data-slot="lightbox-frame"]');
const restricted = (page: Page) =>
  page.locator('[data-slot="restricted-specs"]');
const datasheet = (page: Page) => page.locator('[data-slot="datasheet"]');

/* "2 / 3" visible, "Image 2 of 3" for screen readers: compare the digits. */
const counterIs = (page: Page, n: number) =>
  expect(counter(page)).toHaveText(new RegExp(`^Image ${n}\\s*/\\s*of 3$`));

/* The picture the stage shows: the Cloudinary public id inside the
   next/image URL of the current slide. */
async function stagePublicId(page: Page): Promise<string> {
  const src = (await currentSlideImage(page).getAttribute("src")) ?? "";
  return decodeURIComponent(src);
}

/* Both handlers wired: gallery (slide 1) and switcher (radio 1). */
async function hydrated(page: Page) {
  await waitForHydration(slideButton(page, 0));
  await waitForHydration(page.locator("#variant-option-0"));
}

/* The focused element, described for a readable failure message. */
const focusedIs = (page: Page, selector: string) =>
  page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector);

/* Tabs (keyboard only) until `selector` has focus; fails after `max` tabs. */
async function tabUntil(page: Page, selector: string, max = 80) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await focusedIs(page, selector)) {
      // Focus came from the keyboard, so it must be visible.
      expect(
        await page.evaluate(
          () => document.activeElement?.matches(":focus-visible") ?? false,
        ),
      ).toBe(true);
      return;
    }
  }
  throw new Error(`${selector} never got focus within ${max} tabs`);
}

/* Every restricted token found in `text`. */
const found = (text: string) => TOKENS.filter((token) => text.includes(token));

/* The seeded customer as an active one (no temporary password, no expiry). */
async function activeCustomer() {
  await db.collection("users").updateOne(
    { email: E2E_CUSTOMER.email },
    {
      $set: {
        mustChangePassword: false,
        accessExpiresAt: null,
        banned: false,
        banExpires: null,
      },
    },
  );
}

async function signedIn(
  browser: Browser,
  who: "admin" | "customer",
): Promise<BrowserContext> {
  return browser.newContext({
    storageState: loadState(who),
    viewport: { width: 1280, height: 900 },
  });
}

// ---------------------------------------------------------------------------
// Visitor
// ---------------------------------------------------------------------------

test("a visitor sees the quick panel, the spec table and the gallery", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await serveImages(page);
  const response = await page.goto(PAGE);
  expect(response?.status()).toBe(200);

  await expect(page.locator("h1")).toContainText(EXIT.name);

  // Quick panel: variant 1's model no. and readouts, the optic switch.
  await expect(panel(page)).toBeVisible();
  await expect(field(page, "model-no")).toHaveText(EXIT.v1);
  await expect(field(page, "lumenOutput")).toHaveText(EXIT.lumen.v1);
  await expect(field(page, "lumenEfficiency")).toHaveText(EXIT.efficacy.v1);
  await expect(page.getByRole("radio")).toHaveCount(2);

  // Spec table: a named table with the public columns.
  await expect(specTable(page)).toBeVisible();
  await expect(specTable(page).getByRole("table").first()).toBeVisible();
  // The pink (quick) columns sit in the panel, the rest in the table.
  for (const key of ["housingMaterial", "housingFinish", "cutOutSize", "cct"]) {
    await expect(
      panel(page).locator(`[data-spec="${key}"]`),
      key,
    ).toBeVisible();
  }
  for (const key of [
    "cri",
    "beamAngle",
    "ugr",
    "wattage",
    "ipRating",
    "lens",
  ]) {
    await expect(
      specTable(page).locator(`tr[data-spec="${key}"]`),
      key,
    ).toBeVisible();
  }
  await expect(specTable(page).locator('tr[data-spec="lens"] td')).toHaveText(
    "PC lens",
  );

  // Gallery: three images, photos first, the first one really loaded.
  await expect(track(page).locator("img")).toHaveCount(3);
  await counterIs(page, 1);
  await expect(track(page).locator("img").nth(1)).toHaveAttribute(
    "alt",
    EXIT.photo2Alt,
  );
  await expect
    .poll(() =>
      track(page)
        .locator("img")
        .first()
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  expect(await stagePublicId(page)).toContain(EXIT.photo1);

  // Models table lists both variants (server-rendered).
  await expect(page.locator("#models")).toContainText(EXIT.v1);
  await expect(page.locator("#models")).toContainText(EXIT.v2);
});

test("switching the optic changes model no., lumen, efficacy, URL and picture", async ({
  page,
}) => {
  await serveImages(page);
  await page.goto(PAGE);
  await hydrated(page);
  await counterIs(page, 1);

  await page.locator('label[for="variant-option-1"]').click();
  await expect(page.locator("#variant-option-1")).toBeChecked();
  await expect(field(page, "model-no")).toHaveText(EXIT.v2);
  await expect(field(page, "lumenOutput")).toHaveText(EXIT.lumen.v2);
  await expect(field(page, "lumenEfficiency")).toHaveText(EXIT.efficacy.v2);
  await expect(specTable(page).locator('tr[data-spec="lens"] td')).toHaveText(
    "Reflector",
  );
  await expect(page).toHaveURL(new RegExp(`${PAGE}\\?model=${EXIT.v2}$`));
  // The stage jumps to variant 2's own picture.
  await counterIs(page, 2);
  await expect.poll(() => stagePublicId(page)).toContain(EXIT.photo2);

  // Back to variant 1: its own picture again.
  await page.locator('label[for="variant-option-0"]').click();
  await expect(field(page, "model-no")).toHaveText(EXIT.v1);
  await expect(field(page, "lumenOutput")).toHaveText(EXIT.lumen.v1);
  await expect(page).toHaveURL(new RegExp(`${PAGE}\\?model=${EXIT.v1}$`));
  await counterIs(page, 1);
  await expect.poll(() => stagePublicId(page)).toContain(EXIT.photo1);

  // The URL is a working deep link.
  await page.goto(`${PAGE}?model=${EXIT.v2}`);
  await hydrated(page);
  await expect(field(page, "model-no")).toHaveText(EXIT.v2);
  await expect(page.locator("#variant-option-1")).toBeChecked();
  await counterIs(page, 2);
});

test("keyboard only: gallery, lightbox, optic switch and Models table", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await serveImages(page);
  await page.goto(PAGE);
  await hydrated(page);

  // Gallery: Tab reaches the shown slide; arrows move between pictures.
  await tabUntil(page, '[data-gallery-slide="0"] button');
  await page.keyboard.press("ArrowRight");
  await counterIs(page, 2);
  await expect(slideButton(page, 1)).toBeFocused();

  // Enter opens the lightbox on that picture, focus inside on Close.
  await page.keyboard.press("Enter");
  await expect(lightbox(page)).toHaveAttribute("open", "");
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(frame(page).locator("img")).toHaveAttribute(
    "alt",
    EXIT.photo2Alt,
  );
  // Zoom keys, then the next picture at 1x.
  await page.keyboard.press("+");
  await expect(frame(page)).toHaveAttribute("data-zoom", "2");
  await page.keyboard.press("0");
  await expect(frame(page)).toHaveAttribute("data-zoom", "1");
  await page.keyboard.press("ArrowRight");
  await expect(frame(page).locator("img")).toHaveAttribute(
    "alt",
    /dimension drawing/,
  );
  // Tab never reaches the page behind the modal dialog (it is inert). A
  // native modal lets Tab leave for the browser UI (activeElement = body),
  // and the next Tab comes back into the dialog.
  const tabbedTo: string[] = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    tabbedTo.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "browser";
        return el.closest("dialog[open]")
          ? "dialog"
          : `page:${el.outerHTML.slice(0, 80)}`;
      }),
    );
  }
  expect(tabbedTo.filter((where) => where.startsWith("page:"))).toEqual([]);
  expect(tabbedTo).toContain("dialog");
  // Back on a control inside the dialog before Esc.
  while (
    !(await page.evaluate(
      () => document.activeElement?.closest("dialog[open]") != null,
    ))
  ) {
    await page.keyboard.press("Tab");
  }
  // Esc closes and returns focus to the stage, on the picture last viewed.
  await page.keyboard.press("Escape");
  await expect(lightbox(page)).not.toHaveAttribute("open", "");
  await counterIs(page, 3);
  await expect(slideButton(page, 2)).toBeFocused();

  // Optic switch: Tab lands on the checked radio; arrows switch.
  await tabUntil(page, 'input[type="radio"]');
  await expect(page.locator("#variant-option-0")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#variant-option-1")).toBeChecked();
  await expect(page.locator("#variant-option-1")).toBeFocused();
  await expect(field(page, "model-no")).toHaveText(EXIT.v2);
  await expect(field(page, "lumenOutput")).toHaveText(EXIT.lumen.v2);
  await expect(page).toHaveURL(new RegExp(`\\?model=${EXIT.v2}$`));
  await counterIs(page, 2);
  await expect(
    page.locator('[data-slot="variant-switcher"] [aria-live="polite"]'),
  ).toContainText(EXIT.v2);

  // Models table: "Show <model>" with Enter selects it and focuses its radio.
  await tabUntil(page, '#models tr[data-variant-index="0"] button', 120);
  await expect(
    page.locator("#models").getByRole("button", { name: `Show ${EXIT.v1}` }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#variant-option-0")).toBeChecked();
  await expect(page.locator("#variant-option-0")).toBeFocused();
  await expect(field(page, "model-no")).toHaveText(EXIT.v1);
  await expect(page).toHaveURL(new RegExp(`\\?model=${EXIT.v1}$`));
});

// ---------------------------------------------------------------------------
// Restricted values
// ---------------------------------------------------------------------------

test("a visitor gets no restricted value; the block asks to sign in", async ({
  page,
}) => {
  const { response, route } = await gotoAndWaitForRestricted(page, PAGE);
  expect(route.headers()["cache-control"]).toBe("private, no-store");
  expect(await route.json()).toEqual({ allowed: false, state: "signin" });
  expect(found((await response?.text()) ?? "")).toEqual([]);
  // RSC payload of the route too.
  const rsc = await page.request.get(PAGE, { headers: { RSC: "1" } });
  expect(found(await rsc.text())).toEqual([]);
  await expect(datasheet(page)).toContainText("Sign in to download");
  await expect(restricted(page)).toContainText("Sign in to see them");
  await expect(restricted(page).locator("table")).toHaveCount(0);
  expect(found(await page.content())).toEqual([]);
});

for (const who of ["admin", "customer"] as const) {
  test(`the ${who} sees the restricted values, and they follow the switch`, async ({
    browser,
  }) => {
    if (who === "customer") await activeCustomer();
    const context = await signedIn(browser, who);
    const page = await context.newPage();
    await serveImages(page);
    const { response, route } = await gotoAndWaitForRestricted(page, PAGE);
    // The static page carries nothing per viewer; only the route does.
    expect(found((await response?.text()) ?? "")).toEqual([]);
    expect(route.headers()["cache-control"]).toBe("private, no-store");
    const answer = (await route.json()) as { allowed: boolean; state: string };
    expect(answer).toMatchObject({ allowed: true, state: "download" });

    const table = restricted(page).locator("table");
    await expect(table).toHaveAccessibleName(
      `Specifications for approved customers: ${EXIT.v1}`,
    );
    for (const [key, value] of [
      ["batchNo", EXIT.restricted.batchNo],
      ["chipType", EXIT.restricted.chipType],
      ["holder", EXIT.restricted.holder],
      ["chipEfficiency", EXIT.restricted.chipEfficiency],
      ["driver", EXIT.restricted.driverV1],
    ] as const) {
      await expect(table.locator(`tr[data-spec="${key}"] td`), key).toHaveText(
        value,
      );
    }
    await expect(
      datasheet(page).getByRole("link", { name: "Download datasheet" }),
    ).toHaveAttribute("href", `/api/datasheet/${EXIT.productId}`);

    await page.locator('label[for="variant-option-1"]').click();
    await expect(table.locator('tr[data-spec="driver"] td')).toHaveText(
      EXIT.restricted.driverV2,
    );
    await expect(table).toHaveAccessibleName(
      `Specifications for approved customers: ${EXIT.v2}`,
    );
    // Product-level values stay with every variant.
    await expect(table.locator('tr[data-spec="chipType"] td')).toHaveText(
      EXIT.restricted.chipType,
    );
    // The direct route answers this viewer the same way.
    expect((await context.request.get(ROUTE)).status()).toBe(200);
    await context.close();
  });
}

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

for (const width of [375, 1280]) {
  test(`axe is clean at ${width} px (visitor), also with the lightbox open`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: width < 768 ? 812 : 900 },
      ...(width < 768 ? { isMobile: true, hasTouch: true } : {}),
    });
    const page = await context.newPage();
    await serveImages(page);
    await gotoAndWaitForRestricted(page, PAGE);
    await hydrated(page);
    await expect(
      datasheet(page).locator("[data-datasheet-state]"),
    ).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

    // After a switch (changed-value highlight on screen).
    await page.locator('label[for="variant-option-1"]').click();
    await expect(field(page, "model-no")).toHaveText(EXIT.v2);
    // Let the crossfade finish: its outgoing copy (aria-hidden, fading out)
    // fails contrast only mid-animation and is removed when it ends.
    await expect(page.locator(".value-crossfade-old")).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);

    // The lightbox open.
    await page
      .getByRole("button", { name: "View larger", exact: true })
      .click();
    await expect(lightbox(page)).toHaveAttribute("open", "");
    expect(await axeViolations(page)).toEqual([]);
    await context.close();
  });
}
