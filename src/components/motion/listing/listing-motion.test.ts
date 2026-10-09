// Listing + header motion pass (Phase 4b L7): the long-facet split, the
// transition types a refinement carries, the results crossfade boundary
// (no DOM of its own), the facet disclosure in the server HTML, and the
// motion CSS contract for listing-motion.css and menu-motion.css (only
// opacity/transform, all behind prefers-reduced-motion).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

import {
  FilterForm,
  type FilterFormGroup,
} from "@/components/site/listing/filter-form";

import {
  FACET_COLLAPSE_AT,
  FACET_VISIBLE,
  moreHasSelected,
  showMoreLabel,
  splitFacetOptions,
} from "./facet-collapse";
import {
  beginListingRefine,
  endListingRefine,
  isListingRefinePending,
  LISTING_REFINE_ATTR,
  resetListingRefine,
  shouldCrossfade,
} from "./filter-transition";
import { ListingResultsTransition } from "./listing-results-transition";

afterEach(() => {
  vi.unstubAllGlobals();
});

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("splitFacetOptions", () => {
  it("keeps short facets whole (never hides one or two values)", () => {
    for (const n of [0, 1, FACET_VISIBLE + 1, FACET_COLLAPSE_AT]) {
      const { visible, more } = splitFacetOptions(range(n));
      expect(visible).toEqual(range(n));
      expect(more).toEqual([]);
    }
  });

  it("shows the first values and keeps the rest, in order", () => {
    const options = range(50);
    const { visible, more } = splitFacetOptions(options);
    expect(visible).toEqual(range(FACET_VISIBLE));
    expect(more).toEqual(options.slice(FACET_VISIBLE));
    expect(more.length).toBeGreaterThan(FACET_COLLAPSE_AT - FACET_VISIBLE);
  });

  it("opens when a hidden value is checked", () => {
    const more = [{ value: "5000" }, { value: "6500" }];
    expect(moreHasSelected(more, (v) => v === "6500")).toBe(true);
    expect(moreHasSelected(more, () => false)).toBe(false);
    expect(showMoreLabel(44)).toBe("Show 44 more");
  });
});

/* A minimal browser for the refine flag. */
function stubMotion(reduced: boolean | null) {
  vi.stubGlobal(
    "window",
    reduced === null
      ? {}
      : {
          matchMedia: (query: string) => ({
            matches: reduced && query.includes("reduce"),
          }),
        },
  );
  const attrs = new Set<string>();
  vi.stubGlobal("document", {
    documentElement: {
      setAttribute: (name: string) => attrs.add(name),
      removeAttribute: (name: string) => attrs.delete(name),
    },
  });
  return attrs;
}

const element = (inDialog: boolean) =>
  ({
    closest: (selector: string) =>
      selector === "dialog" && inDialog ? {} : null,
  }) as unknown as Element;

describe("refine flag", () => {
  afterEach(() => {
    resetListingRefine();
    vi.useRealTimers();
  });

  it("crossfades a refinement from the page, not from the sheet", () => {
    stubMotion(false);
    expect(shouldCrossfade(element(false))).toBe(true);
    expect(shouldCrossfade(null)).toBe(true);
    expect(shouldCrossfade(element(true))).toBe(false);
  });

  it("never under reduced motion or without matchMedia", () => {
    stubMotion(true);
    expect(shouldCrossfade(element(false))).toBe(false);
    stubMotion(null);
    expect(shouldCrossfade(element(false))).toBe(false);
  });

  it("is raised for one commit and the html mark is dropped after it", () => {
    vi.useFakeTimers();
    const attrs = stubMotion(false);
    beginListingRefine(element(false));
    expect(isListingRefinePending()).toBe(true);
    expect(attrs.has(LISTING_REFINE_ATTR)).toBe(true);
    endListingRefine();
    expect(isListingRefinePending()).toBe(false);
    expect(attrs.has(LISTING_REFINE_ATTR)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(attrs.has(LISTING_REFINE_ATTR)).toBe(false);
  });

  it("stays down for the sheet and under reduced motion", () => {
    let attrs = stubMotion(false);
    beginListingRefine(element(true));
    expect(isListingRefinePending()).toBe(false);
    expect(attrs.size).toBe(0);
    attrs = stubMotion(true);
    beginListingRefine(element(false));
    expect(isListingRefinePending()).toBe(false);
    expect(attrs.size).toBe(0);
  });

  it("a later refinement keeps the mark until its own commit", () => {
    vi.useFakeTimers();
    const attrs = stubMotion(false);
    beginListingRefine(null);
    endListingRefine();
    vi.advanceTimersByTime(500);
    beginListingRefine(null);
    vi.advanceTimersByTime(2000);
    expect(attrs.has(LISTING_REFINE_ATTR)).toBe(true);
    resetListingRefine();
    expect(attrs.has(LISTING_REFINE_ATTR)).toBe(false);
  });
});

describe("ListingResultsTransition", () => {
  it("adds no DOM: the server HTML is the section alone", () => {
    const section = createElement(
      "section",
      { "aria-labelledby": "x" },
      "cards",
    );
    expect(
      renderToStaticMarkup(
        createElement(ListingResultsTransition, null, section),
      ),
    ).toBe(renderToStaticMarkup(section));
  });
});

describe("FilterForm long facets (server HTML)", () => {
  const cct: FilterFormGroup = {
    param: "cct",
    label: "CCT",
    options: range(20).map((i) => ({
      value: String(2700 + i * 100),
      label: `${2700 + i * 100}K`,
      count: 1,
    })),
  };
  const ip: FilterFormGroup = {
    param: "ip",
    label: "IP rating",
    options: [
      { value: "20", label: "IP20", count: 3 },
      { value: "65", label: "IP65", count: 1 },
    ],
  };
  const render = (selected: string[]) =>
    renderToStaticMarkup(
      createElement(FilterForm, {
        idPrefix: "rail",
        action: "/products",
        groups: [cct, ip],
        selected,
        sort: "catalog",
        appliedKey: selected.join("&"),
        total: 20,
      }),
    );

  it("renders every value as a checkbox (all submit), the rest in a closed disclosure", () => {
    const html = render([]);
    expect(html.match(/type="checkbox"/g)).toHaveLength(22);
    expect(html.match(/data-slot="facet-more"/g)).toHaveLength(1);
    expect(html).toContain(showMoreLabel(20 - FACET_VISIBLE));
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    // The first values are outside the disclosure, the 7th inside it.
    const details = html.slice(
      html.indexOf("<details"),
      html.indexOf("</details>"),
    );
    expect(html.indexOf('id="rail-cct-2700"')).toBeLessThan(
      html.indexOf("<details"),
    );
    expect(details).toContain('id="rail-cct-3300"');
    expect(details).not.toContain('id="rail-ip-20"');
  });

  it("starts open when a hidden value is applied", () => {
    expect(render(["cct=4500"])).toMatch(
      /<details[^>]*\sopen[^>]*data-slot="facet-more"|<details[^>]*data-slot="facet-more"[^>]*\sopen/,
    );
    expect(render(["cct=2700"])).not.toMatch(/<details[^>]*\sopen/);
  });
});

/* ---- Motion CSS contract ---------------------------------------------- */

function readCss(path: string): string {
  return readFileSync(
    fileURLToPath(new URL(path, import.meta.url)),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
}

/* Each declaration with the selector / at-rule preludes it sits in. */
function declarations(css: string): { prelude: string[]; text: string }[] {
  const out: { prelude: string[]; text: string }[] = [];
  const stack: string[] = [];
  let buffer = "";
  for (const char of css) {
    if (char === "{") {
      stack.push(buffer.trim());
      buffer = "";
    } else if (char === "}") {
      if (buffer.trim()) out.push({ prelude: [...stack], text: buffer.trim() });
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

describe.each([
  ["listing-motion.css", "./listing-motion.css"],
  ["menu-motion.css", "../menu/menu-motion.css"],
])("%s", (_name, path) => {
  const css = readCss(path);
  const all = declarations(css);

  it("keyframes animate only opacity and transform", () => {
    const inKeyframes = all.filter((d) =>
      d.prelude.some((p) => p.startsWith("@keyframes")),
    );
    expect(inKeyframes.length).toBeGreaterThan(0);
    for (const d of inKeyframes) {
      const property = d.text.split(":")[0]?.trim() ?? "";
      expect(ALLOWED_KEYFRAME_PROPS.has(property), d.text).toBe(true);
    }
  });

  it("transitions list only opacity, transform and the display hand-off", () => {
    for (const d of all.filter((x) => /^transition\s*:/.test(x.text))) {
      for (const part of d.text.replace(/^transition\s*:/, "").split(",")) {
        const property = part.trim().split(/\s+/)[0] ?? "";
        expect(ALLOWED_TRANSITION_PROPS.has(property), d.text).toBe(true);
      }
    }
  });

  it("every animation and transition runs only without reduced motion", () => {
    const moving = all.filter(
      (d) =>
        /^(animation|transition)(-[a-z]+)?\s*:/.test(d.text) &&
        !/:\s*none\s*$/.test(d.text) &&
        !d.prelude.some((p) => p.startsWith("@keyframes")),
    );
    expect(moving.length).toBeGreaterThan(0);
    for (const d of moving) {
      const guarded = d.prelude.some((p) =>
        /prefers-reduced-motion:\s*no-preference/.test(p),
      );
      // View-transition pseudo-elements only exist during a transition
      // (zeroed under reduce in product-motion.css).
      const viewTransition = d.prelude.some((p) =>
        p.includes("::view-transition"),
      );
      expect(guarded || viewTransition, d.text).toBe(true);
    }
  });

  it("hides nothing outside a motion-only or visitor-opened state", () => {
    // Every opacity: 0 / offset start state is either inside a keyframe, a
    // @starting-style, a hidden/closed element, or a view-transition pseudo.
    for (const d of all) {
      if (!/^opacity\s*:\s*0(\.0+)?\s*$/.test(d.text)) continue;
      const ok = d.prelude.some(
        (p) =>
          p.startsWith("@keyframes") ||
          p.startsWith("@starting-style") ||
          p.includes("[hidden]") ||
          p.includes("::view-transition") ||
          /dialog\[data-slot="search-overlay"\](::backdrop)?(,|$)/.test(p),
      );
      expect(ok, `${d.prelude.join(" > ")} { ${d.text} }`).toBe(true);
    }
  });
});

describe("globals.css", () => {
  it("imports both motion files", () => {
    const globals = readFileSync(
      fileURLToPath(new URL("../../../app/globals.css", import.meta.url)),
      "utf8",
    );
    expect(globals).toContain("motion/listing/listing-motion.css");
    expect(globals).toContain("motion/menu/menu-motion.css");
  });
});
