// Which product fields have an input on screen. Errors for any other field
// (status, images, a row that no longer exists ...) go to the form-level
// alert instead of vanishing. Pure, so the mapping is unit-tested.

import { SPEC_KEYS } from "@/models/spec-columns";

import type { ProductEditValues } from "./form-values";

/** Section (a) "Basics": plain text inputs. */
export const BASICS_FIELDS = [
  "name",
  "slug",
  "family",
  "modelCode",
  "productNo",
  "type",
  "description",
] as const;

/** Section (a) "Categories and areas" (trackSize only when shown). */
export const CATEGORY_FIELDS = [
  "mainCategory",
  "extraCategories",
  "areas",
] as const;

/** The row lists of section (b). */
export type RowList = "variants" | "extraSpecs" | "publicFiles";

/**
 * Row lists of section (b) and the inputs each row has. The one definition
 * of a "row list": field-errors.ts maps paths and list-level errors with it.
 * Keyed by RowList, so a new list must also be added to RenderedRows.
 */
export const ROW_INPUTS: Readonly<Record<RowList, ReadonlySet<string>>> = {
  variants: new Set(["modelNo", "label", "imagePublicId"]),
  extraSpecs: new Set(["group", "label", "value"]),
  publicFiles: new Set(["label", "url"]),
};

/** True when `name` is one of the row lists (a type guard for paths). */
export function isRowList(name: string | undefined): name is RowList {
  return name !== undefined && Object.hasOwn(ROW_INPUTS, name);
}

const ALWAYS = new Set<string>([
  ...BASICS_FIELDS,
  ...CATEGORY_FIELDS,
  // Section (b): every product-level spec has an input.
  ...SPEC_KEYS.map((key) => `specs.${key}`),
  // Each row list shows a list-level message (e.g. "At most 200 variants").
  ...Object.keys(ROW_INPUTS).flatMap((list) => [list, `${list}.root`]),
]);

/** The current rows, read when the errors arrive (not watched). */
export type RenderedRows = Pick<ProductEditValues, RowList>;

/**
 * True when `field` (a path from formFieldForPath, or `<list>.root`) is
 * rendered right now. Row fields count only while that row exists, and a
 * variant's spec difference only while the row shows an input for that key.
 * Without `rows` no row is rendered, so row errors go to the alert.
 */
export function isRenderedField(
  field: string,
  shown: { trackSize: boolean },
  rows?: RenderedRows,
): boolean {
  if (ALWAYS.has(field)) return true;
  if (field === "trackSize") return shown.trackSize;
  if (/^filters\.[A-Za-z]+$/.test(field)) return true;

  const [list, index, input, specKey, ...rest] = field.split(".");
  if (rows === undefined || !isRowList(list) || index === undefined) {
    return false;
  }
  if (!/^\d+$/.test(index)) return false;
  const inputs = ROW_INPUTS[list];
  const row = rows[list][Number(index)];
  if (row === undefined || rest.length > 0) return false;
  // `variants.2` (the row as a whole) has no input of its own.
  if (input === undefined) return false;
  if (specKey === undefined) return inputs.has(input);
  return (
    list === "variants" &&
    input === "specs" &&
    "specs" in row &&
    Object.hasOwn(row.specs, specKey)
  );
}
