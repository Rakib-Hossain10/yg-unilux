// The spec columns of the client's product sheet, as typed data: one fixed
// camelCase key per column, its English header and whether it is public or
// restricted by default. Products, the importer and the admin settings use it.

/** Who may see a spec column's values (an admin setting; this is the default). */
export type SpecVisibility = "public" | "restricted";

export interface SpecColumn {
  /** The fixed key under `product.specs` and `variant.specs`. */
  readonly key: string;
  /**
   * The English part of the sheet header. The real header is
   * "English\nChinese"; the importer (Phase 3) matches on the English line.
   */
  readonly header: string;
  readonly defaultVisibility: SpecVisibility;
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
  { key: "batchNo", header: "Batch No.", defaultVisibility: "restricted" },
  {
    key: "housingMaterial",
    header: "Housing Material",
    defaultVisibility: "public",
  },
  {
    key: "housingFinish",
    header: "Housing Color/Finish",
    defaultVisibility: "public",
  },
  {
    key: "reflectorColor",
    header: "Reflector Color",
    defaultVisibility: "public",
  },
  { key: "lens", header: "Lens", defaultVisibility: "public" },
  { key: "reflector", header: "Reflector", defaultVisibility: "public" },
  { key: "diffuser", header: "Diffuser", defaultVisibility: "public" },
  { key: "cutOutSize", header: "Cut-out Size", defaultVisibility: "public" },
  { key: "dimensions", header: "Dimensions", defaultVisibility: "public" },
  {
    key: "rotatingAngle",
    header: "Rotating Angle",
    defaultVisibility: "public",
  },
  { key: "chipType", header: "Chip Type", defaultVisibility: "restricted" },
  { key: "holder", header: "Holder", defaultVisibility: "restricted" },
  {
    key: "chipEfficiency",
    header: "Chip Efficiency",
    defaultVisibility: "restricted",
  },
  { key: "cct", header: "CCT", defaultVisibility: "public" },
  { key: "cri", header: "CRI", defaultVisibility: "public" },
  { key: "beamAngle", header: "Beam Angle", defaultVisibility: "public" },
  { key: "ugr", header: "UGR", defaultVisibility: "public" },
  { key: "driver", header: "Driver", defaultVisibility: "restricted" },
  { key: "voltageInput", header: "Voltage Input", defaultVisibility: "public" },
  { key: "wattage", header: "Wattage", defaultVisibility: "public" },
  { key: "lumenOutput", header: "Lumen Output", defaultVisibility: "public" },
  {
    key: "lumenEfficiency",
    header: "Lumen Efficiency",
    defaultVisibility: "public",
  },
  { key: "powerFactor", header: "Power Factor", defaultVisibility: "public" },
  { key: "sdcm", header: "SDCM", defaultVisibility: "public" },
  { key: "dimmable", header: "Dimmable", defaultVisibility: "public" },
  { key: "lifespan", header: "Lifespan", defaultVisibility: "public" },
  { key: "ipRating", header: "IP Rating", defaultVisibility: "public" },
  {
    key: "warrantyPeriod",
    header: "Warranty Period",
    defaultVisibility: "public",
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
