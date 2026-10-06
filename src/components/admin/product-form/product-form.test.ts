// Unit and render tests for the product edit form (T10a) without a browser:
// form-state conversions and their round trip, error-path mapping (incl.
// `variants.N.modelNo`), the client resolver, publish refusals and markup.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The status card clears a stale notice through the router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  unstable_rethrow: vi.fn(),
}));
// The real actions need a session and a database; they never run here.
vi.mock("@/app/admin/products/actions", () => ({
  updateProductAction: vi.fn(),
  publishProductAction: vi.fn(),
  unpublishProductAction: vi.fn(),
  deleteProductAction: vi.fn(),
}));

import type { ProductFormValues } from "@/lib/schemas/product";

import { magneticTrackIds } from "../product-category-options";
import {
  applyServerErrors,
  describeField,
  flattenFormErrors,
  formFieldForPath,
  productEditResolver,
  serverFieldMessages,
  splitMessages,
} from "./field-errors";
import {
  allowsTrackSize,
  parseNumberList,
  parseProductNo,
  sameParsedInput,
  toFormState,
  toProductInput,
  type ProductEditValues,
} from "./form-values";
import { ProductEditForm } from "./product-edit-form";
import { isRenderedField } from "./sections";
import { statusFailure } from "./status-panel";

const MAIN = "65f0c0ffee0000000000000a";
const TRACK = "65f0c0ffee0000000000000b";
const TRACK_5 = "65f0c0ffee00000000000b05";
const AREA = "65f0c0ffee0000000000000c";
const P = "65f0c0ffee000000000000ff";

/* What getProductForEdit hands the page for a typical draft. */
const stored: ProductFormValues = {
  name: "Arc",
  slug: "arc-ar-013a",
  modelCode: "AR-013A",
  family: "Arc",
  productNo: 76,
  type: "",
  description: "",
  mainCategory: MAIN,
  extraCategories: [],
  areas: [AREA],
  trackSize: null,
  specs: { cct: ["3000K", "4000K"] },
  filters: { cctK: [3000, 4000] },
  variants: [
    {
      modelNo: "AR-013A1",
      label: "Lens",
      specs: { beamAngle: ["24°"] },
      imagePublicId: "",
    },
  ],
  extraSpecs: [{ group: "", label: "Weight", value: "0.4 kg" }],
  publicFiles: [{ label: "IES", url: "https://example.com/a.ies" }],
  datasheetId: null,
  status: "draft",
};
const NO_MAGNETIC = new Set<string>();
const MAGNETIC = new Set([TRACK, TRACK_5]);

describe("form state conversions", () => {
  it("round-trips every field, including the ones section (a) doesn't edit", () => {
    const state = toFormState(stored);
    expect(state.productNo).toBe("76");
    expect(state.filters.cctK).toBe("3000, 4000");
    expect(state.filters.cri).toBe("");
    expect(state.trackSize).toBe("none");
    const { status, ...rest } = stored;
    expect(status).toBe("draft");
    expect(toProductInput(state, NO_MAGNETIC)).toEqual({
      ...rest,
      productNo: 76,
      filters: { cctK: [3000, 4000] },
    });
  });

  it("parses filter lists and the product no.", () => {
    expect(parseNumberList(" 3000, 4000;5000  6500 ")).toEqual({
      ok: true,
      numbers: [3000, 4000, 5000, 6500],
    });
    expect(parseNumberList("")).toEqual({ ok: true, numbers: [] });
    expect(parseNumberList("12.5")).toEqual({ ok: true, numbers: [12.5] });
    expect(parseNumberList("30, abc")).toEqual({
      ok: false,
      message: '"abc" is not a number',
    });
    expect(parseNumberList("-5").ok).toBe(false);
    expect(parseProductNo(" ")).toEqual({ ok: true, value: null });
    expect(parseProductNo("76")).toEqual({ ok: true, value: 76 });
    expect(parseProductNo("7.5").ok).toBe(false);
  });

  it("sends a track size only where Magnetic Track allows one", () => {
    const state: ProductEditValues = {
      ...toFormState(stored),
      trackSize: "10",
    };
    expect(toProductInput(state, MAGNETIC).trackSize).toBeNull();
    expect(
      toProductInput({ ...state, mainCategory: TRACK_5 }, MAGNETIC).trackSize,
    ).toBe(10);
    expect(
      allowsTrackSize(
        { mainCategory: MAIN, extraCategories: [TRACK] },
        MAGNETIC,
      ),
    ).toBe(true);
  });

  it("treats values that differ only in key order as the same", () => {
    expect(sameParsedInput({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(
      true,
    );
    expect(sameParsedInput({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe("magneticTrackIds", () => {
  it("finds Magnetic Track by slug or name and includes its children", () => {
    const node = (id: string, name: string, slug: string) => ({
      id,
      name,
      slug,
      parentId: null,
      order: 0,
      description: null,
      children: [],
    });
    expect(
      magneticTrackIds([
        node(MAIN, "Spot Lights", "spot-lights"),
        {
          ...node(TRACK, "Track", "magnetic-track"),
          children: [{ ...node(TRACK_5, "5mm", "5mm"), parentId: TRACK }],
        },
        node(AREA, " magnetic TRACK ", "other"),
      ]),
    ).toEqual([TRACK, TRACK_5, AREA]);
  });
});

describe("formFieldForPath", () => {
  it.each([
    ["name", "name"],
    ["areas", "areas"],
    ["areas.2", "areas"],
    ["extraCategories.0", "extraCategories"],
    ["filters.cctK", "filters.cctK"],
    ["filters.cctK.3", "filters.cctK"],
    ["variants.3.modelNo", "variants.3.modelNo"],
    ["variants.1.specs.cct", "variants.1.specs.cct"],
    ["variants.1.specs.cct.0", "variants.1.specs.cct"],
    ["variants.0", "variants.0"],
    ["variants", "variants"],
    ["extraSpecs.2.label", "extraSpecs.2.label"],
    ["publicFiles.0.url", "publicFiles.0.url"],
    ["specs.cct", "specs.cct"],
    ["specs.unknown", null],
    ["filters", null],
    ["filters.nope", null],
    ["status", null],
    ["name.0", null],
    ["images", null],
    ["", null],
  ])("%s -> %s", (path, field) => {
    expect(formFieldForPath(path)).toBe(field);
  });

  it("reads Zod paths too", () => {
    expect(formFieldForPath(["variants", 2, "modelNo"])).toBe(
      "variants.2.modelNo",
    );
    expect(formFieldForPath(["filters", "ip", 0])).toBe("filters.ip");
  });

  it("names fields for the alert, counting rows from 1", () => {
    expect(describeField("variants.2.modelNo")).toBe("Variant 3, model no.");
    expect(describeField("variants.0.specs.cct")).toBe("Variant 1, CCT");
    expect(describeField("publicFiles.0.url")).toBe("Public file 1, link");
    expect(describeField("filters.cctK")).toBe("Filter CCT (K)");
    expect(describeField("filters")).toBe("Filters");
    expect(describeField("status")).toBe("");
  });
});

describe("server error mapping", () => {
  const rendered = (field: string) =>
    isRenderedField(field, { trackSize: false });

  it("puts rendered fields on inputs and the rest in the alert", () => {
    const setError = vi.fn();
    const { formMessages, focusedField } = applyServerErrors(
      { setError },
      {
        formErrors: ["Something general"],
        fieldErrors: {
          slug: ["Another product already uses this slug."],
          areas: ["A chosen area no longer exists"],
          "variants.2.modelNo": [
            "This model no. already belongs to another product",
          ],
          trackSize: ["Track size only applies to Magnetic Track products"],
          filters: ["At most 50 values"],
        },
      },
      rendered,
    );
    expect(focusedField).toBe(true);
    expect(setError).toHaveBeenCalledTimes(2);
    expect(setError).toHaveBeenNthCalledWith(
      1,
      "slug",
      { type: "server", message: "Another product already uses this slug." },
      { shouldFocus: true },
    );
    expect(setError).toHaveBeenNthCalledWith(
      2,
      "areas",
      { type: "server", message: "A chosen area no longer exists" },
      { shouldFocus: false },
    );
    expect(formMessages).toEqual([
      "Something general",
      "Variant 3, model no.: This model no. already belongs to another product",
      "Track size: Track size only applies to Magnetic Track products",
      "Filters: At most 50 values",
    ]);
  });

  it("puts a variants error on its input once that input is rendered (T10b)", () => {
    const { fields, form } = splitMessages(
      serverFieldMessages({
        formErrors: [],
        fieldErrors: { "variants.0.modelNo": ["Taken"] },
      }),
      (field) => field.startsWith("variants."),
    );
    expect(fields).toEqual([{ field: "variants.0.modelNo", message: "Taken" }]);
    expect(form).toEqual([]);
  });

  it("refuses to focus anything when only the alert has errors", () => {
    const setError = vi.fn();
    const result = applyServerErrors(
      { setError },
      { formErrors: ["This product no longer exists."], fieldErrors: {} },
      rendered,
    );
    expect(setError).not.toHaveBeenCalled();
    expect(result).toEqual({
      formMessages: ["This product no longer exists."],
      focusedField: false,
    });
  });
});

describe("productEditResolver", () => {
  const resolve = (values: ProductEditValues, magnetic = NO_MAGNETIC) =>
    productEditResolver(magnetic)(values, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });

  it("passes the stored product", async () => {
    const result = await resolve(toFormState(stored));
    expect(result.errors).toEqual({});
  });

  it("flags text the form parses, schema errors and nested variant errors", async () => {
    const state = toFormState(stored);
    const result = await resolve({
      ...state,
      name: " ",
      productNo: "abc",
      filters: { ...state.filters, cri: "80, x" },
    });
    expect(flattenFormErrors(result.errors)).toEqual([
      { field: "productNo", message: "Enter a whole number, e.g. 76" },
      { field: "filters.cri", message: '"x" is not a number' },
      { field: "name", message: "Enter a name" },
    ]);

    // The schema's duplicate check runs once the fields themselves pass.
    const duplicate = await resolve({
      ...state,
      variants: [
        ...state.variants,
        { modelNo: "ar-013a1", label: "", specs: {}, imagePublicId: "" },
      ],
    });
    const flat = flattenFormErrors(duplicate.errors);
    expect(flat).toEqual([
      {
        field: "variants.1.modelNo",
        message: "This model no. is already used by another variant",
      },
    ]);
    // The unrendered variant error is kept for the alert.
    const { form } = splitMessages(flat, (field) =>
      isRenderedField(field, { trackSize: false }),
    );
    expect(form).toEqual([
      "Variant 2, model no.: This model no. is already used by another variant",
    ]);
  });
});

describe("statusFailure", () => {
  it("lists each publishCheck reason without the generic status line", () => {
    expect(
      statusFailure(
        {
          formErrors: [],
          fieldErrors: {
            status: ["This product cannot be published yet."],
            variants: ["Add at least one variant (model no.)"],
            images: ["Add at least one image"],
          },
        },
        true,
        false,
      ),
    ).toEqual({
      title: "This product can't be published yet",
      items: ["Add at least one variant (model no.)", "Add at least one image"],
    });
  });

  it("shows other failures plainly", () => {
    expect(
      statusFailure(
        { formErrors: ["This product no longer exists."], fieldErrors: {} },
        false,
        false,
      ),
    ).toEqual({
      title: "Not moved to draft",
      items: ["This product no longer exists."],
    });
  });

  it("titles a written-but-not-audited or unconfirmed change as such", () => {
    const audit = { formErrors: ["Audit failed"], fieldErrors: {} };
    expect(statusFailure(audit, true, true).title).toBe(
      "Published, with a problem",
    );
    expect(statusFailure(audit, false, true).title).toBe(
      "Moved to draft, with a problem",
    );
    expect(statusFailure(audit, true, "unknown").title).toBe(
      "The change could not be confirmed",
    );
  });
});

describe("ProductEditForm", () => {
  const render = (
    values: ProductFormValues = stored,
    magnetic: string[] = [],
    problems: string[] = ["Add at least one image"],
  ) =>
    renderToStaticMarkup(
      createElement(ProductEditForm, {
        product: {
          id: P,
          status: values.status ?? "draft",
          values,
          updatedAt: "2026-10-06T12:00:00.000Z",
        },
        categories: [
          { id: MAIN, label: "Spot Lights" },
          { id: TRACK, label: "Magnetic Track" },
        ],
        areas: [{ id: AREA, label: "Office <b>" }],
        magneticTrackIds: magnetic,
        publishProblems: problems,
      }),
    );

  it("labels every input of section (a) and ties help text to it", () => {
    const html = render();
    for (const id of [
      "product-name",
      "product-slug",
      "product-family",
      "product-modelCode",
      "product-productNo",
      "product-type",
      "product-description",
      "product-mainCategory",
      "product-filters-cctK",
      "product-filters-ip",
      `product-areas-${AREA}`,
      `product-extraCategories-${TRACK}`,
    ]) {
      expect(html, id).toContain(`for="${id}"`);
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toContain('aria-describedby="product-name-help"');
    expect(html).toContain('value="3000, 4000"');
    // Lists need commas and spaces: no decimal-only phone keypad.
    expect(html).not.toContain('inputMode="decimal"');
    expect(html).not.toContain('inputmode="decimal"');
    expect(html).toContain("Save changes");
  });

  it("escapes labels and shows the kept variants read-only", () => {
    const html = render();
    expect(html).toContain("Office &lt;b&gt;");
    expect(html).toContain("Variants (1)");
    expect(html).toContain("AR-013A1");
  });

  it("disables the main category in the extra list", () => {
    const html = render();
    const tag = new RegExp(
      `<button[^>]*id="product-extraCategories-${MAIN}"[^>]*>`,
    ).exec(html)?.[0];
    expect(tag).toContain(` disabled=""`);
    const other = new RegExp(
      `<button[^>]*id="product-extraCategories-${TRACK}"[^>]*>`,
    ).exec(html)?.[0];
    expect(other).not.toContain(` disabled=""`);
    expect(html).toContain("(main category)");
  });

  it("shows the track size only for Magnetic Track", () => {
    expect(render()).not.toContain('id="product-trackSize"');
    expect(render({ ...stored, mainCategory: TRACK }, [TRACK])).toContain(
      'id="product-trackSize"',
    );
  });

  it("shows status, publish blockers and the delete action", () => {
    const draft = render();
    expect(draft).toContain("Draft");
    expect(draft).toContain(">Publish<");
    expect(draft).toContain("Add at least one image");
    expect(draft).toContain("Delete product");

    const live = render({ ...stored, status: "published" }, [], []);
    expect(live).toContain("Published");
    expect(live).toContain("Move to draft");
    expect(live).toContain("changing the slug changes its URL");
  });
});
