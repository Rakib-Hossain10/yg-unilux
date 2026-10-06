// The product edit form's own state (text inputs hold strings) and the two
// conversions around it: stored values -> form state, and form state -> the
// JSON the Server Action re-parses with productInputSchema. Pure, client-safe.

import type { ProductFormValues } from "@/lib/schemas/product";
import { TRACK_SIZES } from "@/models/product-constants";
import { SPEC_KEYS, type SpecKey } from "@/models/spec-columns";

/** The listing filters, in the order the form shows them. */
export const FILTER_FIELDS = [
  { key: "cctK", label: "CCT (K)", example: "3000, 4000" },
  { key: "cri", label: "CRI", example: "80, 90" },
  { key: "beamDeg", label: "Beam angle (°)", example: "24, 36" },
  { key: "ugr", label: "UGR", example: "19" },
  { key: "wattage", label: "Wattage (W)", example: "7, 12" },
  { key: "ip", label: "IP rating", example: "20, 44" },
] as const;

export type FilterKey = (typeof FILTER_FIELDS)[number]["key"];
export const FILTER_KEYS: readonly FilterKey[] = FILTER_FIELDS.map(
  (field) => field.key,
);

/** "none" or a track size in mm as text (a Select value can't be ""). */
export const NO_TRACK_SIZE = "none";
export type TrackSizeChoice =
  typeof NO_TRACK_SIZE | `${(typeof TRACK_SIZES)[number]}`;

type StoredSpecs = NonNullable<ProductFormValues["specs"]>;

/** Product-level specs as typed: one text per key, one option per line. */
export type SpecTexts = Record<SpecKey, string>;

/**
 * A variant's spec differences as typed. Only the keys the admin added are
 * present (each with its own input); a key with "" is dropped on save.
 */
export type SpecOverrideTexts = Partial<Record<SpecKey, string>>;

/** One variant row of the editor (strings only, "" = none). */
export interface VariantFormValues {
  modelNo: string;
  label: string;
  imagePublicId: string;
  specs: SpecOverrideTexts;
}

/** One extra spec row: `group` may be "". */
export interface ExtraSpecFormValues {
  group: string;
  label: string;
  value: string;
}

/** One public file row: a label and an https:// link. */
export interface PublicFileFormValues {
  label: string;
  url: string;
}

/** A new, empty row for each editor (what "Add" appends). */
export const EMPTY_VARIANT: VariantFormValues = {
  modelNo: "",
  label: "",
  imagePublicId: "",
  specs: {},
};
export const EMPTY_EXTRA_SPEC: ExtraSpecFormValues = {
  group: "",
  label: "",
  value: "",
};
export const EMPTY_PUBLIC_FILE: PublicFileFormValues = { label: "", url: "" };

/** Stored options -> the editor's text: one option per line. */
export function optionsToText(values: readonly string[] | undefined): string {
  return (values ?? []).join("\n");
}

/**
 * The editor's text -> options: one per line (LF or CRLF, e.g. a paste on
 * Windows), trimmed, blank lines dropped.
 * Lines, not commas or slashes, because real values contain both
 * ("100-240V, 50/60Hz"); the client's sheet also puts one option per line.
 */
export function textToOptions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Stored specs -> one text per key (all 28 keys, "" = not applicable). */
export function specsToTexts(specs: StoredSpecs | undefined): SpecTexts {
  return Object.fromEntries(
    SPEC_KEYS.map((key) => [key, optionsToText(specs?.[key])]),
  ) as SpecTexts;
}

/** A variant's stored differences -> texts for the keys it has. */
function overridesToTexts(specs: StoredSpecs | undefined): SpecOverrideTexts {
  const texts: SpecOverrideTexts = {};
  for (const key of SPEC_KEYS) {
    const values = specs?.[key];
    if (values !== undefined && values.length > 0) {
      texts[key] = optionsToText(values);
    }
  }
  return texts;
}

/**
 * Spec texts -> the schema's spec object, keys in SPEC_KEYS order and only
 * keys with at least one option (the schema drops empty ones anyway, and
 * leaving them out keeps the "no changes" check exact).
 */
export function textsToSpecs(texts: SpecOverrideTexts): StoredSpecs {
  const specs: Partial<Record<SpecKey, string[]>> = {};
  for (const key of SPEC_KEYS) {
    const text = texts[key];
    if (text === undefined) continue;
    const options = textToOptions(text);
    if (options.length > 0) specs[key] = options;
  }
  return specs;
}

/**
 * What React Hook Form holds. Section (a) edits the text, category, area,
 * track-size and filter fields; section (b) the specs, variants, extra specs
 * and public files. `datasheetId` has no input yet (T13): it is loaded and
 * sent back unchanged, so a save never wipes it.
 * `status` is not form state: it comes from the server on every render, so a
 * Save after Publish can never send the old status back.
 */
export interface ProductEditValues {
  name: string;
  slug: string;
  family: string;
  modelCode: string;
  /** The sheet's NO. as typed; "" = none. */
  productNo: string;
  type: string;
  description: string;
  mainCategory: string;
  extraCategories: string[];
  areas: string[];
  trackSize: TrackSizeChoice;
  /** One text per filter, numbers separated by commas. */
  filters: Record<FilterKey, string>;
  specs: SpecTexts;
  variants: VariantFormValues[];
  extraSpecs: ExtraSpecFormValues[];
  publicFiles: PublicFileFormValues[];
  datasheetId: string | null;
}

/** Stored values (from getProductForEdit) -> form state. */
export function toFormState(values: ProductFormValues): ProductEditValues {
  const filters = Object.fromEntries(
    FILTER_KEYS.map((key) => [key, (values.filters?.[key] ?? []).join(", ")]),
  ) as Record<FilterKey, string>;
  return {
    name: values.name,
    slug: values.slug ?? "",
    family: values.family ?? "",
    modelCode: values.modelCode ?? "",
    productNo:
      values.productNo === null || values.productNo === undefined
        ? ""
        : String(values.productNo),
    type: values.type ?? "",
    description: values.description ?? "",
    mainCategory: values.mainCategory,
    extraCategories: [...(values.extraCategories ?? [])],
    areas: [...(values.areas ?? [])],
    trackSize:
      values.trackSize === null || values.trackSize === undefined
        ? NO_TRACK_SIZE
        : (String(values.trackSize) as TrackSizeChoice),
    filters,
    specs: specsToTexts(values.specs),
    variants: (values.variants ?? []).map((variant) => ({
      modelNo: variant.modelNo,
      label: variant.label ?? "",
      imagePublicId: variant.imagePublicId ?? "",
      specs: overridesToTexts(variant.specs),
    })),
    extraSpecs: (values.extraSpecs ?? []).map((extra) => ({
      group: extra.group ?? "",
      label: extra.label,
      value: extra.value,
    })),
    publicFiles: (values.publicFiles ?? []).map((file) => ({
      label: file.label,
      url: file.url,
    })),
    datasheetId: values.datasheetId ?? null,
  };
}

/** Longest token quoted back in a "not a number" message. */
const MAX_QUOTED = 20;
const NUMBER_TOKEN = /^\d+(\.\d+)?$/;

/**
 * Reads a filter text such as "3000, 4000" into numbers. Commas, semicolons
 * and spaces all separate; "" is an empty list. A token that is not a plain
 * non-negative number gives an error naming it.
 */
export function parseNumberList(
  text: string,
): { ok: true; numbers: number[] } | { ok: false; message: string } {
  const tokens = text.split(/[\s,;]+/).filter((token) => token !== "");
  const numbers: number[] = [];
  for (const token of tokens) {
    if (!NUMBER_TOKEN.test(token)) {
      const shown =
        token.length > MAX_QUOTED ? `${token.slice(0, MAX_QUOTED)}…` : token;
      return { ok: false, message: `"${shown}" is not a number` };
    }
    numbers.push(Number(token));
  }
  return { ok: true, numbers };
}

/** The sheet's NO. as typed: "" = none; anything else must be digits. */
export function parseProductNo(
  text: string,
): { ok: true; value: number | null } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: "Enter a whole number, e.g. 76" };
  }
  return { ok: true, value: Number(trimmed) };
}

/**
 * True when the chosen categories allow a track size: the main category or
 * an extra one is Magnetic Track or one of its subcategories (ADR 0041; the
 * server decides again).
 */
export function allowsTrackSize(
  values: Pick<ProductEditValues, "mainCategory" | "extraCategories">,
  magneticTrackIds: ReadonlySet<string>,
): boolean {
  return [values.mainCategory, ...values.extraCategories].some((id) =>
    magneticTrackIds.has(id),
  );
}

/* JSON with object keys sorted, so equal values compare equal as text. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

/**
 * True when two parsed inputs are the same product, e.g. the form only
 * differs from the saved values by spaces the schema trims. The form then
 * skips the round trip instead of saving "no changes".
 */
export function sameParsedInput(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/**
 * Form state -> the Server Action's input, without `status` (the caller adds
 * the server's current one). Text that fails parseNumberList/parseProductNo
 * is passed through as-is, so productInputSchema refuses it instead of it
 * silently becoming "none". A hidden track size is sent as null. Spec texts
 * become option lists (one per line); rows are copied field by field, so no
 * stray key (e.g. a field-array id) can reach the strict schema.
 */
export function toProductInput(
  values: ProductEditValues,
  magneticTrackIds: ReadonlySet<string>,
): Omit<ProductFormValues, "status"> {
  const filters: Partial<Record<FilterKey, unknown>> = {};
  for (const key of FILTER_KEYS) {
    const parsed = parseNumberList(values.filters[key]);
    if (!parsed.ok) filters[key] = values.filters[key];
    else if (parsed.numbers.length > 0) filters[key] = parsed.numbers;
  }
  const productNo = parseProductNo(values.productNo);
  const trackSize =
    values.trackSize !== NO_TRACK_SIZE &&
    allowsTrackSize(values, magneticTrackIds)
      ? Number(values.trackSize)
      : null;

  return {
    name: values.name,
    slug: values.slug,
    family: values.family,
    modelCode: values.modelCode,
    productNo: (productNo.ok ? productNo.value : values.productNo) as
      number | null,
    type: values.type,
    description: values.description,
    mainCategory: values.mainCategory,
    extraCategories: values.extraCategories,
    areas: values.areas,
    trackSize: trackSize as ProductFormValues["trackSize"],
    specs: textsToSpecs(values.specs),
    filters: filters as ProductFormValues["filters"],
    variants: values.variants.map((variant) => ({
      modelNo: variant.modelNo,
      label: variant.label,
      specs: textsToSpecs(variant.specs),
      imagePublicId: variant.imagePublicId,
    })),
    extraSpecs: values.extraSpecs.map((extra) => ({
      group: extra.group,
      label: extra.label,
      value: extra.value,
    })),
    publicFiles: values.publicFiles.map((file) => ({
      label: file.label,
      url: file.url,
    })),
    datasheetId: values.datasheetId,
  };
}
