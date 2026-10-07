// Plain-English labels of the import preview (T9, ADR 0058): one title per
// warning code (the compiler checks every code has one), a hint where the
// admin can fix it, the plan and commit status names and where a finding
// sits in the sheet. Pure and client-safe. The warning `detail` itself comes
// from the server and is shown as is (it may repeat cell values): it is never
// logged, stored or sent anywhere else.

import type {
  ImportWarning,
  WarningCode,
  WarningSeverity,
} from "@/lib/import/types";
import type { CommittedStatus } from "@/lib/import";
import type { PlanStatus } from "@/lib/import/types";
import { IDENTITY_COLUMNS, TEMPLATE_COLUMNS } from "@/lib/import/columns";
import { SPEC_COLUMNS } from "@/models/spec-columns";

/** Where the admin downloads a fresh template (T10b route). */
export const IMPORT_TEMPLATE_URL = "/api/admin/import/template";

const FRESH_TEMPLATE =
  "Download a fresh template: it lists the current choices.";

export interface WarningLabel {
  /** Short title, e.g. "No picture". */
  title: string;
  /** What to do about it, when there is something to do. */
  hint?: string;
}

export const WARNING_LABELS: Readonly<Record<WarningCode, WarningLabel>> = {
  // fatal: the whole file is refused
  not_xlsx: {
    title: "Not a readable Excel file",
    hint: "Open the file in Excel, save it as an Excel workbook (.xlsx) and upload it again.",
  },
  too_large: {
    title: "File too large",
    hint: "Remove unused sheets or large pictures, or split the products over two files.",
  },
  zip_unsafe: {
    title: "File structure not accepted",
    hint: "Save the file again in Excel as a normal .xlsx workbook and upload it again.",
  },
  sheet_too_complex: {
    title: "Sheet too complex: too many merged cells",
    hint: "Unmerge the cells (the template needs none) and upload it again.",
  },
  no_header: {
    title: "No header row found",
    hint: "Use the template: its first row holds the column names.",
  },
  missing_required_column: {
    title: "Required column missing",
    hint: "The sheet needs the NO. and Model No. columns. Use the template.",
  },
  too_many_products: {
    title: "Too many products",
    hint: "Split the products over smaller files and import them one after another.",
  },
  // error: that product is not saved
  invalid_product_no: {
    title: "NO. is not a whole number",
    hint: "Enter a whole number such as 76 in the NO. column.",
  },
  invalid_model_no: {
    title: "Model No. not accepted",
    hint: "Use letters, digits and dashes only, as in AR-013A1.",
  },
  orphan_row: {
    title: "Row belongs to no product",
    hint: "Give the row a NO., or put it right below the product it belongs to.",
  },
  missing_model_no: {
    title: "Model No. missing",
    hint: "Every row is one variant and needs a Model No.",
  },
  duplicate_model_no: {
    title: "Model No. used twice in the file",
    hint: "Each Model No. may appear on one row only.",
  },
  duplicate_product_no: {
    title: "NO. used for two products",
    hint: "Rows of one product sit together; give a different product its own NO.",
  },
  model_no_conflict: {
    title: "Model No. belongs to another product",
    hint: "A saved product already has this Model No. Fix the sheet, or edit or remove that product first.",
  },
  no_slug: {
    title: "No web address possible",
    hint: "Fill in the Model Name and Model No. with English letters or digits.",
  },
  invalid_record: {
    title: "Product values not accepted",
    hint: "A value is too long or there are too many of something (for example variants). See the detail.",
  },
  // warning: shown, does not block
  missing_image: { title: "No picture" },
  missing_spec: { title: "Spec missing" },
  unparsed_filter_value: {
    title: "Value not usable as a filter",
    hint: "The text is saved, but the catalog filter cannot use it. Write it like 3000K, 90, 36° or 12W.",
  },
  cjk_only_cell: {
    title: "Chinese-only text skipped",
    hint: "Only English is imported. Add the English text above the Chinese.",
  },
  unknown_column: {
    title: "Column not recognised (skipped)",
    hint: "Use the template's column names.",
  },
  unknown_category: {
    title: "Category not found",
    hint: `The product goes to the default category. ${FRESH_TEMPLATE}`,
  },
  unknown_area: {
    title: "Area not found",
    hint: FRESH_TEMPLATE,
  },
  invalid_area_flag: {
    title: "Area cell is not Yes or No",
    hint: "Choose Yes or No from the cell's list.",
  },
  unsupported_image: {
    title: "Picture can't be used",
    hint: "Use a JPG, PNG or WebP picture.",
  },
  unsupported_image_store: {
    title: "Pictures stored in cells (not imported)",
    hint: "Insert pictures as floating pictures over the Image cell, not with Place in Cell.",
  },
  image_too_large: {
    title: "Picture too large (over 10 MB / 25 MP)",
    hint: "Use a smaller picture.",
  },
  image_not_on_row: {
    title: "Picture not on a product row",
    hint: "Place the picture over the Image cell of the product's row.",
  },
  value_truncated: { title: "Value shortened (too long)" },
  family_mismatch: {
    title: "Model Name differs between rows",
    hint: "Rows of one product should share one Model Name.",
  },
  short_base_model_code: {
    title: "Very short base model code",
    hint: "The web address is made from it and is set when the product is created. Check the Model No.",
  },
  model_no_has_space: {
    title: "Model No. contains a space",
    hint: "Check it is typed as intended.",
  },
  variant_removed: {
    title: "Variant will be removed",
    hint: "It is saved but missing from the sheet. It is removed only if you confirm before saving.",
  },
  duplicate_column: {
    title: "Column appears twice (second one skipped)",
  },
  sheet_skipped: { title: "Sheet skipped" },
  hidden_sheet: { title: "Hidden sheet" },
  hidden_row: { title: "Hidden row (still imported)" },
  date_cell: {
    title: "Cell is a date",
    hint: "Excel turned the value into a date. Format the cell as Text and type it again.",
  },
  formula_without_result: {
    title: "Formula without a value",
    hint: "Open and save the file in Excel so formulas get their values.",
  },
  cell_error: { title: "Cell shows an Excel error (skipped)" },
};

export const SEVERITY_LABELS: Readonly<Record<WarningSeverity, string>> = {
  fatal: "File refused",
  error: "Blocks the product",
  warning: "Warning",
};

export const PLAN_STATUS_LABELS: Readonly<Record<PlanStatus, string>> = {
  create: "New",
  update: "Update",
  unchanged: "Unchanged",
  blocked: "Blocked",
};

export const COMMITTED_STATUS_LABELS: Readonly<
  Record<CommittedStatus, string>
> = {
  created: "Created",
  updated: "Updated",
  unchanged: "Unchanged",
  blocked: "Blocked",
  failed: "Failed",
};

/** Badge variant per status: problems stand out, nothing uses raw colours. */
export type StatusBadgeVariant =
  "default" | "secondary" | "outline" | "destructive";

export const PLAN_STATUS_BADGE: Readonly<
  Record<PlanStatus, StatusBadgeVariant>
> = {
  create: "default",
  update: "secondary",
  unchanged: "outline",
  blocked: "destructive",
};

export const COMMITTED_STATUS_BADGE: Readonly<
  Record<CommittedStatus, StatusBadgeVariant>
> = {
  created: "default",
  updated: "secondary",
  unchanged: "outline",
  blocked: "destructive",
  failed: "destructive",
};

const COLUMN_HEADERS: ReadonlyMap<string, string> = new Map<string, string>([
  ...IDENTITY_COLUMNS.map((c) => [c.key, c.header] as const),
  ...TEMPLATE_COLUMNS.map((c) => [c.key, c.header] as const),
  ["areaFlag", "Area"],
  ...SPEC_COLUMNS.map((c) => [c.key, c.header] as const),
]);

/** The sheet header of a column key, e.g. "cct" → "CCT". */
export function columnHeader(column: string): string {
  return COLUMN_HEADERS.get(column) ?? column;
}

/** "Sheet Products, row 12, column CCT", or "Whole file". */
export function warningPlace(warning: ImportWarning): string {
  if (warning.sheet === null) return "Whole file";
  const parts = [`Sheet ${warning.sheet}`];
  if (warning.row !== undefined) parts.push(`row ${warning.row}`);
  if (warning.column !== undefined) {
    parts.push(`column ${columnHeader(warning.column)}`);
  }
  return parts.join(", ");
}

/** "Row 12" or "Rows 12–14" (consecutive) or "Rows 12, 15". */
export function rowsText(rows: readonly number[]): string {
  if (rows.length === 0) return "";
  if (rows.length === 1) return `Row ${rows[0]}`;
  const first = rows[0] as number;
  const last = rows[rows.length - 1] as number;
  const consecutive = rows.every((row, i) => row === first + i);
  return consecutive
    ? `Rows ${first}–${last}`
    : `Rows ${rows.slice(0, 4).join(", ")}${rows.length > 4 ? ", …" : ""}`;
}

/** "1 product" / "3 products". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}
