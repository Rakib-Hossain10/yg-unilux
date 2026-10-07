// Types shared by the bulk import pipeline (Phase 3): the raw sheet row, the
// grouped product, the plan (T7) and the warning every stage reports. Pure:
// type-only imports and plain constants, so the admin UI can import it too.

import type { ProductFilters } from "@/models/product";
import type { ProductStatus, TrackSize } from "@/models/product-constants";
import type { SpecKey, SpecValues } from "@/models/spec-columns";

/** The five sheet columns that are not specs (CLAUDE.md "Sheet columns"). */
export type IdentityKey = "productNo" | "family" | "type" | "modelNo" | "image";

/** Optional template columns the client may add (Phase 3 decision 2). */
export type TemplateKey = "category" | "extraCategories" | "areas" | "areaFlag";

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
  /**
   * The template's `Area: <name>` Yes/No cells with text in them: the area
   * name from the header and the raw cell text, in column order.
   */
  areaFlags?: { name: string; text: string }[];
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
  sheet_too_complex: "fatal",
  no_header: "fatal",
  missing_required_column: "fatal",
  // error (blocks that product)
  invalid_product_no: "error",
  invalid_model_no: "error",
  orphan_row: "error",
  missing_model_no: "error",
  duplicate_model_no: "error",
  duplicate_product_no: "error",
  model_no_conflict: "error",
  // plan (T7): the product cannot be given a URL, or its merged values fail
  // the product checks (e.g. more than MAX_VARIANTS variants)
  no_slug: "error",
  invalid_record: "error",
  // warning (shown, does not block)
  missing_image: "warning",
  missing_spec: "warning",
  unparsed_filter_value: "warning",
  cjk_only_cell: "warning",
  unknown_column: "warning",
  unknown_category: "warning",
  unknown_area: "warning",
  invalid_area_flag: "warning",
  unsupported_image: "warning",
  unsupported_image_store: "warning",
  image_too_large: "warning",
  image_not_on_row: "warning",
  value_truncated: "warning",
  family_mismatch: "warning",
  short_base_model_code: "warning",
  model_no_has_space: "warning",
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

/**
 * One variant of a grouped product: one sheet row with a model no. `specs`
 * holds only the keys whose value differs between the product's rows (an
 * absent key = not applicable for this variant); shared keys live on the
 * product.
 */
export interface ImportVariant {
  modelNo: string;
  /** `modelNoKey(modelNo)`: the case-insensitive match key (ADR 0055). */
  modelNoKey: string;
  /** The optic text that tells variants apart, else the model no. */
  label: string;
  specs: SpecValues;
  sheet: string;
  row: number;
  /**
   * sha256 of this variant's own picture, set only when the product's
   * variant rows carry different pictures (T5); null = use the gallery.
   * Always also in the product's `images`.
   */
  imageSha256: string | null;
}

/** Picture formats the import accepts (sharp's names). */
export type ImportImageFormat = "jpeg" | "png" | "webp";

/**
 * One distinct embedded picture of the file, identified by the sha256 of its
 * bytes (lowercase hex; T8 stores it as `ProductImage.sourceSha256`). Pure
 * metadata: the bytes travel separately (`EmbeddedImage.data` in images.ts),
 * so nothing that is hashed or sent to the browser carries them.
 */
export interface ImportImage {
  sha256: string;
  format: ImportImageFormat;
  width: number;
  height: number;
  /** Size of the picture file in bytes. */
  bytes: number;
}

/** A product's use of a picture: which one, and the first row it sits on. */
export interface ImportImageRef {
  sha256: string;
  sheet: string;
  /** Excel row number of the first anchor of this picture in the product. */
  row: number;
}

/**
 * One product as the sheet describes it (one `NO.`), before matching against
 * the database (T7). Category and area fields carry ids from the lookups;
 * `...FromSheet` says whether a template column supplied them (the plan step
 * only overwrites stored values that came from the sheet).
 */
export interface ImportProduct {
  sheet: string;
  /** Null when the NO. cell was invalid (the product is then blocked). */
  productNo: number | null;
  /** Excel row numbers of every row of the product, in sheet order. */
  rows: number[];
  family: string | null;
  type: string | null;
  baseModelCode: string;
  /** "<Family> <base>", used on create only. */
  name: string;
  /** Candidate slug; T7/T8 make it unique against the DB. May be "". */
  slug: string;
  /** Product-level specs: the same value on every row. */
  specs: SpecValues;
  variants: ImportVariant[];
  /**
   * The product's gallery from the sheet (T5): distinct pictures by sha256,
   * in row order, then column. Empty until `attachImages` runs.
   */
  images: ImportImageRef[];
  mainCategory: string;
  mainCategoryFromSheet: boolean;
  extraCategories: string[];
  extraCategoriesFromSheet: boolean;
  areas: string[];
  areasFromSheet: boolean;
  /** From a Magnetic Track 5/10/20mm category, else null. */
  trackSize: TrackSize | null;
  /** True when any warning has severity "error": nothing is saved. */
  blocked: boolean;
  /** Every warning of the product's rows plus grouping's own. */
  warnings: ImportWarning[];
}

/* ------------------------------------------------------------------------ *
 * The plan (T7): each sheet product matched against the database.
 * ------------------------------------------------------------------------ */

/**
 * create = no saved product owns any of its model nos.; update = exactly one
 * does and the merge changes something; unchanged = the merge changes
 * nothing; blocked = an error (sheet or plan), nothing is saved.
 */
export type PlanStatus = "create" | "update" | "unchanged" | "blocked";

/** One variant as it will be stored after the merge. */
export interface PlanVariant {
  /** As typed in the sheet (the sheet owns the text, ADR 0055). */
  modelNo: string;
  /** Kept from the saved variant when it has one, else the sheet's label. */
  label: string;
  /** Only the values that differ between the product's variants. */
  specs: SpecValues;
  /** Kept from the saved variant; null for a new variant. */
  imagePublicId: string | null;
  /**
   * The sheet picture of a NEW variant (create or added variant); the
   * commit turns it into `imagePublicId`. Null for a saved variant (its
   * picture is admin-owned once set) or when the variants share a picture.
   */
  imageSha256: string | null;
  /** Not on the saved product yet. */
  isNew: boolean;
}

/**
 * The product as it will be stored: the sheet-owned fields after the
 * ownership merge (ADR 0057). `name` and `slug` are written on create only;
 * on update they are the saved values, for display.
 */
export interface PlanTarget {
  name: string;
  slug: string;
  family: string | null;
  type: string | null;
  productNo: number | null;
  modelCode: string;
  specs: SpecValues;
  /** Recomputed; restricted columns' filters already removed. */
  filters: ProductFilters;
  variants: PlanVariant[];
  mainCategory: string;
  extraCategories: string[];
  areas: string[];
  trackSize: TrackSize | null;
}

/** The saved product a sheet product matched. */
export interface PlanExisting {
  id: string;
  slug: string;
  name: string;
  status: ProductStatus;
  /** ISO time; part of the plan hash (a later save changes the hash). */
  updatedAt: string;
}

/** One changed sheet-owned field, for the preview's diff (plain text). */
export interface PlanChange {
  /** Stable path, e.g. "specs.cct" or "variants.AR-013A1.specs.lumenOutput". */
  field: string;
  /** What the admin reads, e.g. "CCT" or "AR-013A1 · Lumen Output". */
  label: string;
  /** Null = not set. */
  before: string | null;
  after: string | null;
}

/** The diff shown per product: the first changes, then "+N more". */
export const MAX_PLAN_CHANGES = 10;

export interface PlanEntry {
  status: PlanStatus;
  sheet: string;
  /** Excel rows of the product, in sheet order. */
  rows: number[];
  productNo: number | null;
  family: string | null;
  /** The saved name on update, else the name a create would use. */
  name: string;
  existing: PlanExisting | null;
  /** Null when blocked. */
  target: PlanTarget | null;
  /** Sheet pictures the product does not hold yet (by `sourceSha256`). */
  imagesToAdd: ImportImageRef[];
  /** Saved variants missing from the sheet (removed only with the ack). */
  variantsRemoved: string[];
  /** At most MAX_PLAN_CHANGES; empty on create, blocked and unchanged. */
  changes: PlanChange[];
  /** How many more changes there are beyond `changes`. */
  moreChanges: number;
  /** The product's sheet warnings plus the plan's own. */
  warnings: ImportWarning[];
}

export interface ImportPlanSummary {
  create: number;
  update: number;
  unchanged: number;
  blocked: number;
  /** Over every create/update entry. */
  variantsRemoved: number;
  imagesToAdd: number;
}

export interface ImportPlan {
  /** In sheet order, one per grouped product. */
  entries: PlanEntry[];
  /** Findings about the file, a sheet, or rows of no product. */
  warnings: ImportWarning[];
  summary: ImportPlanSummary;
  /**
   * sha256 (hex) of the canonical plan. The commit re-plans from the same
   * file and refuses unless it gets the same hash (ADR 0057).
   */
  planHash: string;
}
