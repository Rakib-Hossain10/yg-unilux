// Render and helper tests of the import UI (T9): every warning code has a
// label, warning states render (fatal refusal, blocked product, file-level
// unknown area with the template hint, removals needing confirmation), the
// diff marks restricted columns and "+N more", and the pure helpers (filters,
// paging, batches to send, the client form schema).

import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  unstable_rethrow: vi.fn(),
}));
vi.mock("@/app/admin/import/actions", () => ({
  presignImportUploadAction: vi.fn(),
  previewImportAction: vi.fn(),
  commitImportBatchAction: vi.fn(),
  finishImportAction: vi.fn(),
}));

import { IMPORT_BATCH_SIZE, XLSX_MIME_TYPE } from "@/lib/constants";
import {
  importWarning,
  WARNING_CODES,
  type ImportWarning,
  type WarningCode,
} from "@/lib/import/types";

import { importFormSchema } from "./import-form";
import {
  IMPORT_TEMPLATE_URL,
  rowsText,
  WARNING_LABELS,
  warningPlace,
} from "./import-labels";
import {
  ImportPreviewStep,
  PlanSummary,
  RefusedFile,
} from "./import-preview-step";
import { EntryDetails, ImportProductsTable } from "./import-products-table";
import { ImportUploadStep } from "./import-upload-step";
import {
  allWarnings,
  batchesToSend,
  batchTotal,
  filterEntries,
  filterWarnings,
  isRestrictedChange,
  pageOf,
  warningCodeCounts,
  type PlanView,
  type PreviewEntryView,
} from "./import-view";
import { ImportWarnings } from "./import-warnings";
import { WarningItem } from "./warning-item";
import { initialResults } from "./use-import-commit";
import { CommitResults } from "./import-commit-step";

const HASH = "a".repeat(64);

function entry(over: Partial<PreviewEntryView> = {}): PreviewEntryView {
  return {
    index: 0,
    status: "create",
    sheet: "Products",
    rows: [2, 3],
    productNo: 76,
    family: "Arc",
    name: "Arc AR-013A",
    existingId: null,
    slug: "arc-ar-013a",
    modelNos: ["AR-013A1", "AR-013A2"],
    variantCount: 2,
    newImageCount: 1,
    variantsRemoved: [],
    changes: [],
    moreChanges: 0,
    warnings: [],
    hash: HASH,
    ...over,
  };
}

function plan(
  entries: PreviewEntryView[],
  over: Partial<PlanView> = {},
): PlanView {
  const count = (s: PreviewEntryView["status"]) =>
    entries.filter((e) => e.status === s).length;
  return {
    kind: "plan",
    etag: '"e"',
    planHash: HASH,
    fileWarnings: [],
    entries,
    summary: {
      create: count("create"),
      update: count("update"),
      unchanged: count("unchanged"),
      blocked: count("blocked"),
      variantsRemoved: entries.reduce(
        (n, e) => n + e.variantsRemoved.length,
        0,
      ),
      imagesToAdd: entries.reduce((n, e) => n + e.newImageCount, 0),
    },
    ...over,
  };
}

function render<P extends object>(type: FunctionComponent<P>, props: P) {
  return renderToStaticMarkup(createElement(type, props));
}

describe("warning labels", () => {
  const codes = Object.keys(WARNING_CODES) as WarningCode[];

  it.each(codes)("%s has a title", (code) => {
    expect(WARNING_LABELS[code].title.length).toBeGreaterThan(0);
  });

  it("uses the agreed wording for the gate notes", () => {
    expect(WARNING_LABELS.too_many_products.title).toBe("Too many products");
    expect(WARNING_LABELS.sheet_too_complex.title).toBe(
      "Sheet too complex: too many merged cells",
    );
    expect(WARNING_LABELS.image_too_large.title).toBe(
      "Picture too large (over 10 MB / 25 MP)",
    );
    expect(WARNING_LABELS.image_not_on_row.title).toBe(
      "Picture not on a product row",
    );
    expect(WARNING_LABELS.unsupported_image.title).toBe(
      "Picture can't be used",
    );
    expect(WARNING_LABELS.unsupported_image_store.title).toBe(
      "Pictures stored in cells (not imported)",
    );
    expect(WARNING_LABELS.missing_image.title).toBe("No picture");
    expect(WARNING_LABELS.unknown_area.hint).toMatch(/fresh template/);
    expect(WARNING_LABELS.unknown_category.hint).toMatch(/fresh template/);
    expect(WARNING_LABELS.variant_removed.hint).toMatch(/confirm/);
  });

  it("places a finding in the sheet", () => {
    expect(warningPlace(importWarning("not_xlsx", { sheet: null }))).toBe(
      "Whole file",
    );
    expect(
      warningPlace(
        importWarning("missing_spec", {
          sheet: "Products",
          row: 12,
          column: "cct",
        }),
      ),
    ).toBe("Sheet Products, row 12, column CCT");
    expect(rowsText([4])).toBe("Row 4");
    expect(rowsText([4, 5, 6])).toBe("Rows 4–6");
    expect(rowsText([4, 9])).toBe("Rows 4, 9");
  });
});

describe("warning states", () => {
  it("a file-level unknown area shows its detail, the hint and a template link", () => {
    const warning = importWarning("unknown_area", {
      sheet: "Products",
      row: 1,
      column: "areaFlag",
      detail: 'The column "Area: Marine" matches no area.',
    });
    const html = render(WarningItem, { warning });
    expect(html).toContain("Area not found");
    expect(html).toContain("Area: Marine");
    expect(html).toContain("fresh template");
    expect(html).toContain(`href="${IMPORT_TEMPLATE_URL}"`);
    expect(html).toContain("Warning");
  });

  it("a refused file lists the fatal findings and offers another file", () => {
    const html = render(RefusedFile, {
      warnings: [
        importWarning("sheet_too_complex", { sheet: null, detail: "Unmerge." }),
        importWarning("too_many_products", { sheet: null }),
      ],
      onStartOver: () => {},
    });
    expect(html).toContain("This file can&#x27;t be imported");
    expect(html).toContain("Sheet too complex: too many merged cells");
    expect(html).toContain("Too many products");
    expect(html).toContain("File refused");
    expect(html).toContain("Choose another file");
  });

  it("an invalid area flag and a blocked product's error render with their labels", () => {
    const html = render(ImportWarnings, {
      rows: [
        {
          warning: importWarning("invalid_area_flag", {
            sheet: "Products",
            row: 5,
          }),
          product: "Arc AR-013A",
        },
        {
          warning: importWarning("model_no_conflict", {
            sheet: "Products",
            row: 6,
          }),
          product: "Arc AR-020",
        },
      ],
    });
    expect(html).toContain("Area cell is not Yes or No");
    expect(html).toContain("Model No. belongs to another product");
    expect(html).toContain("Blocks the product");
    expect(html).toContain("Arc AR-020 · Sheet Products, row 6");
  });

  it("no warnings renders the empty state", () => {
    expect(render(ImportWarnings, { rows: [] })).toContain("No warnings");
  });

  it("the preview asks to confirm removals and counts what will be saved", () => {
    const html = render(ImportPreviewStep, {
      fileName: "products.xlsx",
      plan: plan([
        entry({ index: 0 }),
        entry({
          index: 1,
          status: "update",
          existingId: "0123456789abcdef01234567",
          variantsRemoved: ["AR-9"],
          warnings: [
            importWarning("variant_removed", { sheet: "Products", row: 9 }),
          ],
        }),
        entry({
          index: 2,
          status: "blocked",
          warnings: [
            importWarning("duplicate_product_no", {
              sheet: "Products",
              row: 7,
            }),
          ],
        }),
      ]),
      restrictedColumns: [],
      onSave: () => {},
      onStartOver: () => {},
    });
    expect(html).toContain("Save 2 products");
    expect(html).toContain("Remove 1 variant that is not in the sheet");
    expect(html).toContain("1 blocked product will be skipped");
    expect(html).toContain("New");
    expect(html).toContain("Blocked");
    expect(html).toContain("Warnings (2)");
  });

  it("a preview with nothing to save offers no save button", () => {
    const html = render(ImportPreviewStep, {
      fileName: "products.xlsx",
      plan: plan([entry({ status: "unchanged" })]),
      restrictedColumns: [],
      onSave: () => {},
      onStartOver: () => {},
    });
    expect(html).toContain("There is nothing to save");
    expect(html).not.toContain("Save 1 product");
  });

  it("file-level findings are shown above the table", () => {
    const html = render(ImportPreviewStep, {
      fileName: "products.xlsx",
      plan: plan([entry()], {
        fileWarnings: [importWarning("hidden_sheet", { sheet: "Old" })],
      }),
      restrictedColumns: [],
      onSave: () => {},
      onStartOver: () => {},
    });
    expect(html).toContain("About the file");
    expect(html).toContain("Hidden sheet");
  });

  it("the summary shows each count", () => {
    const html = render(PlanSummary, {
      plan: plan([entry(), entry({ index: 1 })]),
    });
    expect(html).toContain("New products");
    expect(html).toContain(">2<");
  });
});

describe("the diff", () => {
  const restricted = new Set(["driver"]);

  it("marks restricted columns, shows not set and +N more", () => {
    const html = render(EntryDetails, {
      entry: entry({
        status: "update",
        changes: [
          {
            field: "specs.driver",
            label: "Driver",
            before: null,
            after: "Lifud",
          },
          {
            field: "variants.AR-013A1.specs.cct",
            label: "AR-013A1 · CCT",
            before: "3000K",
            after: "4000K",
          },
        ],
        moreChanges: 3,
        variantsRemoved: ["AR-013A3"],
      }),
      restricted,
    });
    expect(html).toContain("Driver");
    expect(html).toContain("Restricted");
    expect(html.match(/Restricted/g)).toHaveLength(1);
    expect(html).toContain("not set");
    expect(html).toContain("+3 more changes");
    expect(html).toContain("AR-013A3");
  });

  it("isRestrictedChange reads product and variant spec paths only", () => {
    const c = (field: string) => ({
      field,
      label: "",
      before: null,
      after: null,
    });
    expect(isRestrictedChange(c("specs.driver"), restricted)).toBe(true);
    expect(isRestrictedChange(c("variants.X-1.specs.driver"), restricted)).toBe(
      true,
    );
    expect(isRestrictedChange(c("specs.cct"), restricted)).toBe(false);
    expect(isRestrictedChange(c("family"), restricted)).toBe(false);
  });

  it("the table renders a row per product with its status", () => {
    const html = render(ImportProductsTable, {
      entries: [
        entry(),
        entry({ index: 1, status: "blocked", name: "Broken" }),
      ],
      restrictedColumns: [],
    });
    expect(html).toContain('data-status="create"');
    expect(html).toContain('data-status="blocked"');
    expect(html).toContain("Rows 2–3");
    expect(html).toContain('aria-expanded="false"');
  });
});

describe("helpers", () => {
  it("filters products by status and by name, family, NO. or model no.", () => {
    const rows = [
      entry({ index: 0 }),
      entry({
        index: 1,
        status: "blocked",
        name: "Line X",
        family: "Line",
        productNo: 9,
        modelNos: ["LN-1"],
      }),
    ];
    expect(filterEntries(rows, { status: "blocked", q: "" })).toHaveLength(1);
    expect(filterEntries(rows, { status: "all", q: "ln-1" })[0]?.index).toBe(1);
    expect(filterEntries(rows, { status: "all", q: "9" })[0]?.index).toBe(1);
    expect(filterEntries(rows, { status: "all", q: "arc" })[0]?.index).toBe(0);
  });

  it("filters warnings by severity and code and counts codes", () => {
    const p = plan(
      [
        entry({
          warnings: [
            importWarning("missing_image", { sheet: "P", row: 2 }),
            importWarning("model_no_conflict", { sheet: "P", row: 2 }),
          ],
        }),
      ],
      { fileWarnings: [importWarning("hidden_sheet", { sheet: "Old" })] },
    );
    const rows = allWarnings(p);
    expect(rows[0]?.product).toBeNull();
    expect(
      filterWarnings(rows, { severity: "error", code: "all" }),
    ).toHaveLength(1);
    expect(
      filterWarnings(rows, { severity: "all", code: "missing_image" }),
    ).toHaveLength(1);
    expect(warningCodeCounts(rows)).toHaveLength(3);
  });

  it("pages rows and clamps the page", () => {
    const rows = Array.from({ length: 120 }, (_, i) => i);
    expect(pageOf(rows, 1).rows).toHaveLength(50);
    expect(pageOf(rows, 3).rows).toHaveLength(20);
    expect(pageOf(rows, 99).page).toBe(3);
    expect(pageOf([], 1).pageCount).toBe(1);
  });

  it("sends only batches that write something", () => {
    const entries = Array.from({ length: IMPORT_BATCH_SIZE * 3 }, (_, i) =>
      entry({
        index: i,
        status: i >= IMPORT_BATCH_SIZE * 2 ? "update" : "unchanged",
      }),
    );
    entries[0] = entry({ index: 0, status: "create" });
    expect(batchTotal(entries.length)).toBe(3);
    expect(batchesToSend(entries)).toEqual([0, 2]);
  });

  it("starts the results from the preview (blocked and unchanged known)", () => {
    const results = initialResults(
      plan([
        entry({ index: 0, status: "blocked" }),
        entry({
          index: 1,
          status: "unchanged",
          existingId: "0123456789abcdef01234567",
        }),
      ]),
    );
    expect(results.map((r) => r.status)).toEqual(["blocked", "unchanged"]);
    expect(results[1]?.id).toBe("0123456789abcdef01234567");
  });

  it("renders results with edit links and failure text", () => {
    const html = render(CommitResults, {
      results: [
        {
          index: 0,
          sheet: "P",
          rows: [2],
          productNo: 1,
          name: "A",
          status: "created",
          id: "0123456789abcdef01234567",
          slug: "a",
        },
        {
          index: 1,
          sheet: "P",
          rows: [3],
          productNo: 2,
          name: "B",
          status: "failed",
          id: null,
          slug: null,
          error: "It could not be saved.",
        },
      ],
    });
    // Failures first: the filter starts on "Failed".
    expect(html).toContain("It could not be saved.");
    expect(html).not.toContain("/admin/products/0123456789abcdef01234567");
  });
});

describe("step 1", () => {
  const file = (name: string, size: number, type = XLSX_MIME_TYPE) =>
    new File([new Uint8Array(size)], name, { type });
  const CATEGORY = "0123456789abcdef01234567";

  it("accepts an .xlsx and a category with the server's own schemas", () => {
    expect(
      importFormSchema.safeParse({
        file: file("p.xlsx", 10),
        defaultCategoryId: CATEGORY,
      }).success,
    ).toBe(true);
    expect(
      importFormSchema.safeParse({
        file: file("p.xlsx", 10, ""),
        defaultCategoryId: CATEGORY,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["no file", null, CATEGORY, "Choose an Excel file"],
    ["a .csv", file("p.csv", 10, "text/csv"), CATEGORY, "Excel .xlsx"],
    ["an empty file", file("p.xlsx", 0), CATEGORY, "empty"],
    ["no category", file("p.xlsx", 10), "", "Choose a default category"],
  ])("refuses %s", (_name, value, category, message) => {
    const result = importFormSchema.safeParse({
      file: value,
      defaultCategoryId: category,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(message);
  });

  it("renders the template link, labelled inputs and the submit button", () => {
    const html = render(ImportUploadStep, {
      categories: [{ id: CATEGORY, label: "Spot Lights" }],
      onPreviewed: () => {},
    });
    expect(html).toContain(`href="${IMPORT_TEMPLATE_URL}"`);
    expect(html).toContain("Download template");
    expect(html).toContain('for="import-file"');
    expect(html).toContain('accept=".xlsx,');
    expect(html).toContain("Default category");
    expect(html).toContain("Upload and preview");
  });

  it("shows errors carried over from a later step", () => {
    const html = render(ImportUploadStep, {
      categories: [{ id: CATEGORY, label: "Spot Lights" }],
      initialErrors: ["This category no longer exists."],
      onPreviewed: () => {},
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("This category no longer exists.");
  });
});

// Keep the fixture type honest: a warning built by hand matches the pipeline's.
const _typed: ImportWarning = importWarning("missing_image", { sheet: "P" });
void _typed;
