// The product edit form's own state (text inputs hold strings) and the two
// conversions around it: stored values -> form state, and form state -> the
// JSON the Server Action re-parses with productInputSchema. Pure, client-safe.

import type { ProductFormValues } from "@/lib/schemas/product";
import { TRACK_SIZES } from "@/models/product-constants";

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

type Variants = NonNullable<ProductFormValues["variants"]>;
type ExtraSpecs = NonNullable<ProductFormValues["extraSpecs"]>;
type PublicFiles = NonNullable<ProductFormValues["publicFiles"]>;
type Specs = NonNullable<ProductFormValues["specs"]>;

/**
 * What React Hook Form holds. Section (a) edits the text, category, area,
 * track-size and filter fields. `specs`, `variants`, `extraSpecs`,
 * `publicFiles` and `datasheetId` have no inputs yet (T10b, T13): they are
 * loaded and sent back unchanged, so saving section (a) never wipes them.
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
  specs: Specs;
  variants: Variants;
  extraSpecs: ExtraSpecs;
  publicFiles: PublicFiles;
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
    specs: values.specs ?? {},
    variants: values.variants ?? [],
    extraSpecs: values.extraSpecs ?? [],
    publicFiles: values.publicFiles ?? [],
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
 * silently becoming "none". A hidden track size is sent as null.
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
    specs: values.specs,
    filters: filters as ProductFormValues["filters"],
    variants: values.variants,
    extraSpecs: values.extraSpecs,
    publicFiles: values.publicFiles,
    datasheetId: values.datasheetId,
  };
}
