// Cached listing facets (ADR 0065): for the published products of a scope,
// the values of each PUBLIC filter with product counts, from one `$facet`
// aggregation over `filters` numbers. A restricted column's facet is never
// computed. Visibility comes in as a cache argument; never reads a session.

import "server-only";

import type { PipelineStage } from "mongoose";
import { unstable_cache } from "next/cache";

import { connectDb } from "@/lib/db";
import { CATALOG_TAGS } from "@/lib/revalidate";
import { ProductModel } from "@/models";
import { TRACK_SIZES } from "@/models/product-constants";
import { restrictedSpecKeys } from "@/models/spec-columns";

import { CATALOG_CACHE_VERSION } from "./cache-version";
import { mainCategorySubtreesIn } from "./category-path";
import {
  FACET_FILTER_KEY,
  FACET_LABELS,
  facetValueLabel,
  isSelectableNumber,
  NUMERIC_FACET_BOUNDS,
  NUMERIC_FACET_PARAMS,
  WATTAGE_BUCKETS,
  type ListingFacetParam,
  type NumericFacetParam,
} from "./listing-params";
import {
  facetsFromRestrictedKey,
  inCategories,
  resolveScope,
  scopeMatch,
  type ListingScope,
  type NormalisedScope,
  type ResolvedScope,
} from "./listing-scope";
import type { VisibilityByKey } from "./view";

/** Most options one numeric facet offers (lowest values first). */
export const MAX_FACET_OPTIONS = 50;

/*
 * Most distinct values per numeric facet the cached counts keep. Options
 * show the first MAX_FACET_OPTIONS; the rest let listProducts tell a value
 * no product has from one beyond the options cap (gate-A M-1). Real data has
 * a few dozen values; a scope with more is flagged `truncated`.
 */
export const MAX_KNOWN_FACET_VALUES = 1000;

/** One selectable value. `value` is the URL token (listing-params). */
export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

export interface FacetGroup {
  param: ListingFacetParam;
  label: string;
  /** Only values present in the scope (count ≥ 1). */
  options: FacetOption[];
}

export interface ListingFacets {
  /** Published products in the scope (no filter applied). */
  total: number;
  /** Display order: category, track, then the spec facets in sheet order. */
  groups: FacetGroup[];
}

/** Counts as cached: plain tuples, no labels or names. */
interface FacetCounts {
  total: number;
  /** Every selectable value (ascending, up to MAX_KNOWN_FACET_VALUES). */
  numeric: Partial<Record<NumericFacetParam, [number, number][]>>;
  /** True when a facet had more values than MAX_KNOWN_FACET_VALUES. */
  truncated: Partial<Record<NumericFacetParam, boolean>>;
  wattage: [string, number][] | null;
  track: [number, number][] | null;
  /** [main category id, count], same order as the `mains` argument. */
  categories: [string, number][] | null;
}

interface GroupRow {
  _id: number | string;
  n: number;
}
type FacetResult = Record<string, (GroupRow | { n: number })[]>;

const countBy = (field: string): PipelineStage.FacetPipelineStage[] => [
  { $unwind: field },
  { $group: { _id: field, n: { $sum: 1 } } },
  { $sort: { _id: 1 } },
];

/*
 * Distinct numbers of one filter per product that the URL parser accepts
 * back (inside the facet's bounds, at most 2 decimals), checked BEFORE the
 * sort and limit so over-precise values never take an option's place
 * (gate-A I-3). One more than MAX_KNOWN_FACET_VALUES is read to detect a
 * cut.
 */
export function numericBranch(
  param: NumericFacetParam,
): PipelineStage.FacetPipelineStage[] {
  const { min, max } = NUMERIC_FACET_BOUNDS[param];
  const field = `$filters.${FACET_FILTER_KEY[param]}`;
  return [
    { $project: { _id: 0, v: { $setUnion: [{ $ifNull: [field, []] }] } } },
    { $unwind: "$v" },
    {
      $match: {
        v: { $gte: min, $lte: max },
        $expr: {
          $and: [{ $isNumber: "$v" }, { $eq: ["$v", { $round: ["$v", 2] }] }],
        },
      },
    },
    { $group: { _id: "$v", n: { $sum: 1 } } },
    { $sort: { _id: 1 } },
    { $limit: MAX_KNOWN_FACET_VALUES + 1 },
  ];
}

/* The bucket id of a wattage number: the first bucket whose upper end fits. */
const WATTAGE_SWITCH = {
  $switch: {
    branches: WATTAGE_BUCKETS.filter((bucket) => bucket.lte !== null).map(
      (bucket) => ({ case: { $lte: ["$$x", bucket.lte] }, then: bucket.id }),
    ),
    default: WATTAGE_BUCKETS[WATTAGE_BUCKETS.length - 1]?.id,
  },
};

const WATTAGE_BRANCH: PipelineStage.FacetPipelineStage[] = [
  {
    $project: {
      _id: 0,
      b: {
        $setUnion: [
          {
            $map: {
              input: { $ifNull: ["$filters.wattage", []] },
              as: "x",
              in: WATTAGE_SWITCH,
            },
          },
        ],
      },
    },
  },
  ...countBy("$b"),
];

const TRACK_BRANCH: PipelineStage.FacetPipelineStage[] = [
  { $match: { trackSize: { $in: [...TRACK_SIZES] } } },
  { $group: { _id: "$trackSize", n: { $sum: 1 } } },
  { $sort: { _id: 1 } },
];

const rows = (result: FacetResult, key: string): GroupRow[] =>
  (result[key] ?? []).filter(
    (row): row is GroupRow => "_id" in row && typeof row.n === "number",
  );
const countOf = (result: FacetResult, key: string): number =>
  result[key]?.[0]?.n ?? 0;

async function readFacetCounts(
  scope: NormalisedScope,
  restrictedKeys: string,
  withTrack: boolean,
  mains: [string, string[]][],
): Promise<FacetCounts> {
  await connectDb();
  // Which facets exist comes ONLY from the key argument (gate-A M-1).
  const publicFacets = new Set(facetsFromRestrictedKey(restrictedKeys));
  const branches: Record<string, PipelineStage.FacetPipelineStage[]> = {
    total: [{ $count: "n" }],
  };
  for (const param of NUMERIC_FACET_PARAMS) {
    if (publicFacets.has(param)) branches[param] = numericBranch(param);
  }
  if (publicFacets.has("w")) branches.w = WATTAGE_BRANCH;
  if (withTrack) branches.track = TRACK_BRANCH;
  mains.forEach(([, ids], index) => {
    branches[`cat${index}`] = [{ $match: inCategories(ids) }, { $count: "n" }];
  });

  const [result = {}] = await ProductModel.aggregate<FacetResult>([
    { $match: scopeMatch(scope) },
    { $facet: branches },
  ]);

  const numeric: FacetCounts["numeric"] = {};
  const truncated: FacetCounts["truncated"] = {};
  for (const param of NUMERIC_FACET_PARAMS) {
    if (!publicFacets.has(param)) continue;
    const found = rows(result, param);
    truncated[param] = found.length > MAX_KNOWN_FACET_VALUES;
    numeric[param] = found
      .slice(0, MAX_KNOWN_FACET_VALUES)
      .filter(
        // The pipeline already checks this; kept as the parser's own word.
        (row) =>
          typeof row._id === "number" && isSelectableNumber(param, row._id),
      )
      .map((row) => [row._id as number, row.n]);
  }
  return {
    total: countOf(result, "total"),
    numeric,
    truncated,
    wattage: publicFacets.has("w")
      ? rows(result, "w").map((row) => [String(row._id), row.n])
      : null,
    track: withTrack
      ? rows(result, "track").map((row) => [Number(row._id), row.n])
      : null,
    categories:
      mains.length > 0
        ? mains.map(([id], index) => [id, countOf(result, `cat${index}`)])
        : null,
  };
}

const cachedFacetCounts = unstable_cache(
  readFacetCounts,
  ["catalog", "listing-facets", CATALOG_CACHE_VERSION],
  {
    tags: [
      CATALOG_TAGS.products,
      CATALOG_TAGS.categories,
      CATALOG_TAGS.areas,
      CATALOG_TAGS.settingsColumns,
    ],
  },
);

const option = (
  param: Exclude<ListingFacetParam, "cat">,
  value: string,
  count: number,
): FacetOption => ({ value, label: facetValueLabel(param, value), count });

/* The cached counts of a resolved scope (one entry per scope + visibility). */
function countsFor(
  resolved: ResolvedScope,
  visibility: VisibilityByKey,
): Promise<FacetCounts> {
  const mains =
    resolved.scope.kind === "area" ? mainCategorySubtreesIn(resolved.tree) : [];
  return cachedFacetCounts(
    resolved.scope,
    restrictedSpecKeys(visibility).join(","),
    resolved.trackApplies,
    mains.map((main): [string, string[]] => [main.id, main.subtreeIds]),
  );
}

/**
 * The filter values the published products of a scope actually have (from
 * the same cached entry as getFacets). A selected value outside these can
 * only match nothing, so listProducts drops it before building a cache key
 * (gate-A M-1). `above` (numeric facets): when the value list was cut,
 * values above it are unknown and must be kept; null when it is complete.
 * A facet that is absent (restricted, or not for this scope) is undefined
 * or null.
 */
export interface KnownFilterValues {
  numeric: Partial<
    Record<NumericFacetParam, { values: Set<number>; above: number | null }>
  >;
  wattage: Set<string> | null;
  track: Set<number> | null;
}

export async function knownFilterValues(
  resolved: ResolvedScope,
  visibility: VisibilityByKey,
): Promise<KnownFilterValues> {
  const counts = await countsFor(resolved, visibility);
  const numeric: KnownFilterValues["numeric"] = {};
  for (const param of NUMERIC_FACET_PARAMS) {
    const values = counts.numeric[param];
    if (!values) continue;
    numeric[param] = {
      values: new Set(values.filter(([, n]) => n > 0).map(([value]) => value)),
      above:
        counts.truncated[param] === true
          ? (values.at(-1)?.[0] ?? NUMERIC_FACET_BOUNDS[param].min - 1)
          : null,
    };
  }
  return {
    numeric,
    wattage: counts.wattage
      ? new Set(counts.wattage.filter(([, n]) => n > 0).map(([id]) => id))
      : null,
    track: counts.track
      ? new Set(counts.track.filter(([, n]) => n > 0).map(([size]) => size))
      : null,
  };
}

/**
 * The facets of a scope under `visibility` (read it once with
 * getCatalogVisibility and pass the same value to listProducts). Spec facets
 * of restricted columns are absent; `track` only under Magnetic Track; a
 * category facet (main categories) only for area scopes. Groups with no
 * option are left out.
 */
export async function getFacets(
  scope: ListingScope,
  visibility: VisibilityByKey,
): Promise<ListingFacets> {
  const resolved = await resolveScope(scope);
  if (resolved === null) return { total: 0, groups: [] };
  const mains =
    resolved.scope.kind === "area" ? mainCategorySubtreesIn(resolved.tree) : [];
  const counts = await countsFor(resolved, visibility);

  const groups: FacetGroup[] = [];
  const push = (param: ListingFacetParam, options: FacetOption[]) => {
    const present = options.filter((entry) => entry.count > 0);
    if (present.length > 0) {
      groups.push({ param, label: FACET_LABELS[param], options: present });
    }
  };
  if (counts.categories) {
    const byId = new Map(counts.categories);
    push(
      "cat",
      mains.map((main) => ({
        value: main.slug,
        label: main.name,
        count: byId.get(main.id) ?? 0,
      })),
    );
  }
  if (counts.track) {
    push(
      "track",
      counts.track.map(([size, n]) => option("track", String(size), n)),
    );
  }
  for (const param of ["cct", "cri", "beam", "ugr", "w", "ip"] as const) {
    if (param === "w") {
      if (!counts.wattage) continue;
      const byId = new Map(counts.wattage);
      push(
        "w",
        WATTAGE_BUCKETS.map((bucket) =>
          option("w", bucket.id, byId.get(bucket.id) ?? 0),
        ),
      );
      continue;
    }
    const values = counts.numeric[param];
    if (values) {
      push(
        param,
        values
          .slice(0, MAX_FACET_OPTIONS)
          .map(([value, n]) => option(param, String(value), n)),
      );
    }
  }
  return { total: counts.total, groups };
}
