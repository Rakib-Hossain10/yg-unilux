// Phase 4a P8: the product-page motion pass. Motion is an enhancement only:
// with reducedMotion "reduce" nothing animates and the final DOM is the same
// as with motion once it settles; only opacity/transform ever animate; the
// listing morph is wired but inert; leaving and coming back leaks nothing.

import { expect, type Browser, type Page, test } from "@playwright/test";

import { GALLERY, GATE_B, SWITCHER } from "./fixtures/product-pages";

test.describe.configure({ mode: "serial" });

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

/* The Cloudinary fake serves no pictures: answer next/image here. */
async function serveImages(page: Page) {
  await page.route("**/_next/image**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG_1x1 }),
  );
}

/* Records console errors and uncaught exceptions. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    // Network 404s are not script errors: the header prefetches pages that
    // are not built yet (/products, /services, ... in Phase 4b/5).
    if (message.type() !== "error") return;
    if (message.text().startsWith("Failed to load resource")) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/*
 * Instruments the page before any script: every Web Animation and CSS
 * animation/transition property seen, view transitions started (with their
 * types), and live IntersectionObservers / window listeners.
 */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const animated = new Set<string>();
    const viewTransitions: string[][] = [];
    const observers = new Set<IntersectionObserver>();
    const listeners = new Map<string, number>();
    w.__motion = { animated, viewTransitions, observers, listeners };

    // Only the motion pass's own elements: the site's hover/selection colour
    // fades (transition-colors on buttons, labels, rows) are not P8 motion.
    const MOTION =
      '.value-crossfade, .variant-value[data-changed], [data-reveal], dialog.lightbox, [data-slot="gallery-track"]';
    (w as Record<string, unknown>).__motionSelector = MOTION;
    const record = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(MOTION)) return;
      const name =
        "propertyName" in event
          ? `transition:${(event as TransitionEvent).propertyName}`
          : `animation:${(event as AnimationEvent).animationName}`;
      animated.add(name);
    };
    document.addEventListener("transitionstart", record, true);
    document.addEventListener("animationstart", record, true);

    const start = document.startViewTransition?.bind(document);
    if (start) {
      document.startViewTransition = ((arg?: unknown) => {
        const types =
          arg && typeof arg === "object" && "types" in arg
            ? [...((arg as { types?: string[] }).types ?? [])]
            : [];
        viewTransitions.push(types);
        return start(arg as never);
      }) as typeof document.startViewTransition;
    }

    const Native = window.IntersectionObserver;
    window.IntersectionObserver = class extends Native {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        super(callback, options);
        observers.add(this);
      }
      override disconnect() {
        observers.delete(this);
        super.disconnect();
      }
    };

    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = ((
      ...args: Parameters<typeof window.addEventListener>
    ) => {
      listeners.set(args[0], (listeners.get(args[0]) ?? 0) + 1);
      return add(...args);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((
      ...args: Parameters<typeof window.removeEventListener>
    ) => {
      listeners.set(args[0], (listeners.get(args[0]) ?? 0) - 1);
      return remove(...args);
    }) as typeof window.removeEventListener;
  });
}

type MotionLog = {
  animated: string[];
  viewTransitions: string[][];
  observers: number;
  keydown: number;
};

const motionLog = (page: Page): Promise<MotionLog> =>
  page.evaluate(() => {
    const m = (window as unknown as Record<string, unknown>).__motion as {
      animated: Set<string>;
      viewTransitions: string[][];
      observers: Set<IntersectionObserver>;
      listeners: Map<string, number>;
    };
    return {
      animated: [...m.animated],
      viewTransitions: m.viewTransitions,
      observers: m.observers.size,
      keydown: m.listeners.get("keydown") ?? 0,
    };
  });

/* Every Web Animation running now changes only opacity/transform. */
const runningProperties = (page: Page) =>
  page.evaluate(() => {
    const names = new Set<string>();
    const motion = (window as unknown as Record<string, string>)
      .__motionSelector;
    for (const animation of document.getAnimations()) {
      const effect = animation.effect as KeyframeEffect | null;
      const target = effect?.target;
      if (!(target instanceof Element) || !motion || !target.closest(motion))
        continue;
      for (const frame of effect?.getKeyframes() ?? []) {
        for (const key of Object.keys(frame)) names.add(key);
      }
      if ("transitionProperty" in animation)
        names.add(String(animation.transitionProperty));
    }
    for (const meta of ["offset", "easing", "composite", "computedOffset"])
      names.delete(meta);
    return [...names];
  });

const ALLOWED = new Set(["opacity", "transform", "display", "overlay"]);
const onlyCompositorProps = (props: string[]) =>
  props.filter(
    (prop) => !ALLOWED.has(prop.replace(/^(transition|animation):/, "")),
  );

async function waitForHydration(page: Page, selector: string) {
  await expect
    .poll(() =>
      page
        .locator(selector)
        .first()
        .evaluate((el) =>
          Object.keys(el).some((key) => key.startsWith("__reactProps")),
        ),
    )
    .toBe(true);
}

const panel = (page: Page) => page.locator('[data-slot="quick-spec-panel"]');
const modelNo = (page: Page) => panel(page).locator('[data-field="model-no"]');

async function newPage(browser: Browser, reduced: boolean) {
  const context = await browser.newContext({
    reducedMotion: reduced ? "reduce" : "no-preference",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await instrument(page);
  await serveImages(page);
  return { context, page };
}

/*
 * One scripted visit: switch the optic, open and close the lightbox, scroll
 * through the page, wait for motion to settle; returns the product block's
 * markup (scroll position and React's internals are not in outerHTML).
 */
async function scriptedVisit(page: Page) {
  await page.goto(`/product/${GALLERY.slug}`);
  await waitForHydration(page, '[data-gallery-slide="0"] button');
  await page.locator('label[for="variant-option-1"]').click();
  await expect(modelNo(page)).toHaveText(GALLERY.b2);
  await page.getByRole("button", { name: "View larger", exact: true }).click();
  await expect(page.locator('dialog[data-slot="lightbox"]')).toHaveAttribute(
    "open",
    "",
  );
  await page.keyboard.press("Escape");
  await expect(
    page.locator('dialog[data-slot="lightbox"]'),
  ).not.toHaveAttribute("open", "");
  for (let y = 0; y <= 4000; y += 400) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(60);
  }
  // Longest motion: reveal 600 ms + stagger + fallback 1200 ms.
  await page.waitForTimeout(1800);
  await expect(page.locator("[data-reveal]")).toHaveCount(0);
  await expect(page.locator("[data-crossfade-old]")).toHaveCount(0);
  await expect(page.locator('[data-slot="lightbox-frame"]')).toHaveCount(0);
  return page.locator("article.product-page").evaluate((el) => el.outerHTML);
}

test("reduced motion: nothing animates and the final DOM equals the motion one", async ({
  browser,
}) => {
  const reduced = await newPage(browser, true);
  const reducedErrors = watchErrors(reduced.page);
  const reducedHtml = await scriptedVisit(reduced.page);
  const reducedLog = await motionLog(reduced.page);
  // The site-wide backstop shortens any transition to 0.01 ms; no motion
  // code of P8 runs at all: no crossfade overlay, no reveal, no view
  // transition, no named stage.
  expect(reducedLog.viewTransitions).toEqual([]);
  expect(
    reducedLog.animated.filter((name) =>
      /value-crossfade|variant-value-wash|lightbox-image-in/.test(name),
    ),
  ).toEqual([]);
  expect(reducedErrors).toEqual([]);
  await reduced.context.close();

  const motion = await newPage(browser, false);
  const motionErrors = watchErrors(motion.page);
  const motionHtml = await scriptedVisit(motion.page);
  const motionLogged = await motionLog(motion.page);
  expect(motionLogged.animated).toEqual(
    expect.arrayContaining([
      "animation:value-crossfade-in",
      "animation:value-crossfade-out",
      "animation:variant-value-wash",
    ]),
  );
  expect(
    onlyCompositorProps(
      motionLogged.animated.filter((n) => n.startsWith("transition:")),
    ),
  ).toEqual([]);
  expect(motionErrors).toEqual([]);
  await motion.context.close();

  expect(motionHtml).toBe(reducedHtml);
});

test("the readout crossfades: the old value overlays, then is removed", async ({
  browser,
}) => {
  const { context, page } = await newPage(browser, false);
  await page.goto(`/product/${SWITCHER.slug}`);
  await waitForHydration(page, "#variant-option-0");
  const before = await panel(page).boundingBox();
  await page.locator('label[for="variant-option-1"]').click();
  await expect(modelNo(page)).toHaveText(SWITCHER.a2);
  const old = panel(page).locator("[data-crossfade-old]").first();
  await expect(old).toHaveAttribute("aria-hidden", "true");
  expect(onlyCompositorProps(await runningProperties(page))).toEqual([]);
  // The overlay takes no space: the panel does not move or grow.
  expect(await panel(page).boundingBox()).toEqual(before);
  await expect(panel(page).locator("[data-crossfade-old]")).toHaveCount(0);
  await expect(modelNo(page)).toHaveAttribute("data-changed", "");
  await context.close();
});

test("gallery: neighbours slide natively, longer jumps crossfade the stage only", async ({
  browser,
}) => {
  const { context, page } = await newPage(browser, false);
  await page.goto(`/product/${GALLERY.slug}`);
  await waitForHydration(page, '[data-gallery-slide="0"] button');
  const frame = page.locator('[data-slot="gallery-track"]').locator("..");

  await page.getByRole("button", { name: "Next image" }).click();
  await expect(
    page.locator('[data-gallery-slide="1"][data-current]'),
  ).toHaveCount(1);
  expect((await motionLog(page)).viewTransitions).toEqual([]);

  await page.getByRole("button", { name: "Show image 1 of 3" }).click();
  await expect(
    page.locator('[data-gallery-slide="0"][data-current]'),
  ).toHaveCount(1);
  await page.waitForTimeout(500);

  await page.getByRole("button", { name: "Show image 3 of 3" }).click();
  await expect(
    page.locator('[data-gallery-slide="2"][data-current]'),
  ).toHaveCount(1);
  expect((await motionLog(page)).viewTransitions).toEqual([["gallery-jump"]]);
  // The name exists only during the transition.
  await expect
    .poll(() => frame.evaluate((el) => el.getAttribute("style") ?? ""))
    .not.toContain("view-transition-name");
  await expect
    .poll(() =>
      page
        .locator('[data-slot="gallery-track"]')
        .evaluate((el) => Math.round(el.scrollLeft / el.clientWidth)),
    )
    .toBe(2);
  await context.close();
});

test("lightbox fades open and closed, keeps its picture while closing, focus returns", async ({
  browser,
}) => {
  const { context, page } = await newPage(browser, false);
  await page.goto(`/product/${GALLERY.slug}`);
  await waitForHydration(page, '[data-gallery-slide="0"] button');
  const dialog = page.locator('dialog[data-slot="lightbox"]');
  const enlarge = page.getByRole("button", {
    name: "View larger",
    exact: true,
  });
  await enlarge.click();
  await expect(dialog).toHaveAttribute("open", "");
  expect(
    await dialog.evaluate((el) => getComputedStyle(el).transitionProperty),
  ).toContain("opacity");
  expect(onlyCompositorProps(await runningProperties(page))).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(enlarge).toBeFocused();
  await expect(page.locator('[data-slot="lightbox-frame"]')).toHaveCount(0);

  // The fading sheet keeps the picture, inert, then empties: read two frames
  // after close() in the page itself (no test-runner round trip in between).
  await enlarge.click();
  await expect(dialog).toHaveAttribute("open", "");
  const closing = await page.evaluate(
    () =>
      new Promise<{ frame: boolean; inert: boolean }>((resolve) => {
        const box = document.querySelector<HTMLDialogElement>(
          'dialog[data-slot="lightbox"]',
        );
        box?.close();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const frame = box?.querySelector('[data-slot="lightbox-frame"]');
            resolve({
              frame: Boolean(frame),
              inert: Boolean(frame?.closest("[inert]")),
            });
          }),
        );
      }),
  );
  expect(closing).toEqual({ frame: true, inert: true });
  await expect(page.locator('[data-slot="lightbox-frame"]')).toHaveCount(0);
  await expect(enlarge).toBeFocused();
  await context.close();
});

test("reduced motion: the lightbox empties at once and nothing is marked", async ({
  browser,
}) => {
  const { context, page } = await newPage(browser, true);
  await page.goto(`/product/${GALLERY.slug}`);
  await waitForHydration(page, '[data-gallery-slide="0"] button');
  await expect(page.locator("[data-reveal]")).toHaveCount(0);
  await page.getByRole("button", { name: "View larger", exact: true }).click();
  await expect(page.locator('dialog[data-slot="lightbox"]')).toHaveAttribute(
    "open",
    "",
  );
  // Two frames after close() the view is already gone (no exit hold).
  const frameLeft = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const box = document.querySelector<HTMLDialogElement>(
          'dialog[data-slot="lightbox"]',
        );
        box?.close();
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            resolve(
              Boolean(box?.querySelector('[data-slot="lightbox-frame"]')),
            ),
          ),
        );
      }),
  );
  expect(frameLeft).toBe(false);
  await page.getByRole("button", { name: "Show image 3 of 3" }).click();
  await expect(
    page.locator('[data-gallery-slide="2"][data-current]'),
  ).toHaveCount(1);
  expect((await motionLog(page)).viewTransitions).toEqual([]);
  await context.close();
});

test("table sections below the fold reveal once; nothing on screen is hidden", async ({
  browser,
}) => {
  const { context, page } = await newPage(browser, false);
  await page.goto(`/product/${GATE_B.slug}`);
  await waitForHydration(page, "#variant-option-0");
  const marked = page.locator("[data-reveal]");
  await expect.poll(() => marked.count()).toBeGreaterThan(0);
  // Only targets that start below the fold are ever marked.
  const tops = await marked.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().top),
  );
  for (const top of tops) expect(top).toBeGreaterThan(800);
  // Above-the-fold content and the restricted slot are never marked.
  await expect(
    page.locator('[data-slot="restricted-specs"][data-reveal]'),
  ).toHaveCount(0);
  await expect(panel(page).locator("[data-reveal]")).toHaveCount(0);

  await page.locator('[data-section="models"]').scrollIntoViewIfNeeded();
  await expect(marked).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('[data-section="models"]')).toHaveCSS(
    "opacity",
    "1",
  );
  await context.close();
});

test("the listing morph is inert, and leaving and coming back leaks nothing", async ({
  browser,
}) => {
  const { context, page } = await newPage(browser, false);
  const errors = watchErrors(page);
  await page.goto(`/product/${GATE_B.slug}`);
  await waitForHydration(page, "#variant-option-0");
  await page.waitForTimeout(300);
  const first = await motionLog(page);

  // Client-side navigation to another product (strip link) and back.
  await page
    .locator('[data-section="family"] a', { hasText: "" })
    .first()
    .click();
  await page.waitForURL(`**/product/${GATE_B.siblingSlug}`);
  await waitForHydration(page, '[data-slot="quick-spec-panel"] *');
  await page.goBack();
  await page.waitForURL(`**/product/${GATE_B.slug}`);
  await waitForHydration(page, "#variant-option-0");
  await page.waitForTimeout(300);
  const back = await motionLog(page);

  // Every navigation had nothing to morph: no view transition was started
  // (the shared name exists, but no listing card pairs with it yet).
  expect(back.viewTransitions).toEqual([]);
  // The same observers and keyboard listeners as after the first visit.
  expect(back.observers).toBe(first.observers);
  expect(back.keydown).toBe(first.keydown);
  // No GSAP / ScrollTrigger on this page.
  expect(
    await page.evaluate(() => "ScrollTrigger" in window || "gsap" in window),
  ).toBe(false);
  expect(errors).toEqual([]);
  await context.close();
});
