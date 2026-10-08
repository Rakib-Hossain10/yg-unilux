// The request side shared by the listing routes (/products/..., /areas/<slug>,
// ADR 0065): the bounded query string a request's listing keys reduce to, the
// per-request loader (React `cache`, so generateMetadata and the page share
// one load), and the read itself: parse the query for the scope and the
// column visibility, then cards and facets in parallel. Cards and facets hold
// no spec value, so nothing restricted can reach a page through here.

import "server-only";

import { cache } from "react";

import { getFacets, type ListingFacets } from "@/lib/catalog/facets";
import { listProducts, type ListingResult } from "@/lib/catalog/listing";
import {
  parseListingParams,
  publicSpecFacets,
} from "@/lib/catalog/listing-params";
import type { ListingScope } from "@/lib/catalog/listing-scope";
import type { VisibilityByKey } from "@/lib/catalog/view";

/*
 * Never import @/lib/catalog/restricted, the session or next/headers here
 * (static guard in test/listing-page.test.ts).
 */

/** The only query keys a listing reads (listing-params), in canonical order. */
const LISTING_KEYS = [
  "cat",
  "track",
  "cct",
  "cri",
  "beam",
  "ugr",
  "w",
  "ip",
  "sort",
  "page",
] as const;
/* Raw values kept per key before parsing (the parser caps again). */
const MAX_RAW_VALUES = 16;

export type SearchParamsRecord = Record<string, string | string[] | undefined>;

/**
 * A stable string of the listing keys of a request's query (own keys only,
 * bounded): the per-request loader's key. Every other key is ignored.
 */
export function rawListingQuery(query: SearchParamsRecord): string {
  const out = new URLSearchParams();
  for (const key of LISTING_KEYS) {
    if (!Object.hasOwn(query, key)) continue;
    const value = query[key];
    const list =
      value === undefined ? [] : Array.isArray(value) ? value : [value];
    for (const entry of list.slice(0, MAX_RAW_VALUES)) {
      if (typeof entry === "string") out.append(key, entry);
    }
  }
  return out.toString();
}

/**
 * A once-per-request loader for a listing route: `load(scopeKey, queryKey)`
 * runs at most once per request for the same route key (the path, the area
 * slug) and listing query, however often metadata and page ask for it.
 */
export function listingLoader<T>(
  load: (scopeKey: string, queryKey: string) => Promise<T>,
): (scopeKey: string, query: SearchParamsRecord) => Promise<T> {
  const once = cache(load);
  return (scopeKey, query) => once(scopeKey, rawListingQuery(query));
}

/** One listing page and its facets. */
export interface ListingRead {
  result: ListingResult;
  facets: ListingFacets;
}

/**
 * The cards and facets of `scope` for a listing query. `visibility` is read
 * once per request (getCatalogVisibility) and used for the parse, the cards
 * and the facets alike. `track` keeps the track-size filter (Magnetic Track
 * scopes), `cat` the main-category filter (area scopes).
 */
export async function readListing(
  scope: ListingScope,
  queryKey: string,
  visibility: VisibilityByKey,
  options: { track: boolean; cat: boolean },
): Promise<ListingRead> {
  const params = parseListingParams(new URLSearchParams(queryKey), {
    publicFacets: publicSpecFacets(visibility),
    track: options.track,
    cat: options.cat,
  });
  const [result, facets] = await Promise.all([
    listProducts(scope, params, visibility),
    getFacets(scope, visibility),
  ]);
  return { result, facets };
}
