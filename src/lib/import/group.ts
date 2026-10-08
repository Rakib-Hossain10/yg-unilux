// Grouping (Phase 3 T4): turns cleaned sheet rows into products. One `NO.` =
// one product, each row = one variant; values equal on every row are shared,
// the rest are per variant. Pure: category/area lookups are passed in.
//
// Also derives the base model code, candidate slug, name, variant labels,
// template-column categories/areas, trackSize, and the row errors that block
// a product (orphan row, missing/duplicate model no., duplicate NO.).

import {
  MAX_PRODUCT_NAME_LENGTH,
  MAX_VARIANT_LABEL_LENGTH,
} from "@/lib/constants";
import { slugify } from "@/lib/slug";
import {
  isMagneticTrackCategory,
  modelNoKey,
  trackSizeFromSlug,
  type TrackSize,
} from "@/models/product-constants";
import {
  SPEC_KEYS,
  type SpecKey,
  type SpecValues,
} from "@/models/spec-columns";

import type { CleanedRow } from "./clean";
import { parseFilterNumbers } from "./numbers";
import {
  importWarning,
  type ColumnKey,
  type ImportProduct,
  type ImportVariant,
  type ImportWarning,
} from "./types";

/** One category of the tree, as the plan step loads it (ids as hex strings). */
export interface CategoryLookup {
  id: string;
  name: string;
  slug: string;
  /** Null for a main category. */
  parentId: string | null;
}

/** One area, as the plan step loads it. */
export interface AreaLookup {
  id: string;
  name: string;
  slug: string;
}

/** What grouping needs from the database, loaded once by the caller. */
export interface GroupLookups {
  categories: readonly CategoryLookup[];
  areas: readonly AreaLookup[];
  /** The main category the admin picked in the upload step. */
  defaultCategoryId: string;
  /**
   * The template's `Area: <name>` columns, from the header rows. Optional:
   * with them an unknown area column is reported at its header even when no
   * row says Yes; without them, at the first row that says Yes.
   */
  areaColumns?: readonly AreaColumn[];
}

/** One `Area: <name>` header cell. */
export interface AreaColumn {
  sheet: string;
  /** The header's Excel row number. */
  row: number;
  name: string;
}

export interface GroupResult {
  /** In sheet order. A blocked product is listed, never saved. */
  products: ImportProduct[];
  /** Findings that belong to no product (orphan rows and their cells). */
  warnings: ImportWarning[];
}

/** Specs whose absence gives `missing_spec` (plan "Warnings"). */
export const CHECKED_SPEC_KEYS: readonly SpecKey[] = [
  "cct",
  "cri",
  "beamAngle",
  "wattage",
  "lumenOutput",
];

/* Optic columns: when they differ between variants, they name the variant. */
const OPTIC_KEYS: readonly SpecKey[] = ["lens", "reflector", "diffuser"];

/* A base model code shorter than this is not a useful family code. */
const MIN_BASE_CODE_LENGTH = 3;

/* "Main > Sub"; "›" is how the admin UI prints a path. */
const PATH_SEPARATOR = /\s*[>›]\s*/u;

interface RowGroup {
  sheet: string;
  productNo: number | null;
  rows: CleanedRow[];
}

/**
 * Groups cleaned rows (in sheet order) into products. A row with an empty
 * `NO.` (or the same `NO.` as the row directly above) belongs to the product
 * above it on the same sheet; with no product
 * above, it is an `orphan_row`. A product with any error is `blocked`.
 */
export function groupRows(
  rows: readonly CleanedRow[],
  lookups: GroupLookups,
): GroupResult {
  const groups: RowGroup[] = [];
  const warnings: ImportWarning[] = [];
  let current: RowGroup | null = null;

  for (const row of rows) {
    if (current !== null && current.sheet !== row.sheet) current = null;
    if (row.productNo.status === "continuation") {
      if (current === null) {
        warnings.push(
          importWarning("orphan_row", {
            sheet: row.sheet,
            row: row.row,
            column: "productNo",
            detail:
              "This row has no NO. and no product above it, so it belongs to no product. It is not imported.",
          }),
          ...row.warnings,
        );
      } else {
        current.rows.push(row);
      }
      continue;
    }
    // The template tolerates a NO. typed on every variant row: the same NO.
    // directly below its own product continues it (a later repeat does not).
    if (
      current !== null &&
      row.productNo.status === "ok" &&
      row.productNo.value === current.productNo
    ) {
      current.rows.push(row);
      continue;
    }
    current = {
      sheet: row.sheet,
      productNo: row.productNo.status === "ok" ? row.productNo.value : null,
      rows: [row],
    };
    groups.push(current);
  }

  const unknownFlags = unknownAreaColumns(rows, lookups);
  warnings.push(...unknownFlags.warnings);
  const products = groups.map((group) =>
    buildProduct(group, lookups, unknownFlags.keys),
  );
  flagDuplicateModelNos(products);
  flagDuplicateProductNos(products);
  for (const product of products) {
    product.blocked = product.warnings.some((w) => w.severity === "error");
  }
  return { products, warnings };
}

/*
 * An `Area: <name>` column whose name matches no area (renamed or deleted
 * since the template was downloaded) is one problem with the column, so it
 * is reported once, not on every row that says Yes. Returns the folded names
 * so the per-product pass skips them.
 */
function unknownAreaColumns(
  rows: readonly CleanedRow[],
  lookups: GroupLookups,
): { keys: ReadonlySet<string>; warnings: ImportWarning[] } {
  const keys = new Set<string>();
  const warnings: ImportWarning[] = [];
  const check = (sheet: string, row: number, name: string) => {
    const key = fold(name);
    if (keys.has(key) || findArea(name, lookups.areas) !== undefined) return;
    keys.add(key);
    warnings.push(
      importWarning("unknown_area", {
        sheet,
        row,
        column: "areaFlag",
        detail: `The column "Area: ${name}" matches no area, so it is skipped on every row. Download a fresh template.`,
      }),
    );
  };
  for (const column of lookups.areaColumns ?? []) {
    check(column.sheet, column.row, column.name);
  }
  for (const row of rows) {
    for (const name of row.areaFlags) check(row.sheet, row.row, name);
  }
  return { keys, warnings };
}

function findArea(
  name: string,
  areas: readonly AreaLookup[],
): AreaLookup | undefined {
  const key = fold(name);
  return areas.find((a) => fold(a.name) === key || a.slug === key);
}

function buildProduct(
  group: RowGroup,
  lookups: GroupLookups,
  unknownAreaFlags: ReadonlySet<string>,
): ImportProduct {
  const { sheet, rows } = group;
  const first = rows[0] as CleanedRow;
  const warnings: ImportWarning[] = rows.flatMap((row) => row.warnings);

  const family = identity(rows, "family", warnings);
  const type = identity(rows, "type", warnings);

  for (const row of rows) {
    if (row.modelNo === null) {
      warnings.push(
        importWarning("missing_model_no", {
          sheet,
          row: row.row,
          column: "modelNo",
          detail:
            "Model No. is empty. Every row needs one; this product is not imported.",
        }),
      );
    } else if (/\s/.test(row.modelNo)) {
      warnings.push(
        importWarning("model_no_has_space", {
          sheet,
          row: row.row,
          column: "modelNo",
          detail: `Model No. "${row.modelNo}" contains a space. Check it is one model no., not two.`,
        }),
      );
    }
  }

  // Shared vs per variant is decided over the variant rows; a product with
  // no model no. at all (blocked) still shows its values in the preview.
  const withModelNo = rows.filter(
    (row): row is CleanedRow & { modelNo: string } => row.modelNo !== null,
  );
  const specRows = withModelNo.length > 0 ? withModelNo : rows;
  const { shared, differing } = splitSpecs(specRows);
  const labelKeys = OPTIC_KEYS.filter((key) => differing.has(key));

  const variants: ImportVariant[] = withModelNo.map((row) => {
    const specs: SpecValues = {};
    for (const key of differing) {
      const value = row.specs[key];
      if (value !== undefined) specs[key] = value;
    }
    return {
      modelNo: row.modelNo,
      modelNoKey: modelNoKey(row.modelNo),
      label: variantLabel(row.modelNo, specs, labelKeys),
      specs,
      sheet,
      row: row.row,
      imageSha256: null,
    };
  });
  uniqueLabels(variants);

  const baseModelCode = baseCode(variants, sheet, first.row, warnings);
  const title = [family, baseModelCode].filter((s) => s !== null && s !== "");
  const name = cutCodePoints(title.join(" "), MAX_PRODUCT_NAME_LENGTH);

  checkSpecs(shared, variants, sheet, first.row, warnings);
  const templates = resolveTemplates(rows, lookups, unknownAreaFlags, warnings);

  return {
    sheet,
    productNo: group.productNo,
    rows: rows.map((row) => row.row),
    family,
    type,
    baseModelCode,
    name,
    slug: slugify(title.join(" ")),
    specs: shared,
    variants,
    images: [],
    ...templates,
    blocked: false,
    warnings,
  };
}

/*
 * `family` / `type`: the first row's value (first non-empty one); a later row
 * with a different non-empty value gets `family_mismatch` on its column.
 */
function identity(
  rows: readonly CleanedRow[],
  key: "family" | "type",
  warnings: ImportWarning[],
): string | null {
  const value = rows.find((row) => row[key] !== null)?.[key] ?? null;
  if (value === null) return null;
  for (const row of rows) {
    const own = row[key];
    if (own !== null && own !== value) {
      warnings.push(
        importWarning("family_mismatch", {
          sheet: row.sheet,
          row: row.row,
          column: key,
          detail: `${key === "family" ? "Model Name" : "Model Type"} "${own}" differs from "${value}" on the product's first row; "${value}" is used.`,
        }),
      );
    }
  }
  return value;
}

/*
 * A key is shared when every row has the same cleaned value. "Not applicable"
 * (blank or "-") is an absent key on every row, so it compares equal to
 * itself; options compare in order, element by element.
 */
function splitSpecs(rows: readonly CleanedRow[]): {
  shared: SpecValues;
  differing: Set<SpecKey>;
} {
  const shared: SpecValues = {};
  const differing = new Set<SpecKey>();
  const [first, ...rest] = rows;
  if (first === undefined) return { shared, differing };
  for (const key of SPEC_KEYS) {
    const value = first.specs[key];
    if (rest.every((row) => sameOptions(row.specs[key], value))) {
      if (value !== undefined) shared[key] = value;
    } else {
      differing.add(key);
    }
  }
  return { shared, differing };
}

/*
 * Labels must tell variants apart on the optic switch. Two variants can share
 * an optic ("Regular Lens" at 10W and at 15W): those get " (<model no.>)"
 * appended, cut to the label limit; any label still shared after the cut
 * becomes the model no. itself, which is unique (duplicates are blocked).
 */
function uniqueLabels(variants: ImportVariant[]): void {
  const shared = (list: readonly ImportVariant[]) => {
    const counts = new Map<string, number>();
    for (const v of list) counts.set(v.label, (counts.get(v.label) ?? 0) + 1);
    return list.filter((v) => (counts.get(v.label) ?? 0) > 1);
  };
  for (const v of shared(variants)) {
    if (v.label !== v.modelNo) {
      v.label = cutCodePoints(
        `${v.label} (${v.modelNo})`,
        MAX_VARIANT_LABEL_LENGTH,
      );
    }
  }
  for (const v of shared(variants)) v.label = v.modelNo;
}

/*
 * The variant's own text in the optic columns that differ within the product
 * ("Regular Lens"), joined with ", "; none → the model no.
 */
function variantLabel(
  modelNo: string,
  specs: SpecValues,
  labelKeys: readonly SpecKey[],
): string {
  const parts = labelKeys.flatMap((key) => specs[key] ?? []);
  if (parts.length === 0) return modelNo;
  return cutCodePoints(parts.join(", "), MAX_VARIANT_LABEL_LENGTH);
}

/*
 * The longest common prefix of the variants' model nos (compared without
 * case, taken from the first), trailing "-" and spaces trimmed. One variant
 * → its model no.; a prefix under 3 characters → the first model no. plus
 * `short_base_model_code`. No variant (blocked) → "".
 */
function baseCode(
  variants: readonly ImportVariant[],
  sheet: string,
  row: number,
  warnings: ImportWarning[],
): string {
  const [first, ...rest] = variants;
  if (first === undefined) return "";
  if (rest.length === 0) return first.modelNo;
  const chars = Array.from(first.modelNo);
  let length = chars.length;
  for (const variant of rest) {
    const other = Array.from(variant.modelNo);
    let i = 0;
    while (
      i < length &&
      i < other.length &&
      (chars[i] as string).toLocaleLowerCase("en") ===
        (other[i] as string).toLocaleLowerCase("en")
    ) {
      i += 1;
    }
    length = i;
  }
  while (length > 0 && /[-_./\s]/.test(chars[length - 1] as string))
    length -= 1;
  if (length >= MIN_BASE_CODE_LENGTH) return chars.slice(0, length).join("");
  warnings.push(
    importWarning("short_base_model_code", {
      sheet,
      row,
      column: "modelNo",
      detail: `The variants' model nos. share no common code of ${MIN_BASE_CODE_LENGTH}+ characters, so "${first.modelNo}" is used for the product's slug and name. Check the rows belong to one product.`,
    }),
  );
  return first.modelNo;
}

/*
 * `missing_spec` for the checked keys (one warning when no row has the value,
 * else one per row without it) and `unparsed_filter_value` once per value
 * (shared values on the first row, per-variant ones on their row).
 */
function checkSpecs(
  shared: SpecValues,
  variants: readonly ImportVariant[],
  sheet: string,
  firstRow: number,
  warnings: ImportWarning[],
): void {
  const missing = (row: number, key: SpecKey, detail: string) =>
    warnings.push(
      importWarning("missing_spec", { sheet, row, column: key, detail }),
    );
  for (const key of CHECKED_SPEC_KEYS) {
    if (shared[key] !== undefined) continue;
    const without = variants.filter((v) => v.specs[key] === undefined);
    if (variants.length === 0 || without.length === variants.length) {
      missing(firstRow, key, "This product has no value for this spec.");
    } else {
      for (const variant of without) {
        missing(
          variant.row,
          key,
          `Variant ${variant.modelNo} has no value for this spec.`,
        );
      }
    }
  }
  const parse = (specs: SpecValues, row: number) => {
    for (const key of SPEC_KEYS) {
      const found = parseFilterNumbers(key, specs[key] ?? null, { sheet, row });
      warnings.push(...found.warnings);
    }
  };
  parse(shared, firstRow);
  for (const variant of variants) parse(variant.specs, variant.row);
}

/* ------------------------------------------------------------------------ *
 * Template columns: Category, Extra Categories, Areas.
 * ------------------------------------------------------------------------ */

type Templates = Pick<
  ImportProduct,
  | "mainCategory"
  | "mainCategoryFromSheet"
  | "extraCategories"
  | "extraCategoriesFromSheet"
  | "areas"
  | "areasFromSheet"
  | "trackSize"
>;

const fold = (s: string) =>
  s.toLocaleLowerCase("en").replace(/\s+/g, " ").trim();

/*
 * The product's category is the first row's non-empty Category cell; extra
 * categories and areas are the union of every row's cells. Unknown names
 * get a warning and are dropped (the default category stands in for an
 * unknown main category, and `...FromSheet` stays false).
 */
function resolveTemplates(
  rows: readonly CleanedRow[],
  lookups: GroupLookups,
  unknownAreaFlags: ReadonlySet<string>,
  warnings: ImportWarning[],
): Templates {
  const byId = new Map(lookups.categories.map((c) => [c.id, c]));

  const categoryRow = rows.find((row) => row.category !== null);
  let mainCategory = lookups.defaultCategoryId;
  let mainCategoryFromSheet = false;
  if (categoryRow?.category != null) {
    const found = findCategory(categoryRow.category, lookups.categories);
    if (found.id !== null) {
      mainCategory = found.id;
      mainCategoryFromSheet = true;
    } else {
      warnings.push(
        unknownCategory(
          categoryRow,
          "category",
          categoryRow.category,
          found.ambiguous,
          true,
        ),
      );
    }
  }

  const extraCategories: string[] = [];
  let extraCategoriesFromSheet = false;
  for (const row of rows) {
    for (const name of row.extraCategories) {
      const found = findCategory(name, lookups.categories);
      if (found.id === null) {
        warnings.push(
          unknownCategory(row, "extraCategories", name, found.ambiguous, false),
        );
        continue;
      }
      // Only a kept id counts as "from the sheet": a cell that just repeats
      // the main category must not wipe the admin's stored extras on update.
      if (found.id !== mainCategory && !extraCategories.includes(found.id)) {
        extraCategories.push(found.id);
        extraCategoriesFromSheet = true;
      }
    }
  }

  const areas: string[] = [];
  let areasFromSheet = false;
  for (const row of rows) {
    for (const name of row.areas) {
      const area = findArea(name, lookups.areas);
      if (area === undefined) {
        // An unknown `Area:` column was reported once by groupRows.
        if (row.areaFlags.includes(name) && unknownAreaFlags.has(fold(name))) {
          continue;
        }
        warnings.push(
          importWarning("unknown_area", {
            sheet: row.sheet,
            row: row.row,
            column: "areas",
            detail: `No area is named "${name}"; it is skipped.`,
          }),
        );
        continue;
      }
      areasFromSheet = true;
      if (!areas.includes(area.id)) areas.push(area.id);
    }
  }

  const trackSize = trackSizeOf([mainCategory, ...extraCategories], byId);
  return {
    mainCategory,
    mainCategoryFromSheet,
    extraCategories,
    extraCategoriesFromSheet,
    areas,
    areasFromSheet,
    trackSize,
  };
}

function unknownCategory(
  row: CleanedRow,
  column: ColumnKey,
  name: string,
  ambiguous: boolean,
  main: boolean,
): ImportWarning {
  const reason = ambiguous
    ? `More than one category matches "${name}"; write it as "Main > Sub".`
    : `No category matches "${name}".`;
  const fallback = main ? " The default category is used." : " It is skipped.";
  return importWarning("unknown_category", {
    sheet: row.sheet,
    row: row.row,
    column,
    detail: reason + fallback,
  });
}

/*
 * A Category cell: a slug or a name ("Recessed", any case), or a
 * "Main > Sub" path of names or slugs. A bare name or slug that matches more
 * than one category (slugs are unique per parent only) is ambiguous.
 */
function findCategory(
  text: string,
  categories: readonly CategoryLookup[],
): { id: string | null; ambiguous: boolean } {
  const matches = (c: CategoryLookup, part: string) =>
    fold(c.name) === part || c.slug === part;
  const parts = text.split(PATH_SEPARATOR).map(fold);
  if (parts.some((part) => part === "") || parts.length > 2) {
    return { id: null, ambiguous: false };
  }
  let found: CategoryLookup[];
  if (parts.length === 2) {
    const [mainPart, subPart] = parts as [string, string];
    const mains = categories.filter(
      (c) => c.parentId === null && matches(c, mainPart),
    );
    found = categories.filter(
      (c) =>
        c.parentId !== null &&
        mains.some((m) => m.id === c.parentId) &&
        matches(c, subPart),
    );
  } else {
    found = categories.filter((c) => matches(c, parts[0] as string));
  }
  if (found.length === 1)
    return { id: (found[0] as CategoryLookup).id, ambiguous: false };
  return { id: null, ambiguous: found.length > 1 };
}

/**
 * ADR 0041 + plan: a track size only for a subcategory of Magnetic Track whose
 * slug starts with 5mm / 10mm / 20mm. The main category is checked first.
 * Also used by the plan step on the merged (kept or sheet) categories.
 */
export function trackSizeOf(
  ids: readonly string[],
  byId: ReadonlyMap<string, CategoryLookup>,
): TrackSize | null {
  for (const id of ids) {
    const category = byId.get(id);
    if (category?.parentId == null) continue;
    const parent = byId.get(category.parentId);
    if (parent === undefined || parent.parentId !== null) continue;
    if (!isMagneticTrackCategory(parent)) continue;
    const size = trackSizeFromSlug(category.slug);
    if (size !== null) return size;
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * Checks across products.
 * ------------------------------------------------------------------------ */

/*
 * The same model no. (case-insensitive, ADR 0055) on two rows of the file:
 * every product holding one of them is blocked (`duplicate_model_no` on
 * each row), whether the rows are in one product or two.
 */
function flagDuplicateModelNos(products: ImportProduct[]): void {
  const seen = new Map<
    string,
    { product: ImportProduct; variant: ImportVariant }[]
  >();
  for (const product of products) {
    for (const variant of product.variants) {
      const list = seen.get(variant.modelNoKey) ?? [];
      list.push({ product, variant });
      seen.set(variant.modelNoKey, list);
    }
  }
  for (const list of seen.values()) {
    if (list.length < 2) continue;
    const where = list.map(
      ({ variant }) => `${variant.sheet} row ${variant.row}`,
    );
    for (const { product, variant } of list) {
      product.warnings.push(
        importWarning("duplicate_model_no", {
          sheet: variant.sheet,
          row: variant.row,
          column: "modelNo",
          detail: `Model No. "${variant.modelNo}" appears more than once in the file (${where.join(", ")}; case is ignored). The products involved are not imported.`,
        }),
      );
    }
  }
}

/*
 * The same NO. twice on one sheet: both products are blocked. NO. is unique
 * per sheet only, since a workbook may restart numbering on each sheet.
 */
function flagDuplicateProductNos(products: ImportProduct[]): void {
  const seen = new Map<string, ImportProduct[]>();
  for (const product of products) {
    if (product.productNo === null) continue;
    const key = `${product.sheet}\u0000${product.productNo}`;
    const list = seen.get(key) ?? [];
    list.push(product);
    seen.set(key, list);
  }
  for (const list of seen.values()) {
    if (list.length < 2) continue;
    for (const product of list) {
      product.warnings.push(
        importWarning("duplicate_product_no", {
          sheet: product.sheet,
          row: product.rows[0],
          column: "productNo",
          detail: `NO. ${product.productNo} starts more than one product on sheet "${product.sheet}". Merge the rows or renumber; these products are not imported.`,
        }),
      );
    }
  }
}

/* Two cleaned cells: both not applicable, or the same options in order. */
function sameOptions(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function cutCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("").trimEnd();
}
