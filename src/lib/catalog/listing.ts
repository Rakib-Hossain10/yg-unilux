// Cached product listings (ADR 0065): one page of cards for a scope and a
// canonical filter set. The column visibility is read outside the cache and
// is part of every key; cards carry no spec value. Never reads a session.

import "server-only";

import type { PipelineStage } from "mongoose";
import { unstable_cache } from "next/cache";

import { getColumnVisibility } from "@/lib/column-visibility";
import { connectDb } from "@/lib/db";
import { CATALOG_TAGS } from "@/lib/revalidate";
import { ProductModel } from "@/models";
import { restrictedSpecKeys } from "@/models/spec-columns";

import { CATALOG_CACHE_VERSION } from "./cache-version";
import { knownFilterValues, type KnownFilterValues } from "./facets";
import {
  listingFilterKey,
  NUMERIC_FACET_PARAMS,
  parseListingParams,
  publicSpecFacets,
  serialiseListingParams,
  type ListingParams,
  type ListingSort,
} from "./listing-params";
import {
  facetsFromRestrictedKey,
  listingMatch,
  resolveCatFilter,
  resolveScope,
  type ListingScope,
  type NormalisedScope,
  type ResolvedScope,
} from "./listing-scope";
import {
  PRODUCT_CARD_PROJECTION,
  toListingCardView,
  type ListingCardDoc,
  type ListingCardView,
  type VisibilityByKey,
} from "./view";

/** Cards per listing page (Q5). */
export const LISTING_PAGE_SIZE = 24;

/** One listing page. `page > pageCount` means "no such page" (the route 404s). */
export interface ListingResult {
  cards: ListingCardView[];
  total: number;
  /** The requested page (after parsing), even when out of range. */
  page: number;
  /** At least 1, so page 1 of an empty listing is valid (empty state). */
  pageCount: number;
  /**
   * The params actually applied: restricted, disallowed and unknown values
   * dropped, and values no product in the scope has dropped when the same
   * facet keeps another value. When EVERY selected value of a facet is one
   * no product has, that facet's values are kept as asked (so the chips
   * explain the empty result) and `total` is 0 (see narrowToKnownValues).
   */
  params: ListingParams;
}

/**
 * Narrows parsed params to the values the scope's published products have
 * (gate-A M-1). Facet counts cover the whole scope, so a value outside them
 * can only match nothing:
 * - within a facet (OR), such values are dropped when another selected value
 *   is known: the result is the same, and the URL/chips stay canonical;
 * - when every selected value of a facet is unknown, the AND across facets
 *   matches nothing: `impossible` is true and the facet keeps its values so
 *   the visitor sees which filter emptied the listing.
 * Values above a cut value list (`above`) are kept as unknown-but-possible.
 * Pure.
 */
export function narrowToKnownValues(
  params: ListingParams,
  known: KnownFilterValues,
): { params: ListingParams; impossible: boolean } {
  const next: ListingParams = { ...params };
  let impossible = false;
  const narrow = <T>(selected: T[], isKnown: (value: T) => boolean): T[] => {
    if (selected.length === 0) return selected;
    const kept = selected.filter(isKnown);
    if (kept.length > 0) return kept;
    impossible = true;
    return selected;
  };
  for (const param of NUMERIC_FACET_PARAMS) {
    const facet = known.numeric[param];
    // An absent facet was already dropped by the parse (restricted).
    if (facet === undefined) continue;
    next[param] = narrow(
      params[param],
      (value) =>
        facet.values.has(value) ||
        (facet.above !== null && value > facet.above),
    );
  }
  const wattage = known.wattage;
  if (wattage !== null) next.w = narrow(params.w, (id) => wattage.has(id));
  const track = known.track;
  if (track !== null) {
    next.track = narrow(params.track, (size) => track.has(size));
  }
  return { params: next, impossible };
}

/**
 * The column visibility for listing and facet calls, read fresh (one small
 * uncached read). Pass the same value to listProducts and getFacets.
 */
export async function getCatalogVisibility(): Promise<VisibilityByKey> {
  await connectDb();
  return getColumnVisibility();
}

/*
 * The filters inside a cached reader, rebuilt ONLY from the key arguments
 * (third guard after the page's parse and listProducts' re-parse).
 */
function filtersFromKey(
  scope: NormalisedScope,
  restrictedKeys: string,
  filterKey: string,
): ListingParams {
  return parseListingParams(new URLSearchParams(filterKey), {
    publicFacets: facetsFromRestrictedKey(restrictedKeys),
    track: scope.kind === "category",
  });
}

async function readListingCount(
  scope: NormalisedScope,
  restrictedKeys: string,
  filterKey: string,
  catIds: string[],
): Promise<number> {
  await connectDb();
  const params = filtersFromKey(scope, restrictedKeys, filterKey);
  return ProductModel.countDocuments(listingMatch(scope, params, catIds));
}

/* Stable orders (Q5): a unique `_id` last, so pages never overlap. */
const SORT_STAGES: Record<ListingSort, PipelineStage[]> = {
  // Sheet NO. first (products without one after those with one), then name.
  catalog: [
    {
      $addFields: {
        sortNoMissing: { $cond: [{ $isNumber: "$productNo" }, 0, 1] },
        sortName: { $toLower: "$name" },
      },
    },
    { $sort: { sortNoMissing: 1, productNo: 1, sortName: 1, _id: 1 } },
  ],
  name: [
    { $addFields: { sortName: { $toLower: "$name" } } },
    { $sort: { sortName: 1, _id: 1 } },
  ],
  newest: [{ $sort: { createdAt: -1, _id: -1 } }],
};

/*
 * Card fields only, plus the variant count computed on the server: no spec,
 * no variant, no filter value ever leaves the database.
 */
const LISTING_CARD_PROJECT: PipelineStage.Project["$project"] = {
  ...PRODUCT_CARD_PROJECTION,
  variantCount: { $size: { $ifNull: ["$variants", []] } },
};

async function readListingPage(
  scope: NormalisedScope,
  restrictedKeys: string,
  filterKey: string,
  catIds: string[],
  sort: ListingSort,
  page: number,
): Promise<ListingCardView[]> {
  await connectDb();
  const params = filtersFromKey(scope, restrictedKeys, filterKey);
  const docs = await ProductModel.aggregate<ListingCardDoc>([
    { $match: listingMatch(scope, params, catIds) },
    ...SORT_STAGES[sort],
    { $skip: (page - 1) * LISTING_PAGE_SIZE },
    { $limit: LISTING_PAGE_SIZE },
    { $project: LISTING_CARD_PROJECT },
  ]);
  return docs.map(toListingCardView);
}

/*
 * Keys: the normalised scope (known ids only), the restricted keys (sheet
 * order), the canonical filter string and the selected categories' ids.
 * Tags: product writes expire `products`; the tree and area list decide
 * which ids are valid (`categories`, `areas`); `settings:columns` drops
 * entries of an old visibility.
 */
const LISTING_TAGS = [
  CATALOG_TAGS.products,
  CATALOG_TAGS.categories,
  CATALOG_TAGS.areas,
  CATALOG_TAGS.settingsColumns,
];

const cachedListingCount = unstable_cache(
  readListingCount,
  ["catalog", "listing-count", CATALOG_CACHE_VERSION],
  { tags: LISTING_TAGS },
);

const cachedListingPage = unstable_cache(
  readListingPage,
  ["catalog", "listing-page", CATALOG_CACHE_VERSION],
  { tags: LISTING_TAGS },
);

/**
 * One page of published products in `scope` matching `params`. `params` is
 * re-parsed for this scope and `visibility` (a restricted facet, `track`
 * outside Magnetic Track and `cat` outside area pages are dropped), unknown
 * category slugs are dropped, values no product in the scope has are
 * dropped or answer an empty, uncached result (narrowToKnownValues), and a
 * page past the end is answered without a query or a cache entry.
 */
export async function listProducts(
  scope: ListingScope,
  params: ListingParams,
  visibility: VisibilityByKey,
): Promise<ListingResult> {
  const resolved = await resolveScope(scope);
  const applied = parseListingParams(
    new URLSearchParams(serialiseListingParams(params)),
    {
      publicFacets: publicSpecFacets(visibility),
      track: resolved?.trackApplies === true,
      cat: resolved?.scope.kind === "area",
    },
  );
  if (resolved === null) {
    return {
      cards: [],
      total: 0,
      page: applied.page,
      pageCount: 1,
      params: applied,
    };
  }
  const cat = resolveCatFilter(resolved.tree, applied.cat);
  applied.cat = cat.slugs;

  // Values no product in the scope has never reach a cache key (gate-A M-1).
  const narrowed = narrowToKnownValues(
    applied,
    await knownFilterValues(resolved, visibility),
  );
  if (narrowed.impossible) {
    // Uncached and without a query: the facet counts already prove it.
    return {
      cards: [],
      total: 0,
      page: narrowed.params.page,
      pageCount: 1,
      params: narrowed.params,
    };
  }
  return readPage(resolved, narrowed.params, cat.ids, visibility);
}

/* The cached count and page for already narrowed params. */
async function readPage(
  resolved: ResolvedScope,
  applied: ListingParams,
  catIds: string[],
  visibility: VisibilityByKey,
): Promise<ListingResult> {
  const restrictedKey = restrictedSpecKeys(visibility).join(",");
  const filterKey = listingFilterKey({ ...applied, cat: [] });
  const total = await cachedListingCount(
    resolved.scope,
    restrictedKey,
    filterKey,
    catIds,
  );
  const pageCount = Math.max(1, Math.ceil(total / LISTING_PAGE_SIZE));
  if (total === 0 || applied.page > pageCount) {
    return { cards: [], total, page: applied.page, pageCount, params: applied };
  }
  const cards = await cachedListingPage(
    resolved.scope,
    restrictedKey,
    filterKey,
    catIds,
    applied.sort,
    applied.page,
  );
  return { cards, total, page: applied.page, pageCount, params: applied };
}
