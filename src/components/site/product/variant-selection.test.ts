// P5 unit tests: the variant switcher's pure rules (deep-link parsing, model
// matching, URL building, legend, announcement, changed values, row union)
// and the server render of the client leaves (variant 1, no mismatch).

import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ProductDetailClient,
  SelectedModelNo,
  SelectVariantButton,
  VariantSpecValues,
  VariantText,
} from "./product-detail-client";
import {
  differingKeys,
  modelFromSearch,
  switcherLegend,
  unionVariantSpecs,
  urlWithModel,
  valueChanged,
  variantAnnouncement,
  variantIndexForModel,
  type SwitchVariant,
} from "./variant-selection";
import { VariantSwitcher } from "./variant-switcher";

const v = (
  modelNo: string,
  specs: SwitchVariant["specs"],
  label: string | null = null,
): SwitchVariant => ({ modelNo, label, imagePublicId: null, specs });

const LENS = v(
  "AR-013A1",
  {
    lens: ["PC lens"],
    cct: ["3000K", "4000K"],
    lumenOutput: ["1100lm"],
    lumenEfficiency: ["92lm/W"],
  },
  "Regular lens",
);
const REFLECTOR = v(
  "AR-013A2",
  {
    lens: ["Reflector"],
    cct: ["3000K", "4000K"],
    lumenOutput: ["1200"],
    lumenEfficiency: ["100"],
  },
  "Reflector",
);

describe("modelFromSearch", () => {
  it("reads ?model= among other parameters, trimmed", () => {
    expect(modelFromSearch("?a=1&model=AR-013A2&b=2")).toBe("AR-013A2");
    expect(modelFromSearch("model=%20ar-013a2%20")).toBe("ar-013a2");
  });

  it("is null when missing, empty or absurdly long", () => {
    expect(modelFromSearch("")).toBeNull();
    expect(modelFromSearch("?model=")).toBeNull();
    expect(modelFromSearch("?model=%20%20")).toBeNull();
    expect(modelFromSearch(`?model=${"A".repeat(65)}`)).toBeNull();
    expect(modelFromSearch(`?model=${"A".repeat(64)}`)).toBe("A".repeat(64));
  });

  it("uses the first value when repeated", () => {
    expect(modelFromSearch("?model=AR-013A2&model=AR-013A1")).toBe("AR-013A2");
  });
});

describe("variantIndexForModel", () => {
  const variants = [LENS, REFLECTOR];

  it("matches case-insensitively, like the unique index", () => {
    expect(variantIndexForModel(variants, "AR-013A2")).toBe(1);
    expect(variantIndexForModel(variants, "ar-013a2")).toBe(1);
    expect(variantIndexForModel(variants, " Ar-013A1 ")).toBe(0);
    // Full-width letters fold like MongoDB's collation (NFKC).
    expect(variantIndexForModel(variants, "ＡＲ-013A2")).toBe(1);
  });

  it("is null for no match, so the caller falls back to variant 1", () => {
    expect(variantIndexForModel(variants, "AR-013A3")).toBeNull();
    expect(variantIndexForModel(variants, "")).toBeNull();
    expect(variantIndexForModel(variants, null)).toBeNull();
    expect(variantIndexForModel([], "AR-013A1")).toBeNull();
  });
});

describe("urlWithModel", () => {
  it("sets the model and keeps path, other parameters and hash", () => {
    expect(
      urlWithModel("https://x.test/product/arc?ref=list#models", "AR-013A2"),
    ).toBe("/product/arc?ref=list&model=AR-013A2#models");
  });

  it("replaces an existing model and can remove it", () => {
    expect(urlWithModel("/product/arc?model=OLD", "AR-013A1")).toBe(
      "/product/arc?model=AR-013A1",
    );
    expect(urlWithModel("/product/arc?model=OLD&x=1", null)).toBe(
      "/product/arc?x=1",
    );
  });

  it("never returns an origin (same-document replaceState only)", () => {
    expect(urlWithModel("https://evil.test/p", "A")).toBe("/p?model=A");
  });

  it("encodes model nos. with reserved characters", () => {
    expect(urlWithModel("/p", "A&B #1")).toBe("/p?model=A%26B+%231");
    expect(modelFromSearch("?model=A%26B+%231")).toBe("A&B #1");
  });
});

describe("legend and differing columns", () => {
  it("names the one differing column, ignoring the output readout", () => {
    expect(differingKeys([LENS, REFLECTOR])).toEqual(["lens"]);
    expect(switcherLegend([LENS, REFLECTOR])).toBe("Lens");
  });

  it("joins optic columns when only those differ", () => {
    const a = v("A1", { lens: ["PC"], reflector: ["Silver"] });
    const b = v("A2", { lens: ["None"], reflector: ["Black"] });
    expect(switcherLegend([a, b])).toBe("Lens / Reflector");
  });

  it("falls back to Option for several unrelated columns or none", () => {
    const a = v("A1", { lens: ["PC"], wattage: ["7W"] });
    const b = v("A2", { lens: ["None"], wattage: ["9W"] });
    expect(switcherLegend([a, b])).toBe("Option");
    expect(switcherLegend([v("A1", { cct: ["3000K"] }), v("A2", {})])).toBe(
      "CCT",
    );
    expect(switcherLegend([v("A1", {}), v("A2", {})])).toBe("Option");
    expect(switcherLegend([LENS])).toBe("Option");
  });
});

describe("variantAnnouncement", () => {
  it("speaks the model no., lumens and efficacy with units", () => {
    expect(variantAnnouncement(REFLECTOR)).toBe(
      "AR-013A2 selected, 1200 lumens, 100 lm/W",
    );
    expect(variantAnnouncement(LENS)).toBe(
      "AR-013A1 selected, 1100 lumens, 92 lm/W",
    );
  });

  it("handles thousands separators, options and free text", () => {
    expect(
      variantAnnouncement(
        v("X", { lumenOutput: ["1,200 lm", "1500"], lumenEfficiency: ["n/a"] }),
      ),
    ).toBe("X selected, 1200 or 1500 lumens, lumen efficiency n/a");
  });

  it("leaves out values the variant does not have", () => {
    expect(variantAnnouncement(v("X", {}))).toBe("X selected");
  });
});

describe("valueChanged and unionVariantSpecs", () => {
  it("flags only the fields whose value differs", () => {
    expect(valueChanged("model-no", LENS, REFLECTOR)).toBe(true);
    expect(valueChanged("lens", LENS, REFLECTOR)).toBe(true);
    expect(valueChanged("cct", LENS, REFLECTOR)).toBe(false);
    expect(valueChanged("wattage", LENS, REFLECTOR)).toBe(false);
    expect(valueChanged("lens", undefined, REFLECTOR)).toBe(false);
  });

  it("keeps every column any variant fills, variant 1's value first", () => {
    const a = v("A1", { lens: ["PC"] });
    const b = v("A2", { lens: ["None"], beamAngle: ["24°"] });
    expect(unionVariantSpecs([a, b], {})).toEqual({
      lens: ["PC"],
      beamAngle: ["24°"],
    });
    expect(unionVariantSpecs([], { cct: ["3000K"] })).toEqual({
      cct: ["3000K"],
    });
  });
});

/* createElement's types want `children` in the props object, the lint rule
   wants it as an argument: give the provider an optional-children type. */
const Provider = ProductDetailClient as FunctionComponent<{
  variants: readonly SwitchVariant[];
  children?: ReactNode;
}>;

describe("server render of the client leaves", () => {
  const render = (children: ReactNode) =>
    renderToStaticMarkup(
      createElement(Provider, { variants: [LENS, REFLECTOR] }, children),
    );

  it("shows variant 1 (the cached page never reads ?model=)", () => {
    const html = render([
      createElement(VariantText, { key: 1, field: "model-no" }),
      createElement(VariantText, { key: 2, field: "lumenOutput" }),
      createElement(VariantSpecValues, { key: 3, specKey: "cct" }),
      createElement(SelectedModelNo, { key: 4 }),
    ]);
    expect(html).toMatch(/data-field="model-no"[^>]*>AR-013A1</);
    expect(html).toMatch(/data-field="lumenOutput"[^>]*>1100lm</);
    expect(html).toMatch(/<li[^>]*>3000K<\/li><li[^>]*>4000K<\/li>/);
    expect(html).not.toContain("AR-013A2");
    // Nothing is highlighted before a switch.
    expect(html).not.toContain("data-changed");
  });

  it("marks an empty value as not applicable instead of hiding the row", () => {
    const html = render(createElement(VariantSpecValues, { specKey: "ugr" }));
    expect(html).toContain("Not applicable for this model");
  });

  it("renders a native radio group with legend, labels and an empty live region", () => {
    const html = render(
      createElement(VariantSwitcher, { legend: "Lens", name: "variant-p1" }),
    );
    expect(html).toContain("<fieldset");
    expect(html).toMatch(/<legend[^>]*>Lens<\/legend>/);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/name="variant-p1"/g)).toHaveLength(2);
    expect(html).toMatch(/id="variant-option-0"[^>]*checked=""/);
    expect(html).not.toMatch(/id="variant-option-1"[^>]*checked=""/);
    expect(html).toContain('for="variant-option-1"');
    // Label first, model no. as secondary text.
    expect(html.indexOf(">Regular lens<")).toBeGreaterThan(-1);
    expect(html.indexOf(">Regular lens<")).toBeLessThan(
      html.indexOf(">AR-013A1<"),
    );
    expect(html).toMatch(/<p aria-live="polite" aria-atomic="true"[^>]*><\/p>/);
  });

  it("names the Models table button with its model no.", () => {
    const html = render(
      createElement(SelectVariantButton, { index: 1, modelNo: "AR-013A2" }),
    );
    expect(html).toMatch(
      /<button type="button"[^>]*>Select<span class="sr-only"> AR-013A2<\/span><\/button>/,
    );
  });

  it("shows the selected row as plain text, not a button", () => {
    const html = render(
      createElement(SelectVariantButton, { index: 0, modelNo: "AR-013A1" }),
    );
    expect(html).not.toContain("<button");
    expect(html).toMatch(
      /<span[^>]*>Selected<span class="sr-only"> AR-013A1<\/span><\/span>/,
    );
  });

  it("throws outside the provider (a wiring mistake, not a silent blank)", () => {
    expect(() =>
      renderToStaticMarkup(createElement(VariantText, { field: "model-no" })),
    ).toThrow(/outside ProductDetailClient/);
  });
});
