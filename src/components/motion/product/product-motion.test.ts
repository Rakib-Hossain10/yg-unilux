// Product-page motion pass (P8): pure helpers, the crossfade guard rails,
// the motion CSS contract (only opacity/transform, all behind
// prefers-reduced-motion) and "nothing motion-only in the server HTML".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProductDetailClient,
  VariantText,
} from "@/components/site/product/product-detail-client";

import {
  crossfadeJump,
  GALLERY_JUMP_NAME,
  GALLERY_JUMP_TYPE,
  isCrossfadeJump,
} from "./gallery-jump";
import {
  ProductImageTransition,
  productImageTransitionName,
} from "./product-image-transition";
import { SectionReveal } from "./section-reveal";
import { ValueCrossfade } from "./value-crossfade";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isCrossfadeJump", () => {
  it("slides to a neighbour and crossfades anything further", () => {
    expect(isCrossfadeJump(0, 1)).toBe(false);
    expect(isCrossfadeJump(2, 1)).toBe(false);
    expect(isCrossfadeJump(0, 2)).toBe(true);
    expect(isCrossfadeJump(4, 0)).toBe(true);
    expect(isCrossfadeJump(3, 3)).toBe(false);
  });
});

describe("productImageTransitionName", () => {
  it("is stable per product and a valid custom ident", () => {
    const id = "66f1a2b3c4d5e6f7a8b9c0d1";
    expect(productImageTransitionName(id)).toBe(`product-image-${id}`);
    expect(productImageTransitionName("a b/<c>")).toBe("product-image-abc");
  });
});

/* A minimal browser for crossfadeJump: matchMedia, CSS.supports, a header. */
function stubBrowser({
  reduced = false,
  supports = true,
  headerBottom = 64,
  startViewTransition,
}: {
  reduced?: boolean;
  supports?: boolean;
  headerBottom?: number;
  startViewTransition?: (options: {
    update: () => void;
    types: string[];
  }) => unknown;
}) {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: reduced && query.includes("reduce"),
    }),
  });
  vi.stubGlobal("CSS", { supports: () => supports });
  vi.stubGlobal("document", {
    startViewTransition,
    querySelector: () => ({
      getBoundingClientRect: () => ({ bottom: headerBottom }),
    }),
  });
}

function fakeFrame(top: number) {
  const style = new Map<string, string>();
  return {
    style: {
      setProperty: (name: string, value: string) => style.set(name, value),
      removeProperty: (name: string) => style.delete(name),
    },
    getBoundingClientRect: () => ({ top }),
    styleMap: style,
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("crossfadeJump", () => {
  it("names the frame for one typed transition and releases it after", async () => {
    let finish: () => void = () => undefined;
    const calls: { types: string[] }[] = [];
    stubBrowser({
      startViewTransition: (options) => {
        calls.push(options);
        options.update();
        return {
          ready: Promise.resolve(),
          updateCallbackDone: Promise.resolve(),
          finished: new Promise<void>((resolve) => (finish = resolve)),
        };
      },
    });
    const frame = fakeFrame(120);
    const update = vi.fn();
    expect(crossfadeJump(frame as unknown as HTMLElement, update)).toBe(true);
    expect(update).toHaveBeenCalledOnce();
    expect(calls[0]?.types).toEqual([GALLERY_JUMP_TYPE]);
    expect(frame.styleMap.get("view-transition-name")).toBe(GALLERY_JUMP_NAME);
    finish();
    await settled();
    expect(frame.styleMap.has("view-transition-name")).toBe(false);
  });

  it("swallows the rejections of a skipped transition", async () => {
    const skipped = () => Promise.reject(new Error("skipped"));
    stubBrowser({
      startViewTransition: ({ update }) => {
        update();
        return {
          ready: skipped(),
          updateCallbackDone: Promise.resolve(),
          finished: Promise.resolve(),
        };
      },
    });
    const frame = fakeFrame(120);
    expect(crossfadeJump(frame as unknown as HTMLElement, vi.fn())).toBe(true);
    await settled();
    expect(frame.styleMap.size).toBe(0);
  });

  it.each([
    ["reduced motion", { reduced: true }],
    ["no transition types", { supports: false }],
    ["the sticky header overlaps the frame", { headerBottom: 200 }],
  ])("falls back to the caller's scroll with %s", (_, options) => {
    const start = vi.fn();
    stubBrowser({ ...options, startViewTransition: start });
    const update = vi.fn();
    expect(
      crossfadeJump(fakeFrame(120) as unknown as HTMLElement, update),
    ).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("falls back without the API and clears the name if it throws", () => {
    stubBrowser({});
    expect(
      crossfadeJump(fakeFrame(120) as unknown as HTMLElement, vi.fn()),
    ).toBe(false);
    stubBrowser({
      startViewTransition: () => {
        throw new TypeError("old signature");
      },
    });
    const frame = fakeFrame(120);
    expect(crossfadeJump(frame as unknown as HTMLElement, vi.fn())).toBe(false);
    expect(frame.styleMap.size).toBe(0);
  });
});

/* Props without children: they go in createElement's third argument. */
type Props<C extends (props: never) => unknown> = Parameters<C>[0];
const withoutChildren = <C extends (props: never) => unknown>(
  props: Omit<Props<C>, "children">,
) => props as Props<C>;

describe("server HTML", () => {
  const variants = [
    { modelNo: "AR-013A1", label: null, imagePublicId: null, specs: {} },
    { modelNo: "AR-013A2", label: null, imagePublicId: null, specs: {} },
  ];

  it("an unchanged value is the bare P5 span (no crossfade wrapper)", () => {
    const html = renderToStaticMarkup(
      createElement(
        ProductDetailClient,
        withoutChildren<typeof ProductDetailClient>({ variants }),
        createElement(VariantText, { field: "model-no" }),
      ),
    );
    expect(html).toBe(
      '<span data-field="model-no" class="variant-value">AR-013A1</span>',
    );
  });

  it("the crossfade never renders its old value on the server", () => {
    const html = renderToStaticMarkup(
      createElement(
        ValueCrossfade,
        withoutChildren<typeof ValueCrossfade>({ previous: "AR-013A1" }),
        createElement("span", null, "AR-013A2"),
      ),
    );
    expect(html).toBe(
      '<span class="value-crossfade"><span>AR-013A2</span></span>',
    );
  });

  it("the shared-element wrapper and the reveal add no markup", () => {
    expect(
      renderToStaticMarkup(
        createElement(
          ProductImageTransition,
          withoutChildren<typeof ProductImageTransition>({ productId: "p1" }),
          createElement("div", { id: "stage" }),
        ),
      ),
    ).toBe('<div id="stage"></div>');
    expect(renderToStaticMarkup(createElement(SectionReveal))).toBe("");
  });
});

describe("product-motion.css", () => {
  const css = readFileSync(
    fileURLToPath(new URL("./product-motion.css", import.meta.url)),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  /* Each declaration with the at-rule preludes it sits in. */
  function declarations(): { prelude: string[]; text: string }[] {
    const out: { prelude: string[]; text: string }[] = [];
    const stack: string[] = [];
    let buffer = "";
    for (const char of css) {
      if (char === "{") {
        stack.push(buffer.trim());
        buffer = "";
      } else if (char === "}") {
        if (buffer.trim())
          out.push({ prelude: [...stack], text: buffer.trim() });
        stack.pop();
        buffer = "";
      } else if (char === ";") {
        out.push({ prelude: [...stack], text: buffer.trim() });
        buffer = "";
      } else {
        buffer += char;
      }
    }
    return out;
  }

  const ALLOWED_KEYFRAME_PROPS = new Set(["opacity", "transform"]);
  const ALLOWED_TRANSITION_PROPS = new Set([
    "opacity",
    "transform",
    "display",
    "overlay",
  ]);

  it("keyframes animate only opacity and transform", () => {
    const inKeyframes = declarations().filter((d) =>
      d.prelude.some((p) => p.startsWith("@keyframes")),
    );
    expect(inKeyframes.length).toBeGreaterThan(0);
    for (const d of inKeyframes) {
      const property = d.text.split(":")[0]?.trim() ?? "";
      expect(ALLOWED_KEYFRAME_PROPS.has(property), d.text).toBe(true);
    }
  });

  it("transitions list only opacity, transform and the dialog hand-off", () => {
    const transitions = declarations().filter((d) =>
      /^transition\s*:/.test(d.text),
    );
    expect(transitions.length).toBeGreaterThan(0);
    for (const d of transitions) {
      for (const part of d.text.replace(/^transition\s*:/, "").split(",")) {
        const property = part.trim().split(/\s+/)[0] ?? "";
        expect(ALLOWED_TRANSITION_PROPS.has(property), d.text).toBe(true);
      }
    }
  });

  it("every animation and transition runs only without reduced motion", () => {
    const moving = declarations().filter(
      (d) =>
        /^(animation|transition)\s*:/.test(d.text) &&
        !/:\s*none\s*$/.test(d.text) &&
        !d.prelude.some((p) => p.startsWith("@keyframes")),
    );
    expect(moving.length).toBeGreaterThan(0);
    for (const d of moving) {
      const guarded = d.prelude.some((p) =>
        /prefers-reduced-motion:\s*no-preference/.test(p),
      );
      // View-transition pseudo-elements only exist during a transition the
      // code starts after checking the setting (and are zeroed under reduce).
      const viewTransition = d.prelude.some((p) =>
        p.includes("::view-transition"),
      );
      expect(guarded || viewTransition, d.text).toBe(true);
    }
  });

  it("view transitions collapse under reduced motion", () => {
    expect(css).toMatch(
      /prefers-reduced-motion:\s*reduce\)\s*{\s*::view-transition-group\(\*\)/,
    );
  });
});
