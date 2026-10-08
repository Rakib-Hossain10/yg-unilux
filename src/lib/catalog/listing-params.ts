// Listing URL parameters (ADR 0065): a Zod-backed parser that turns any query
// into a small canonical set (junk and restricted facets are dropped, never
// thrown), and the serialiser that builds canonical query strings for links.
// Pure and client-safe: no server-only, no database.

import { z } from "zod";

import { MAX_SLUG_LENGTH, SLUG_PATTERN } from "@/lib/slug";
import { TRACK_SIZES, type TrackSize } from "@/models/product-constants";
import {
  restrictedSpecKeys,
  type FilterKey,
  type SpecKey,
  type SpecVisibility,
} from "@/models/spec-columns";

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

/** The facets parsed from a spec column (dropped while the column is restricted). */
export const SPEC_FACET_PARAMS = [
  "cct",
  "cri",
  "beam",
  "ugr",
  "w",
  "ip",
] as const;
export type SpecFacetParam = (typeof SPEC_FACET_PARAMS)[number];

/** The spec-column facets that are plain numbers (wattage uses buckets). */
export const NUMERIC_FACET_PARAMS = [
  "cct",
  "cri",
  "beam",
  "ugr",
  "ip",
] as const;
export type NumericFacetParam = (typeof NUMERIC_FACET_PARAMS)[number];

/** Every filter param: spec facets, track size and the area pages' category. */
export type ListingFacetParam = SpecFacetParam | "track" | "cat";

/** The spec column each facet is parsed from (its visibility gates the facet). */
export const FACET_SPEC_KEY: Readonly<Record<SpecFacetParam, SpecKey>> = {
  cct: "cct",
  cri: "cri",
  beam: "beamAngle",
  ugr: "ugr",
  w: "wattage",
  ip: "ipRating",
};

/** The `product.filters` field each facet matches. */
export const FACET_FILTER_KEY: Readonly<Record<SpecFacetParam, FilterKey>> = {
  cct: "cctK",
  cri: "cri",
  beam: "beamDeg",
  ugr: "ugr",
  w: "wattage",
  ip: "ip",
};

/*
 * Accepted range per numeric facet. A value outside it can never be selected
 * and is never offered as a facet option (facets.ts applies the same bounds).
 */
export const NUMERIC_FACET_BOUNDS: Readonly<
  Record<NumericFacetParam, { min: number; max: number }>
> = {
  cct: { min: 1000, max: 20_000 },
  cri: { min: 0, max: 100 },
  beam: { min: 0, max: 360 },
  ugr: { min: 0, max: 40 },
  ip: { min: 0, max: 99 },
};

/**
 * Wattage ranges (Q3): a product matches a bucket when ANY of its wattage
 * numbers lies in (gt, lte]. `null` = open end.
 */
export const WATTAGE_BUCKETS = [
  { id: "0-10", label: "Up to 10 W", gt: null, lte: 10 },
  { id: "11-20", label: "11–20 W", gt: 10, lte: 20 },
  { id: "21-40", label: "21–40 W", gt: 20, lte: 40 },
  { id: "41+", label: "Over 40 W", gt: 40, lte: null },
] as const satisfies readonly {
  id: string;
  label: string;
  gt: number | null;
  lte: number | null;
}[];
export type WattageBucketId = (typeof WATTAGE_BUCKETS)[number]["id"];
const WATTAGE_BUCKET_IDS = WATTAGE_BUCKETS.map((bucket) => bucket.id);

/** Most values one facet keeps (more are cut after sorting). */
export const MAX_FACET_SELECTIONS = 12;
/** Highest page number the parser accepts (anything above → page 1). */
export const MAX_LISTING_PAGE = 1000;

export const LISTING_SORTS = ["catalog", "name", "newest"] as const;
export type ListingSort = (typeof LISTING_SORTS)[number];

/*
 * Raw-input caps: at most this many raw entries per key and tokens per key
 * are looked at, and an entry longer than MAX_RAW_ENTRY_LENGTH is ignored,
 * so a huge query costs a bounded amount of work.
 */
const MAX_RAW_ENTRIES = 16;
const MAX_RAW_TOKENS = 48;
const MAX_RAW_ENTRY_LENGTH = 512;

// ---------------------------------------------------------------------------
// The parsed shape
// ---------------------------------------------------------------------------

/** A canonical listing query: every list deduped and sorted, bounded. */
export interface ListingParams {
  cct: number[];
  cri: number[];
  beam: number[];
  ugr: number[];
  ip: number[];
  /** Wattage bucket ids, in WATTAGE_BUCKETS order. */
  w: WattageBucketId[];
  /** Magnetic Track sizes (only kept when the scope allows it). */
  track: TrackSize[];
  /** Main category slugs (only kept on area pages). */
  cat: string[];
  sort: ListingSort;
  page: number;
}

export const DEFAULT_LISTING_PARAMS: Readonly<ListingParams> = Object.freeze({
  cct: [],
  cri: [],
  beam: [],
  ugr: [],
  ip: [],
  w: [],
  track: [],
  cat: [],
  sort: "catalog",
  page: 1,
});

/** What a parse may keep besides the always-allowed sort and page. */
export interface ListingParamOptions {
  /** Spec facets whose column is public. Anything else is dropped. */
  publicFacets: Iterable<SpecFacetParam>;
  /** Keep `track` (Magnetic Track scope only). Default false. */
  track?: boolean;
  /** Keep `cat` (area pages only). Default false. */
  cat?: boolean;
}

/**
 * The spec facets that may be used under this column visibility. Fails
 * closed like restrictedSpecKeys: only a column set exactly to "public"
 * (or public by default) unlocks its facet.
 */
export function publicSpecFacets(
  visibility: Partial<Record<SpecKey, SpecVisibility>> = {},
): SpecFacetParam[] {
  const restricted = new Set(restrictedSpecKeys(visibility));
  return SPEC_FACET_PARAMS.filter(
    (param) => !restricted.has(FACET_SPEC_KEY[param]),
  );
}

// ---------------------------------------------------------------------------
// Token schemas (Zod). Each token is checked on its own; failures are dropped.
// ---------------------------------------------------------------------------

/* A plain decimal: up to 6 integer digits and 2 decimals, no sign/exponent. */
const DECIMAL = /^\d{1,6}(?:\.\d{1,2})?$/;

const numberToken = (min: number, max: number) =>
  z
    .string()
    .regex(DECIMAL)
    .transform(Number)
    .pipe(z.number().finite().min(min).max(max));

const NUMBER_TOKENS: Record<NumericFacetParam, z.ZodType<number, string>> = {
  cct: numberToken(NUMERIC_FACET_BOUNDS.cct.min, NUMERIC_FACET_BOUNDS.cct.max),
  cri: numberToken(NUMERIC_FACET_BOUNDS.cri.min, NUMERIC_FACET_BOUNDS.cri.max),
  beam: numberToken(
    NUMERIC_FACET_BOUNDS.beam.min,
    NUMERIC_FACET_BOUNDS.beam.max,
  ),
  ugr: numberToken(NUMERIC_FACET_BOUNDS.ugr.min, NUMERIC_FACET_BOUNDS.ugr.max),
  ip: numberToken(NUMERIC_FACET_BOUNDS.ip.min, NUMERIC_FACET_BOUNDS.ip.max),
};

/**
 * True when `value` written as a URL token parses back to itself for this
 * facet (in bounds, at most 2 decimals): only such values are offered.
 */
export function isSelectableNumber(
  param: NumericFacetParam,
  value: number,
): boolean {
  const result = NUMBER_TOKENS[param].safeParse(String(value));
  return result.success && result.data === value;
}

const wattageToken = z.enum(WATTAGE_BUCKET_IDS);
const trackToken = z
  .string()
  .regex(/^\d{1,2}$/)
  .transform((text) => TRACK_SIZES.find((size) => String(size) === text))
  .pipe(z.custom<TrackSize>((value) => value !== undefined));
const categoryToken = z.string().max(MAX_SLUG_LENGTH).regex(SLUG_PATTERN);
const sortToken = z.enum(LISTING_SORTS);
const pageToken = z
  .string()
  .regex(/^\d{1,4}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAX_LISTING_PAGE));

/** A query as Next passes `searchParams`, or a URLSearchParams. */
export type RawListingQuery =
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>;

/* The raw entries of one key, capped in count and length. */
function rawEntries(query: RawListingQuery, key: string): string[] {
  let entries: readonly unknown[];
  if (query instanceof URLSearchParams) entries = query.getAll(key);
  else {
    // Own keys only: "__proto__" / "constructor" are never read.
    const value = Object.hasOwn(query, key) ? query[key] : undefined;
    entries = value === undefined ? [] : Array.isArray(value) ? value : [value];
  }
  return entries
    .slice(0, MAX_RAW_ENTRIES)
    .filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.length <= MAX_RAW_ENTRY_LENGTH,
    );
}

/* Comma-separated tokens of every entry ("a,b" and repeated keys alike). */
function rawTokens(query: RawListingQuery, key: string): string[] {
  return rawEntries(query, key)
    .flatMap((entry) => entry.split(","))
    .slice(0, MAX_RAW_TOKENS)
    .map((token) => token.trim())
    .filter((token) => token !== "");
}

function parseList<T>(
  tokens: readonly string[],
  schema: z.ZodType<T, string>,
  compare: (a: T, b: T) => number,
): T[] {
  const values: T[] = [];
  for (const token of tokens) {
    const result = schema.safeParse(token);
    if (result.success && !values.includes(result.data)) {
      values.push(result.data);
    }
  }
  return values.sort(compare).slice(0, MAX_FACET_SELECTIONS);
}

const byNumber = (a: number, b: number) => a - b;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byBucket = (a: WattageBucketId, b: WattageBucketId) =>
  WATTAGE_BUCKET_IDS.indexOf(a) - WATTAGE_BUCKET_IDS.indexOf(b);

/* The first valid single value of a key, or the fallback. */
function parseSingle<T>(
  query: RawListingQuery,
  key: string,
  schema: z.ZodType<T, string>,
  fallback: T,
): T {
  for (const entry of rawEntries(query, key)) {
    const result = schema.safeParse(entry.trim());
    if (result.success) return result.data;
  }
  return fallback;
}

/**
 * Parses a listing query. Never throws: unknown keys, malformed or
 * out-of-range values, facets not in `publicFacets`, and `track` / `cat`
 * unless allowed are dropped. Lists accept "a,b" and repeated keys (a GET
 * form submits one key per ticked box).
 */
export function parseListingParams(
  query: RawListingQuery,
  options: ListingParamOptions,
): ListingParams {
  const allowed = new Set(options.publicFacets);
  const params: ListingParams = {
    ...DEFAULT_LISTING_PARAMS,
    cct: [],
    cri: [],
    beam: [],
    ugr: [],
    ip: [],
    w: [],
    track: [],
    cat: [],
  };
  for (const param of NUMERIC_FACET_PARAMS) {
    if (!allowed.has(param)) continue;
    params[param] = parseList(
      rawTokens(query, param),
      NUMBER_TOKENS[param],
      byNumber,
    );
  }
  if (allowed.has("w")) {
    params.w = parseList(rawTokens(query, "w"), wattageToken, byBucket);
  }
  if (options.track === true) {
    params.track = parseList(rawTokens(query, "track"), trackToken, byNumber);
  }
  if (options.cat === true) {
    params.cat = parseList(rawTokens(query, "cat"), categoryToken, byText);
  }
  params.sort = parseSingle(query, "sort", sortToken, "catalog");
  params.page = parseSingle(query, "page", pageToken, 1);
  return params;
}

// ---------------------------------------------------------------------------
// Serialiser
// ---------------------------------------------------------------------------

/** Param order in canonical query strings. */
const SERIAL_ORDER = [
  "cat",
  "track",
  "cct",
  "cri",
  "beam",
  "ugr",
  "w",
  "ip",
] as const satisfies readonly ListingFacetParam[];

/**
 * The canonical query string (no leading "?"; "" when everything is the
 * default). Stable order, lists comma-joined, defaults (sort=catalog,
 * page=1) left out. The input should come from parseListingParams.
 */
export function serialiseListingParams(params: ListingParams): string {
  const parts: string[] = [];
  for (const key of SERIAL_ORDER) {
    const values: readonly (string | number)[] = params[key];
    if (values.length === 0) continue;
    parts.push(
      `${key}=${values.map((value) => encodeURIComponent(String(value))).join(",")}`,
    );
  }
  if (params.sort !== "catalog") parts.push(`sort=${params.sort}`);
  if (params.page !== 1) parts.push(`page=${params.page}`);
  return parts.join("&");
}

/** The filters alone (sort and page reset): the key of a result set. */
export function listingFilterKey(params: ListingParams): string {
  return serialiseListingParams({ ...params, sort: "catalog", page: 1 });
}

/** Number of selected filter values (the "Filters (n)" badge). */
export function countActiveFilters(params: ListingParams): number {
  return SERIAL_ORDER.reduce((sum, key) => sum + params[key].length, 0);
}

// ---------------------------------------------------------------------------
// Labels (shared by facet options and active-filter chips)
// ---------------------------------------------------------------------------

export const FACET_LABELS: Readonly<Record<ListingFacetParam, string>> = {
  cat: "Category",
  track: "Track size",
  cct: "CCT",
  cri: "CRI",
  beam: "Beam angle",
  ugr: "UGR",
  w: "Wattage",
  ip: "IP rating",
};

/** The display label of one numeric, wattage or track value. */
export function facetValueLabel(
  param: Exclude<ListingFacetParam, "cat">,
  value: string,
): string {
  switch (param) {
    case "cct":
      return `${value}K`;
    case "cri":
      return `CRI ${value}`;
    case "beam":
      return `${value}°`;
    case "ugr":
      return `UGR ${value}`;
    case "ip":
      return `IP${value.padStart(2, "0")}`;
    case "track":
      return `${value} mm`;
    case "w":
      return (
        WATTAGE_BUCKETS.find((bucket) => bucket.id === value)?.label ?? value
      );
  }
}
