// Types shared by the bulk import pipeline (Phase 3): the raw sheet row the
// reader produces and the warning every stage reports. Pure: no runtime
// imports beyond the spec keys, so the admin UI can import it too.

import type { SpecKey } from "@/models/spec-columns";

/** The five sheet columns that are not specs (CLAUDE.md "Sheet columns"). */
export type IdentityKey = "productNo" | "family" | "type" | "modelNo" | "image";

/** Optional template columns the client may add (Phase 3 decision 2). */
export type TemplateKey = "category" | "extraCategories" | "areas";

/** Every column the importer understands. */
export type ColumnKey = IdentityKey | SpecKey | TemplateKey;

/**
 * One data row as read from the sheet, before any cleaning. `cells` holds the
 * raw text of each recognised column; a missing key means the cell was blank.
 * `row` is the Excel row number (1-based, as the admin sees it in Excel).
 */
export interface SheetRow {
  sheet: string;
  row: number;
  hidden: boolean;
  cells: Partial<Record<ColumnKey, string>>;
}

/**
 * fatal = the whole file is refused, nothing is previewed;
 * error = that product is blocked, the rest imports;
 * warning = shown in the preview, does not block.
 */
export type WarningSeverity = "fatal" | "error" | "warning";

/** Every warning code the pipeline can report (plan "Warnings" + T2 reader). */
export const WARNING_CODES = {
  // fatal (whole file)
  not_xlsx: "fatal",
  too_large: "fatal",
  zip_unsafe: "fatal",
  no_header: "fatal",
  missing_required_column: "fatal",
  // error (blocks that product)
  invalid_product_no: "error",
  invalid_model_no: "error",
  orphan_row: "error",
  missing_model_no: "error",
  duplicate_model_no: "error",
  model_no_conflict: "error",
  // warning (shown, does not block)
  missing_image: "warning",
  missing_spec: "warning",
  unparsed_filter_value: "warning",
  cjk_only_cell: "warning",
  unknown_column: "warning",
  unknown_category: "warning",
  unknown_area: "warning",
  unsupported_image: "warning",
  unsupported_image_store: "warning",
  value_truncated: "warning",
  family_mismatch: "warning",
  variant_removed: "warning",
  // reader (T2)
  duplicate_column: "warning",
  sheet_skipped: "warning",
  hidden_sheet: "warning",
  hidden_row: "warning",
  date_cell: "warning",
  formula_without_result: "warning",
  cell_error: "warning",
} as const satisfies Record<string, WarningSeverity>;

export type WarningCode = keyof typeof WARNING_CODES;

/**
 * One finding, shown in the preview. `sheet` is null for findings about the
 * whole file (e.g. not an .xlsx). `row` is the Excel row number, `column`
 * the column key where one applies; `detail` is plain English for the admin.
 */
export interface ImportWarning {
  code: WarningCode;
  severity: WarningSeverity;
  sheet: string | null;
  row?: number;
  column?: ColumnKey;
  detail?: string;
}

/** Builds a warning with the severity that belongs to its code. */
export function importWarning(
  code: WarningCode,
  where: Omit<ImportWarning, "code" | "severity">,
): ImportWarning {
  return { code, severity: WARNING_CODES[code], ...where };
}
