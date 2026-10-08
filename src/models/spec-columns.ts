// The spec columns of the client's product sheet, as typed data: one fixed
// camelCase key per column, its English header and whether it is public or
// restricted by default. Products, the importer and the admin settings use it.

/** Who may see a spec column's values (an admin setting; this is the default). */
export type SpecVisibility = "public" | "restricted";

/** Where a spec column shows on the product page. */
export type SpecPlacement = "quick" | "table";

export interface SpecColumn {
  /** The fixed key under `product.specs` and `variant.specs`. */
  readonly key: string;
  /**
   * The English part of the sheet header. The real header is
   * "English\nChinese"; the importer (Phase 3) matches on the English line.
   */
  readonly header: string;
  readonly defaultVisibility: SpecVisibility;
  /**
   * Where the product page shows it (ADR 0054): "quick" = the right-hand
   * quick-spec panel (the sheet's pink columns), "table" = the full spec
   * table (the green columns).
   */
  readonly placement: SpecPlacement;
  /** The title of the group it belongs to (editor and spec table). */
  readonly group: string;
}

/*
 * The 28 spec columns, in the sheet's order. The other five sheet columns are
 * not specs: NO. (productNo), Model Name (family), Model Type (type),
 * Model No. (variants.modelNo) and Image (images).
 *
 * Keys are fixed on purpose: a restricted column is excluded from cached
 * queries by projecting its key away (`-specs.driver`,
 * `-variants.specs.driver`), so restricted values are never loaded into
 * cached code (ADR 0002). A free-form key/value list could not be projected
 * that way.
 */
export const SPEC_COLUMNS = [
  {
    key: "batchNo",
    header: "Batch No.",
    defaultVisibility: "restricted",
    placement: "table",
    group: "Identification",
  },
  {
    key: "housingMaterial",
    header: "Housing Material",
    defaultVisibility: "public",
    placement: "quick",
    group: "Housing and optics",
  },
  {
    key: "housingFinish",
    header: "Housing Color/Finish",
    defaultVisibility: "public",
    placement: "quick",
    group: "Housing and optics",
  },
  {
    key: "reflectorColor",
    header: "Reflector Color",
    defaultVisibility: "public",
    placement: "quick",
    group: "Housing and optics",
  },
  {
    key: "lens",
    header: "Lens",
    defaultVisibility: "public",
    placement: "table",
    group: "Housing and optics",
  },
  {
    key: "reflector",
    header: "Reflector",
    defaultVisibility: "public",
    placement: "table",
    group: "Housing and optics",
  },
  {
    key: "diffuser",
    header: "Diffuser",
    defaultVisibility: "public",
    placement: "table",
    group: "Housing and optics",
  },
  {
    key: "cutOutSize",
    header: "Cut-out Size",
    defaultVisibility: "public",
    placement: "quick",
    group: "Size and mounting",
  },
  {
    key: "dimensions",
    header: "Dimensions",
    defaultVisibility: "public",
    placement: "table",
    group: "Size and mounting",
  },
  {
    key: "rotatingAngle",
    header: "Rotating Angle",
    defaultVisibility: "public",
    placement: "table",
    group: "Size and mounting",
  },
  {
    key: "chipType",
    header: "Chip Type",
    defaultVisibility: "restricted",
    placement: "table",
    group: "Light source",
  },
  {
    key: "holder",
    header: "Holder",
    defaultVisibility: "restricted",
    placement: "table",
    group: "Light source",
  },
  {
    key: "chipEfficiency",
    header: "Chip Efficiency",
    defaultVisibility: "restricted",
    placement: "table",
    group: "Light source",
  },
  {
    key: "cct",
    header: "CCT",
    defaultVisibility: "public",
    placement: "quick",
    group: "Light source",
  },
  {
    key: "cri",
    header: "CRI",
    defaultVisibility: "public",
    placement: "table",
    group: "Light source",
  },
  {
    key: "beamAngle",
    header: "Beam Angle",
    defaultVisibility: "public",
    placement: "table",
    group: "Light source",
  },
  {
    key: "ugr",
    header: "UGR",
    defaultVisibility: "public",
    placement: "table",
    group: "Light source",
  },
  {
    key: "driver",
    header: "Driver",
    defaultVisibility: "restricted",
    placement: "table",
    group: "Electrical and output",
  },
  {
    key: "voltageInput",
    header: "Voltage Input",
    defaultVisibility: "public",
    placement: "table",
    group: "Electrical and output",
  },
  {
    key: "wattage",
    header: "Wattage",
    defaultVisibility: "public",
    placement: "table",
    group: "Electrical and output",
  },
  {
    key: "lumenOutput",
    header: "Lumen Output",
    defaultVisibility: "public",
    placement: "table",
    group: "Electrical and output",
  },
  {
    key: "lumenEfficiency",
    header: "Lumen Efficiency",
    defaultVisibility: "public",
    placement: "table",
    group: "Electrical and output",
  },
  {
    key: "powerFactor",
    header: "Power Factor",
    defaultVisibility: "public",
    placement: "table",
    group: "Electrical and output",
  },
  {
    key: "sdcm",
    header: "SDCM",
    defaultVisibility: "public",
    placement: "table",
    group: "Electrical and output",
  },
  {
    key: "dimmable",
    header: "Dimmable",
    defaultVisibility: "public",
    placement: "table",
    group: "Electrical and output",
  },
  {
    key: "lifespan",
    header: "Lifespan",
    defaultVisibility: "public",
    placement: "table",
    group: "Lifetime and protection",
  },
  {
    key: "ipRating",
    header: "IP Rating",
    defaultVisibility: "public",
    placement: "table",
    group: "Lifetime and protection",
  },
  {
    key: "warrantyPeriod",
    header: "Warranty Period",
    defaultVisibility: "public",
    placement: "table",
    group: "Lifetime and protection",
  },
] as const satisfies readonly SpecColumn[];

/** One of the 28 fixed spec keys, e.g. "driver". */
export type SpecKey = (typeof SPEC_COLUMNS)[number]["key"];

/** All spec keys, in sheet order. */
export const SPEC_KEYS: readonly SpecKey[] = SPEC_COLUMNS.map(
  (column) => column.key,
);

/** The keys that are restricted until the admin changes the setting. */
export const DEFAULT_RESTRICTED_SPEC_KEYS: readonly SpecKey[] =
  SPEC_COLUMNS.filter(
    (column) => column.defaultVisibility === "restricted",
  ).map((column) => column.key);

/** A listing filter whose numbers are parsed from a spec column. */
export type FilterKey = "cctK" | "cri" | "beamDeg" | "ugr" | "wattage" | "ip";

/**
 * The listing filters that are derived from a spec column. Making such a
 * column restricted also removes its parsed numbers from every product, so
 * the filter cannot be used to probe restricted values (rule 9, ADR 0002).
 * Pure, so the importer's parsers (src/lib/import/numbers.ts) share it with
 * the admin settings service, which re-exports it.
 */
export const FILTER_KEY_BY_SPEC: Readonly<Partial<Record<SpecKey, FilterKey>>> =
  {
    cct: "cctK",
    cri: "cri",
    beamAngle: "beamDeg",
    ugr: "ugr",
    wattage: "wattage",
    ipRating: "ip",
  };

/**
 * Spec values as stored: each key holds English display strings. One entry is
 * a single value; several entries are options shown as chips
 * (e.g. cct: ["3000K", "4000K"]). A missing key means "not applicable".
 */
export type SpecValues = Partial<Record<SpecKey, string[]>>;

/** The spec columns shown in one product-page area, in sheet order. */
export function specColumnsFor(
  placement: SpecPlacement,
): readonly (typeof SPEC_COLUMNS)[number][] {
  return SPEC_COLUMNS.filter((column) => column.placement === placement);
}

/**
 * The keys with the given visibility under the default setting, or under an
 * admin's effective one (`visibility` overrides by key). Pure.
 */
export function restrictedSpecKeys(
  visibility: Partial<Record<SpecKey, SpecVisibility>> = {},
): SpecKey[] {
  return SPEC_COLUMNS.filter(
    (column) =>
      (visibility[column.key] ?? column.defaultVisibility) === "restricted",
  ).map((column) => column.key);
}
