// Phase 4a P6: the product gallery and lightbox on a seeded published product
// (3 images: 2 photos + a drawing, 2 variants, variant 2 has its own picture).
// Covers swipe/snap at 375 px, keyboard, Esc focus return, zoom, CLS, alt.

import { deflateSync, crc32 } from "node:zlib";

import { expect, type Page, test } from "@playwright/test";

import { GALLERY } from "./fixtures/product-pages";

// Seeded by e2e/test-server.ts before `next start` (fixtures/product-pages.ts).
const SLUG = GALLERY.slug;
const BARE = GALLERY.bare;
const B2 = GALLERY.b2;

test.describe.configure({ mode: "serial" });

/* A solid 400x300 PNG, so the images really load (the Cloudinary fake
   serves no pictures; next/image's endpoint is answered here instead). */
function solidPng(width: number, height: number, rgb: number[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => rgb).flat()),
  ]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG = solidPng(400, 300, [200, 196, 190]);

/* Answer every next/image request; `delayMs` holds them back (CLS test). */
async function serveImages(page: Page, delayMs = 0) {
  await page.route("**/_next/image**", async (route) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });
}

/* Records the behaviour of every scrollTo on the gallery track. */
async function recordScrolls(page: Page) {
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __scrolls: string[] }).__scrolls = log;
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (
      this: Element,
      ...args: [ScrollToOptions?]
    ) {
      if (this.matches('[data-slot="gallery-track"]')) {
        log.push(String(args[0]?.behavior ?? "auto"));
      }
      return original.apply(this, args as never);
    } as typeof Element.prototype.scrollTo;
  });
}

const gallery = (page: Page) => page.locator('[data-slot="product-gallery"]');
const track = (page: Page) => page.locator('[data-slot="gallery-track"]');
const counter = (page: Page) => page.locator('[data-slot="gallery-counter"]');
const slideButton = (page: Page, index: number) =>
  page.locator(`[data-gallery-slide="${index}"] button`);
const lightbox = (page: Page) => page.locator('dialog[data-slot="lightbox"]');
const frame = (page: Page) => page.locator('[data-slot="lightbox-frame"]');

/* Hydration is done once React has attached its handlers. */
async function waitForHydration(page: Page) {
  await expect
    .poll(() =>
      slideButton(page, 0).evaluate((el) =>
        Object.keys(el).some((key) => key.startsWith("__reactProps")),
      ),
    )
    .toBe(true);
}

/* "2 / 3" visible, "Image 2 of 3" for screen readers: compare the digits. */
const counterIs = (page: Page, n: number) =>
  expect(counter(page)).toHaveText(new RegExp(`^Image ${n}\\s*/\\s*of 3$`));

test("photos first, every image has alt text, image 1 is not lazy", async ({
  page,
}) => {
  await serveImages(page);
  await page.goto(`/product/${SLUG}`);
  const stage = track(page).locator("img");
  await expect(stage).toHaveCount(3);
  await expect(stage.nth(0)).toHaveAttribute("alt", "Lumen, image 1 of 3");
  await expect(stage.nth(1)).toHaveAttribute("alt", "Lumen, black");
  await expect(stage.nth(2)).toHaveAttribute(
    "alt",
    "Lumen, image 3 of 3 (dimension drawing)",
  );
  expect(await stage.nth(0).getAttribute("loading")).not.toBe("lazy");
  await expect(stage.nth(1)).toHaveAttribute("loading", "lazy");
  // Every image is served through next/image, never a raw Cloudinary URL.
  for (const image of await gallery(page).locator("img").all()) {
    expect(await image.getAttribute("src")).toMatch(/^\/_next\/image\?url=/);
  }
  // The stage opens the lightbox: its button is named after the picture.
  await expect(slideButton(page, 0)).toHaveAccessibleName(
    "View larger: Lumen, image 1 of 3",
  );
  // Thumbnails: decorative pictures, named buttons.
  await expect(
    page.getByRole("button", { name: "Show image 3 of 3" }),
  ).toBeVisible();
});

test("no layout shift: the stage keeps its 4:3 box while images load", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    const shifts: number[] = [];
    (window as unknown as { __cls: number[] }).__cls = shifts;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[]) {
        if (!entry.hadRecentInput) shifts.push(entry.value);
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await serveImages(page, 800);
  await page.goto(`/product/${SLUG}`, { waitUntil: "domcontentloaded" });
  const before = await track(page).boundingBox();
  const galleryBefore = await gallery(page).boundingBox();
  // Wait until the first picture has really loaded.
  await expect
    .poll(() =>
      track(page)
        .locator("img")
        .first()
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await waitForHydration(page);
  const after = await track(page).boundingBox();
  expect(after).toEqual(before);
  expect(await gallery(page).boundingBox()).toEqual(galleryBefore);
  expect((before?.width ?? 0) / (before?.height ?? 1)).toBeCloseTo(4 / 3, 1);
  const cls = await page.evaluate(() =>
    (window as unknown as { __cls: number[] }).__cls.reduce((a, b) => a + b, 0),
  );
  expect(cls).toBeLessThanOrEqual(0.02);
});

test("at 375 px the track scroll-snaps on a swipe and the counter follows", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await serveImages(page);
  await page.goto(`/product/${SLUG}`);
  await waitForHydration(page);
  await expect(track(page)).toHaveCSS("scroll-snap-type", "x mandatory");
  await counterIs(page, 1);

  // A real touch drag (raw touch input through CDP), right to left: the
  // track follows the finger (nothing in the page blocks the swipe).
  const box = await track(page).boundingBox();
  if (!box) throw new Error("no track box");
  const cdp = await context.newCDPSession(page);
  const y = box.y + box.height / 2;
  const fromX = box.x + box.width * 0.85;
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  await touch("touchStart", fromX);
  for (let step = 1; step <= 10; step++) {
    await touch("touchMove", fromX - (box.width * 0.6 * step) / 10);
  }
  await touch("touchEnd", 0);
  await expect
    .poll(() => track(page).evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(box.width * 0.4);

  // Headless Chrome does not finish a CDP touch with a snap (no gesture end
  // from the compositor), so the snap itself is checked with a scroll the
  // browser completes: a part scroll lands on a whole slide (mandatory).
  const offFromSlide = (index: number) =>
    track(page).evaluate(
      (el, i) =>
        Math.abs(el.scrollLeft - (el.children[i] as HTMLElement).offsetLeft),
      index,
    );
  await track(page).evaluate((el) =>
    el.scrollTo({ left: el.clientWidth * 1.3, behavior: "instant" }),
  );
  await expect.poll(() => offFromSlide(1)).toBeLessThan(2);
  await counterIs(page, 2);
  await expect(
    page.getByRole("button", { name: "Show image 2 of 3" }),
  ).toHaveAttribute("aria-current", "true");
  await track(page).evaluate((el) =>
    el.scrollTo({ left: el.clientWidth * 1.8, behavior: "instant" }),
  );
  await expect.poll(() => offFromSlide(2)).toBeLessThan(2);
  await counterIs(page, 3);

  // Touch targets and no horizontal page scroll.
  for (const name of ["Previous image", "Next image", "View larger"]) {
    const target = await page
      .getByRole("button", { name, exact: true })
      .boundingBox();
    expect(target?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(target?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  const thumb = await page
    .getByRole("button", { name: "Show image 1 of 3" })
    .boundingBox();
  expect(thumb?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await context.close();
});

test("keyboard: arrows, Home/End on the stage; buttons and thumbnails", async ({
  page,
}) => {
  await serveImages(page);
  await page.goto(`/product/${SLUG}`);
  await waitForHydration(page);

  // Only the shown slide is in the tab order.
  await expect(slideButton(page, 0)).toHaveAttribute("tabindex", "0");
  await expect(slideButton(page, 1)).toHaveAttribute("tabindex", "-1");

  await slideButton(page, 0).focus();
  await page.keyboard.press("ArrowRight");
  await counterIs(page, 2);
  await expect(slideButton(page, 1)).toBeFocused();
  await expect(slideButton(page, 1)).toHaveAttribute("tabindex", "0");
  await page.keyboard.press("End");
  await counterIs(page, 3);
  await expect(slideButton(page, 2)).toBeFocused();
  // At the end, ArrowRight stays put.
  await page.keyboard.press("ArrowRight");
  await counterIs(page, 3);
  await page.keyboard.press("Home");
  await counterIs(page, 1);
  await expect(slideButton(page, 0)).toBeFocused();

  const previous = page.getByRole("button", { name: "Previous image" });
  const next = page.getByRole("button", { name: "Next image" });
  await expect(previous).toHaveAttribute("aria-disabled", "true");
  await next.focus();
  await page.keyboard.press("Enter");
  await counterIs(page, 2);
  await expect(next).toBeFocused();
  await expect(previous).toHaveAttribute("aria-disabled", "false");

  await page.getByRole("button", { name: "Show image 3 of 3" }).click();
  await counterIs(page, 3);
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByRole("button", { name: "Show image 3 of 3" }),
  ).toHaveAttribute("aria-current", "true");
});

test("lightbox: opens modal, zoom keys, pan, Esc returns focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await serveImages(page);
  await page.goto(`/product/${SLUG}`);
  await waitForHydration(page);

  await slideButton(page, 0).focus();
  await page.keyboard.press("Enter");
  await expect(lightbox(page)).toHaveAttribute("open", "");
  expect(await lightbox(page).evaluate((el) => el.matches(":modal"))).toBe(
    true,
  );
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(frame(page).locator("img")).toHaveAttribute(
    "alt",
    "Lumen, image 1 of 3",
  );
  // The page behind does not scroll.
  await expect(page.locator("html")).toHaveCSS("overflow", "hidden");

  // + / − / = / 0 zoom; arrows pan while zoomed, change image at 1x.
  await page.keyboard.press("+");
  await expect(frame(page)).toHaveAttribute("data-zoom", "2");
  const transform = () =>
    frame(page)
      .locator(":scope > div")
      .evaluate((el) => (el as HTMLElement).style.transform);
  const centred = await transform();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(transform).not.toBe(centred);
  await expect(frame(page).locator("img")).toHaveAttribute(
    "alt",
    "Lumen, image 1 of 3",
  );
  await page.keyboard.press("-");
  await expect(frame(page)).toHaveAttribute("data-zoom", "1");
  await page.keyboard.press("=");
  await expect(frame(page)).toHaveAttribute("data-zoom", "2");
  await page.keyboard.press("0");
  await expect(frame(page)).toHaveAttribute("data-zoom", "1");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(frame(page)).toHaveAttribute("data-zoom", "2");
  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect(frame(page)).toHaveAttribute("data-zoom", "1");

  await page.keyboard.press("ArrowRight");
  await expect(frame(page).locator("img")).toHaveAttribute(
    "alt",
    "Lumen, black",
  );

  // Double-click zooms at the point; a drag pans; double-click resets.
  const box = await frame(page).boundingBox();
  if (!box) throw new Error("no frame box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.dblclick(cx, cy);
  await expect(frame(page)).toHaveAttribute("data-zoom", "2");
  const beforeDrag = await transform();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 60, { steps: 5 });
  await page.mouse.up();
  await expect.poll(transform).not.toBe(beforeDrag);
  await page.mouse.dblclick(cx, cy);
  await expect(frame(page)).toHaveAttribute("data-zoom", "1");

  // Esc closes; focus returns to the stage, now on the image last viewed.
  await page.keyboard.press("Escape");
  await expect(lightbox(page)).not.toHaveAttribute("open", "");
  await counterIs(page, 2);
  await expect(slideButton(page, 1)).toBeFocused();
  await expect(page.locator("html")).not.toHaveCSS("overflow", "hidden");

  // Opened from "View larger", Esc returns focus to that button.
  const enlarge = page.getByRole("button", {
    name: "View larger",
    exact: true,
  });
  await enlarge.click();
  await expect(lightbox(page)).toHaveAttribute("open", "");
  await expect(frame(page).locator("img")).toHaveAttribute(
    "alt",
    "Lumen, black",
  );
  await page.keyboard.press("Escape");
  await expect(lightbox(page)).not.toHaveAttribute("open", "");
  await expect(enlarge).toBeFocused();

  // The close button closes too and returns focus the same way.
  await enlarge.click();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(lightbox(page)).not.toHaveAttribute("open", "");
  await expect(enlarge).toBeFocused();
});

test("switching the optic jumps to the variant's picture (smooth)", async ({
  page,
}) => {
  await recordScrolls(page);
  await serveImages(page);
  await page.goto(`/product/${SLUG}`);
  await waitForHydration(page);
  await counterIs(page, 1);
  await page.locator('label[for="variant-option-1"]').click();
  await counterIs(page, 2);
  await expect(
    page.locator('[data-gallery-slide="1"][data-current]'),
  ).toHaveCount(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { __scrolls: string[] }).__scrolls,
    ),
  ).toEqual(["smooth"]);
  // Back to variant 1 (no picture of its own): the stage stays put.
  await page.locator('label[for="variant-option-0"]').click();
  await counterIs(page, 2);
});

test("reduced motion: the variant jump and a ?model= deep link are instant", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await recordScrolls(page);
  await serveImages(page);
  await page.goto(`/product/${SLUG}?model=${B2}`);
  await waitForHydration(page);
  await counterIs(page, 2);
  await page.locator('label[for="variant-option-0"]').click();
  await page.getByRole("button", { name: "Show image 1 of 3" }).click();
  await counterIs(page, 1);
  await page.locator('label[for="variant-option-1"]').click();
  await counterIs(page, 2);
  const scrolls = await page.evaluate(
    () => (window as unknown as { __scrolls: string[] }).__scrolls,
  );
  expect(scrolls.length).toBeGreaterThanOrEqual(3);
  expect(new Set(scrolls)).toEqual(new Set(["instant"]));
  await context.close();
});

test("a product without images shows the neutral placeholder", async ({
  page,
}) => {
  await page.goto(`/product/${BARE}`);
  await expect(page.locator("h1")).toHaveText("Bare");
  await expect(
    gallery(page).getByRole("img", { name: "Bare: photo not yet available" }),
  ).toBeVisible();
  await expect(gallery(page).locator("img")).toHaveCount(0);
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "View larger", exact: true }),
  ).toHaveCount(0);
});
