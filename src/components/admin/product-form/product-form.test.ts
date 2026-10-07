// Unit and render tests for the product edit form (T10a/b) without a browser:
// form-state conversions and their round trip (specs, variants, extra specs,
// public files), error-path mapping, the resolver, publish refusals and markup.

import type { PublishProblem } from "@/lib/schemas/product";
import { createElement, type ComponentProps } from "react";
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

import { FormProvider, useForm, type FieldErrors } from "react-hook-form";

import {
  productInputSchema,
  type ProductFormValues,
} from "@/lib/schemas/product";
import { MAX_VARIANTS } from "@/lib/constants";
import { testPublicId } from "../../../../test/helpers/public-ids";
import { DEFAULT_RESTRICTED_SPEC_KEYS, SPEC_KEYS } from "@/models/spec-columns";

import { magneticTrackIds } from "../product-category-options";
import {
  applyServerErrors,
  describeField,
  errorPath,
  flattenFormErrors,
  formFieldForPath,
  productEditResolver,
  serverFieldMessages,
  splitMessages,
} from "./field-errors";
import {
  allowsTrackSize,
  EMPTY_VARIANT,
  parseNumberList,
  parseProductNo,
  sameParsedInput,
  textsToSpecs,
  textToOptions,
  toFormState,
  toProductInput,
  type ProductEditValues,
} from "./form-values";
import { ProductEditForm } from "./product-edit-form";
import { indexAfterRemove } from "./row-controls";
import { isRenderedField, type RenderedRows } from "./sections";
import { SPEC_GROUPS } from "./spec-groups";
import { statusFailure } from "./status-panel";
import { reasonTarget } from "./status-links";
import { VariantsEditor } from "./variants-editor";

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

describe("reasonTarget", () => {
  it("links each publishCheck field to a real anchor", () => {
    expect(reasonTarget("variants")).toBe("product-section-variants");
    expect(reasonTarget("images")).toBe("product-section-images");
    expect(reasonTarget("mainCategory")).toBe("product-mainCategory");
    expect(reasonTarget("datasheetId")).toBe("product-datasheetId");
    expect(reasonTarget("status")).toBeNull();
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
      items: [
        { text: "Add at least one variant (model no.)", field: "variants" },
        { text: "Add at least one image", field: "images" },
      ],
    });
  });

  it("lists the missing main category and datasheet reasons too", () => {
    expect(
      statusFailure(
        {
          formErrors: [],
          fieldErrors: {
            mainCategory: ["This category no longer exists"],
            datasheetId: ["This datasheet no longer exists"],
          },
        },
        true,
        false,
      ).items,
    ).toEqual([
      { text: "This category no longer exists", field: "mainCategory" },
      { text: "This datasheet no longer exists", field: "datasheetId" },
    ]);
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
      items: [{ text: "This product no longer exists." }],
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
    problems: PublishProblem[] = [
      { field: "images", message: "Add at least one image" },
    ],
  ) =>
    renderToStaticMarkup(
      createElement(ProductEditForm, {
        product: {
          id: P,
          status: values.status ?? "draft",
          values,
          updatedAt: "2026-10-06T12:00:00.000Z",
        },
        savedImages: [],
        datasheets: [],
        categories: [
          { id: MAIN, label: "Spot Lights" },
          { id: TRACK, label: "Magnetic Track" },
        ],
        areas: [{ id: AREA, label: "Office <b>" }],
        magneticTrackIds: magnetic,
        publishProblems: problems,
      }),
    );

  it("lists the publish reasons as links to their sections", () => {
    const html = render(
      stored,
      [],
      [
        { field: "variants", message: "Add at least one variant (model no.)" },
        { field: "images", message: "Add at least one image" },
      ],
    );
    expect(html).toContain('href="#product-section-variants"');
    expect(html).toContain('href="#product-section-images"');
    expect(html).toContain('id="product-section-variants"');
  });

  it("renders the datasheet picker with a label, none selected and the stored files", () => {
    const html = renderToStaticMarkup(
      createElement(ProductEditForm, {
        product: {
          id: P,
          status: "draft",
          values: { ...stored, datasheetId: "sheet2" },
          updatedAt: "2026-10-06T12:00:00.000Z",
        },
        savedImages: [],
        datasheets: [
          { id: "sheet1", label: "Arc <family>.xlsx" },
          { id: "sheet2", label: "Spot.xlsx" },
        ],
        categories: [{ id: MAIN, label: "Spot Lights" }],
        areas: [],
        magneticTrackIds: [],
        publishProblems: [],
      }),
    );
    expect(html).toContain('for="product-datasheetId"');
    expect(html).toContain('id="product-datasheetId"');
    expect(html).toContain("Arc &lt;family&gt;.xlsx");
    expect(html).toMatch(/<option value="sheet2" selected/);
    expect(html).toContain("Datasheet coming soon");
    // Never a storage key or a URL.
    expect(html).not.toMatch(/datasheets\/|incoming\/|r2\./);
  });

  it("shows a stored datasheet id that no longer exists, so it can be detached", () => {
    const html = renderToStaticMarkup(
      createElement(ProductEditForm, {
        product: {
          id: P,
          status: "draft",
          values: { ...stored, datasheetId: "gone" },
          updatedAt: "2026-10-06T12:00:00.000Z",
        },
        savedImages: [],
        datasheets: [],
        categories: [{ id: MAIN, label: "Spot Lights" }],
        areas: [],
        magneticTrackIds: [],
        publishProblems: [],
      }),
    );
    expect(html).toContain("This datasheet no longer exists");
  });

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

  it("escapes labels and shows the variants in their editor", () => {
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

// ---------------------------------------------------------------------------
// T10b: specs, variants, extra specs and public files
// ---------------------------------------------------------------------------

/* A product with every section (b) field filled, as getProductForEdit sends it. */
const full: ProductFormValues = {
  ...stored,
  specs: {
    cct: ["3000K", "4000K"],
    driver: ["Lifud"],
    voltageInput: ["100-240V, 50/60Hz"],
  },
  variants: [
    {
      modelNo: "AR-013A1",
      label: "Lens",
      specs: { beamAngle: ["24°", "36°"] },
      imagePublicId: testPublicId(1),
    },
    { modelNo: "AR-013A2", label: "", specs: {}, imagePublicId: "" },
  ],
  extraSpecs: [
    { group: "Physical", label: "Weight", value: "0.4 kg" },
    { group: "", label: "Packing", value: "1 pc / box" },
  ],
  publicFiles: [
    { label: "IES", url: "https://example.com/a.ies" },
    { label: "Guide", url: "https://example.com/guide.pdf" },
  ],
};

describe("section (b) form state", () => {
  it("holds specs as one text per key, one option per line", () => {
    const state = toFormState(full);
    expect(Object.keys(state.specs)).toEqual([...SPEC_KEYS]);
    expect(state.specs.cct).toBe("3000K\n4000K");
    expect(state.specs.voltageInput).toBe("100-240V, 50/60Hz");
    expect(state.specs.lens).toBe("");
    // A variant holds only the keys that differ.
    expect(state.variants[0]?.specs).toEqual({ beamAngle: "24°\n36°" });
    expect(state.variants[1]?.specs).toEqual({});
  });

  it("round-trips specs, variants, extra specs and public files in order", () => {
    const { status, ...rest } = full;
    expect(status).toBe("draft");
    expect(toProductInput(toFormState(full), NO_MAGNETIC)).toEqual({
      ...rest,
      productNo: 76,
      filters: { cctK: [3000, 4000] },
    });
    // And the server parses both to the same product.
    expect(
      productInputSchema.parse(toProductInput(toFormState(full), NO_MAGNETIC)),
    ).toEqual(productInputSchema.parse(full));
  });

  it("splits lines (incl. Windows line ends), trims and drops blanks", () => {
    expect(textToOptions("a\r\nb\n\n  c  \n")).toEqual(["a", "b", "c"]);
    expect(textToOptions("   ")).toEqual([]);
    // Emptied keys are left out, so "no changes" still compares equal.
    expect(textsToSpecs({ cct: "", lens: " \n ", cri: "80\n90" })).toEqual({
      cri: ["80", "90"],
    });
  });

  it("sends a new variant's added-but-empty spec as nothing", () => {
    const state = toFormState(full);
    state.variants.push({
      ...EMPTY_VARIANT,
      modelNo: "AR-013A3",
      specs: { cct: "" },
    });
    expect(toProductInput(state, NO_MAGNETIC).variants?.[2]).toEqual({
      modelNo: "AR-013A3",
      label: "",
      specs: {},
      imagePublicId: "",
    });
  });

  it("copies rows field by field, so no stray key reaches the strict schema", () => {
    const state = toFormState(full);
    // e.g. a field-array id that leaked into the values.
    (state.variants[0] as unknown as Record<string, unknown>).id = "x";
    (state.publicFiles[0] as unknown as Record<string, unknown>).id = "y";
    const input = toProductInput(state, NO_MAGNETIC);
    expect(input.variants?.[0]).not.toHaveProperty("id");
    expect(input.publicFiles?.[0]).not.toHaveProperty("id");
    expect(productInputSchema.safeParse(input).success).toBe(true);
  });

  it("treats an unedited form as unchanged", () => {
    const parse = (
      values: ProductFormValues | ReturnType<typeof toProductInput>,
    ) => productInputSchema.parse(values);
    expect(
      sameParsedInput(
        parse(toProductInput(toFormState(full), NO_MAGNETIC)),
        parse(full),
      ),
    ).toBe(true);
  });
});

describe("SPEC_GROUPS", () => {
  it("covers all 28 spec columns once, in sheet order", () => {
    const keys = SPEC_GROUPS.flatMap((group) =>
      group.columns.map((column) => column.key),
    );
    expect(keys).toEqual([...SPEC_KEYS]);
    expect(SPEC_GROUPS.map((group) => group.title)).toEqual([
      "Identification",
      "Housing and optics",
      "Size and mounting",
      "Light source",
      "Electrical and output",
      "Lifetime and protection",
    ]);
  });

  it("marks exactly the default-restricted columns", () => {
    const restricted = SPEC_GROUPS.flatMap((group) =>
      group.columns.filter((c) => c.restrictedByDefault).map((c) => c.key),
    );
    expect(restricted).toEqual([...DEFAULT_RESTRICTED_SPEC_KEYS]);
    expect(restricted).toEqual([
      "batchNo",
      "chipType",
      "holder",
      "chipEfficiency",
      "driver",
    ]);
  });
});

describe("section (b) error mapping", () => {
  const rows: RenderedRows = toFormState(full);
  const rowsWithSpec: RenderedRows = {
    ...rows,
    variants: rows.variants.map((variant, index) =>
      index === 1 ? { ...variant, specs: { cct: "" } } : variant,
    ),
  };

  it.each([
    ["specs.cct", true],
    ["specs.driver", true],
    ["variants", true],
    ["variants.root", true],
    ["extraSpecs.root", true],
    ["publicFiles", true],
    ["variants.0.modelNo", true],
    ["variants.1.label", true],
    ["variants.1.imagePublicId", true],
    ["variants.0.specs.beamAngle", true],
    ["variants.0.specs.cct", false],
    ["variants.2.modelNo", false],
    ["variants.0", false],
    ["variants.0.nope", false],
    ["extraSpecs.1.group", true],
    ["extraSpecs.1.value", true],
    ["extraSpecs.2.label", false],
    ["extraSpecs.0.specs.cct", false],
    ["publicFiles.1.url", true],
    ["publicFiles.0.group", false],
    ["images", false],
    ["status", false],
  ])("%s rendered: %s", (field, expected) => {
    expect(isRenderedField(field, { trackSize: false }, rows)).toBe(expected);
  });

  it("counts a variant's spec difference only while its input is shown", () => {
    expect(
      isRenderedField("variants.1.specs.cct", { trackSize: false }, rows),
    ).toBe(false);
    expect(
      isRenderedField(
        "variants.1.specs.cct",
        { trackSize: false },
        rowsWithSpec,
      ),
    ).toBe(true);
    // Without rows (e.g. rows changed during a save), no row is rendered.
    expect(isRenderedField("variants.0.modelNo", { trackSize: false })).toBe(
      false,
    );
  });

  it.each([
    ["extraSpecs.0.value", "extraSpecs.0.value"],
    ["extraSpecs.0.group", "extraSpecs.0.group"],
    ["publicFiles.3.label", "publicFiles.3.label"],
    ["variants.0.imagePublicId", "variants.0.imagePublicId"],
    ["variants.0.label", "variants.0.label"],
    ["extraSpecs", "extraSpecs"],
    ["extraSpecs.0.url", null],
    ["publicFiles.0.value", null],
    ["specs.driver.4", "specs.driver"],
  ])("formFieldForPath %s -> %s", (path, field) => {
    expect(formFieldForPath(path)).toBe(field);
  });

  it("keeps list-level errors in RHF's root slot", () => {
    expect(errorPath("variants")).toBe("variants.root");
    expect(errorPath("extraSpecs")).toBe("extraSpecs.root");
    expect(errorPath("publicFiles")).toBe("publicFiles.root");
    expect(errorPath("variants.0.modelNo")).toBe("variants.0.modelNo");
    expect(errorPath("specs.cct")).toBe("specs.cct");
    expect(describeField("variants.root")).toBe("Variants");
    expect(describeField("extraSpecs.1.value")).toBe("Extra spec 2, value");
  });

  it("puts server row errors on their rows and a list error in its slot", () => {
    const setError = vi.fn();
    const { formMessages, focusedField } = applyServerErrors(
      { setError },
      {
        formErrors: [],
        fieldErrors: {
          "variants.1.modelNo": [
            "This model no. already belongs to another product",
          ],
          // invalidInput flattens nested Zod paths to the list name.
          publicFiles: ["Enter a full https:// link"],
          "variants.7.modelNo": ["Gone"],
        },
      },
      (field) => isRenderedField(field, { trackSize: false }, rows),
    );
    expect(setError).toHaveBeenNthCalledWith(
      1,
      "variants.1.modelNo",
      {
        type: "server",
        message: "This model no. already belongs to another product",
      },
      { shouldFocus: true },
    );
    expect(setError).toHaveBeenNthCalledWith(
      2,
      "publicFiles.root",
      { type: "server", message: "Enter a full https:// link" },
      { shouldFocus: false },
    );
    // A row that no longer exists goes to the alert, labelled.
    expect(formMessages).toEqual(["Variant 8, model no.: Gone"]);
    expect(focusedField).toBe(true);
  });

  const resolve = (values: ProductEditValues) =>
    productEditResolver(NO_MAGNETIC)(values, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });

  it("flags a bad link, an empty extra spec and a long spec on their inputs", async () => {
    const state = toFormState(full);
    state.publicFiles[1] = { label: "Guide", url: "http://example.com/x" };
    state.extraSpecs[0] = { group: "", label: "", value: "1" };
    state.specs.lens = "x".repeat(501);
    state.variants[0]!.specs.beamAngle = "y".repeat(501);
    const flat = flattenFormErrors((await resolve(state)).errors);
    expect(flat).toEqual(
      expect.arrayContaining([
        { field: "specs.lens", message: "At most 500 characters" },
        {
          field: "variants.0.specs.beamAngle",
          message: "At most 500 characters",
        },
        { field: "extraSpecs.0.label", message: "Enter a label" },
        { field: "publicFiles.1.url", message: "Enter a full https:// link" },
      ]),
    );
    expect(flat).toHaveLength(4);
  });

  it("keeps a list-level error and a row error side by side", async () => {
    const state = toFormState(full);
    state.variants = Array.from({ length: MAX_VARIANTS + 1 }, (_, index) => ({
      ...EMPTY_VARIANT,
      modelNo: index === 5 ? "M-0" : `M-${index}`,
    }));
    // Both survive: the list message in `variants.root`, the row's on row 6.
    const flat = flattenFormErrors((await resolve(state)).errors);
    expect(flat).toEqual(
      expect.arrayContaining([
        { field: "variants.root", message: `At most ${MAX_VARIANTS} variants` },
        {
          field: "variants.5.modelNo",
          message: "This model no. is already used by another variant",
        },
      ]),
    );
    expect(flat).toHaveLength(2);
    // Under the cap only the row error is left.
    state.variants = state.variants.slice(0, MAX_VARIANTS);
    expect(flattenFormErrors((await resolve(state)).errors)).toEqual([
      {
        field: "variants.5.modelNo",
        message: "This model no. is already used by another variant",
      },
    ]);
  });
});

describe("indexAfterRemove", () => {
  it.each([
    [0, 3, 0],
    [1, 3, 1],
    [2, 3, 1],
    [0, 1, null],
  ])("removing %i of %i focuses %s", (index, count, next) => {
    expect(indexAfterRemove(index, count)).toBe(next);
  });
});

describe("section (b) markup", () => {
  const render = (values: ProductFormValues = full) =>
    renderToStaticMarkup(
      createElement(ProductEditForm, {
        product: {
          id: P,
          status: "draft",
          values,
          updatedAt: "2026-10-06T12:00:00.000Z",
        },
        savedImages: [],
        datasheets: [],
        categories: [{ id: MAIN, label: "Spot Lights" }],
        areas: [{ id: AREA, label: "Office" }],
        magneticTrackIds: [],
        publishProblems: [],
      }),
    );

  it("labels every spec input, grouped, with restricted columns marked", () => {
    const html = render();
    for (const key of SPEC_KEYS) {
      expect(html, key).toContain(`for="product-specs-${key}"`);
      expect(html, key).toContain(`id="product-specs-${key}"`);
    }
    expect(html).toContain("<legend");
    expect(html).toContain("Light source");
    // The badge sits inside the Driver label, so it is part of its name.
    expect(html).toMatch(
      /<label[^>]*for="product-specs-driver"[^>]*>Driver <span[^>]*>Restricted by default<\/span><\/label>/,
    );
    expect(html).not.toMatch(
      /<label[^>]*for="product-specs-cct"[^>]*>CCT <span/,
    );
    // One option per line: the stored options come back as lines.
    expect(html).toContain(">3000K\n4000K</textarea>");
  });

  it("makes each row a labelled group with named buttons", () => {
    const html = render();
    for (const [title, prefix] of [
      ["Variant 1", "variant 1"],
      ["Variant 2", "variant 2"],
      ["Extra spec 1", "extra spec 1"],
      ["Extra spec 2", "extra spec 2"],
      ["Public file 1", "public file 1"],
      ["Public file 2", "public file 2"],
    ] as const) {
      const heading = new RegExp(`<h3 id="([^"]+)"[^>]*>${title}</h3>`).exec(
        html,
      );
      expect(heading, title).not.toBeNull();
      expect(html).toContain(`role="group" aria-labelledby="${heading?.[1]}"`);
      for (const name of [
        `Move ${prefix} up`,
        `Move ${prefix} down`,
        `Remove ${prefix}`,
      ]) {
        expect(html, name).toContain(`aria-label="${name}"`);
      }
    }
    // Edge buttons stay focusable but say they are unavailable.
    expect(html).toMatch(
      /aria-label="Move variant 1 up" aria-disabled="true"|aria-disabled="true"[^>]*aria-label="Move variant 1 up"/,
    );
    expect(html).toMatch(
      /aria-label="Move variant 1 down" aria-disabled="false"|aria-disabled="false"[^>]*aria-label="Move variant 1 down"/,
    );
    expect(html).toContain('aria-label="Remove Beam Angle from variant 1"');
    expect(html).toContain('id="product-variants-0-specs-beamAngle"');
    expect(html).toContain('for="product-variants-0-specs-add"');
    expect(html).toContain("Variants (2)");
    expect(html).toContain("Add variant");
    expect(html).toContain("Add extra spec");
    expect(html).toContain("Add public file");
  });

  it("never gives text inputs a name, so a pre-hydration submit leaks nothing", () => {
    const html = render();
    expect(html).not.toMatch(
      /<(input|textarea)[^>]*\sname="(specs|variants|extraSpecs|publicFiles|name|slug)/,
    );
  });

  it("shows the empty state for every list", () => {
    const html = render({
      ...full,
      variants: [],
      extraSpecs: [],
      publicFiles: [],
    });
    expect(html).toContain("No variants yet.");
    expect(html).toContain("No extra specs.");
    expect(html).toContain("No public files.");
  });

  /* The variants editor with RHF errors already set (as after a submit). */
  function Harness({ errors }: { errors: FieldErrors<ProductEditValues> }) {
    const form = useForm<ProductEditValues>({
      defaultValues: toFormState(full),
      errors,
    });
    // Children go in as createElement's third argument (react/no-children-prop).
    return createElement(
      FormProvider<ProductEditValues>,
      form as ComponentProps<typeof FormProvider<ProductEditValues>>,
      createElement(VariantsEditor),
    );
  }

  it("shows a duplicate model no. on its row, tied to the input", () => {
    const html = renderToStaticMarkup(
      createElement(Harness, {
        errors: {
          variants: [
            undefined,
            {
              modelNo: {
                type: "validate",
                message: "This model no. is already used by another variant",
              },
            },
          ],
        } as FieldErrors<ProductEditValues>,
      }),
    );
    // The message is inside the Variant 2 group, after its heading.
    const second = html.slice(html.indexOf(">Variant 2</h3>"));
    expect(second).toContain('id="product-variants-1-modelNo-error"');
    expect(second).toContain(
      "This model no. is already used by another variant",
    );
    const input = /<input[^>]*id="product-variants-1-modelNo"[^>]*>/.exec(
      html,
    )?.[0];
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain(
      'aria-describedby="product-variants-1-modelNo-error"',
    );
    const first = /<input[^>]*id="product-variants-0-modelNo"[^>]*>/.exec(
      html,
    )?.[0];
    expect(first).toContain('aria-invalid="false"');
    expect(first).not.toContain("aria-describedby");
  });

  it("shows a list-level error above the rows", () => {
    const html = renderToStaticMarkup(
      createElement(Harness, {
        errors: {
          variants: {
            root: { type: "server", message: "At most 200 variants" },
          },
        } as FieldErrors<ProductEditValues>,
      }),
    );
    expect(html).toMatch(
      /id="product-variants-error" role="alert"[^>]*>At most 200 variants</,
    );
  });
});
