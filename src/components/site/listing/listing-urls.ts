// URL building for the listing pages (ADR 0065): category paths, and the
// links that change one thing in a listing query (remove a chip, clear the
// filters, go to a page). Every query comes from serialiseListingParams, so
// links are always canonical. Pure; used by Server Components and metadata.

import {
  countActiveFilters,
  DEFAULT_LISTING_PARAMS,
  facetValueLabel,
  FACET_LABELS,
  serialiseListingParams,
  type ListingFacetParam,
  type ListingParams,
} from "@/lib/catalog/listing-params";

/** The listing root. */
export const PRODUCTS_PATH = "/products";

/**
 * The listing path of a category from its path slugs, main category first:
 * `/products/<main>` or `/products/<main>/<sub>` (sub slugs repeat across
 * parents, so the parent is always part of the path).
 */
export function categoryListingPath(path: readonly { slug: string }[]): string {
  if (path.length === 0) return PRODUCTS_PATH;
  return `${PRODUCTS_PATH}/${path.map((step) => encodeURIComponent(step.slug)).join("/")}`;
}

/** `basePath` with the canonical query of `params` ("" query → no "?"). */
export function listingHref(basePath: string, params: ListingParams): string {
  const query = serialiseListingParams(params);
  return query === "" ? basePath : `${basePath}?${query}`;
}

/* A copy of the lists, so callers can never mutate the parsed params. */
function copyParams(params: ListingParams): ListingParams {
  return {
    ...params,
    cct: [...params.cct],
    cri: [...params.cri],
    beam: [...params.beam],
    ugr: [...params.ugr],
    ip: [...params.ip],
    w: [...params.w],
    track: [...params.track],
    cat: [...params.cat],
  };
}

/** The listing without one selected value (page back to 1). */
export function withoutValueHref(
  basePath: string,
  params: ListingParams,
  param: ListingFacetParam,
  value: string,
): string {
  const next = copyParams(params);
  // Each list holds numbers or strings; compare as URL tokens.
  (next[param] as (string | number)[]) = (
    params[param] as readonly (string | number)[]
  ).filter((entry) => String(entry) !== value);
  next.page = 1;
  return listingHref(basePath, next);
}

/** Every filter removed; the sort is kept, the page back to 1. */
export function clearFiltersHref(
  basePath: string,
  params: ListingParams,
): string {
  return listingHref(basePath, {
    ...DEFAULT_LISTING_PARAMS,
    cct: [],
    cri: [],
    beam: [],
    ugr: [],
    ip: [],
    w: [],
    track: [],
    cat: [],
    sort: params.sort,
  });
}

/** The same listing on another page. */
export function pageHref(
  basePath: string,
  params: ListingParams,
  page: number,
): string {
  return listingHref(basePath, { ...copyParams(params), page });
}

/** One removable active-filter chip. */
export interface FilterChip {
  param: ListingFacetParam;
  value: string;
  /** e.g. "3000K", "IP65", "Spot Lights". */
  label: string;
  /** The facet's name, e.g. "CCT" (for the remove link's accessible name). */
  facetLabel: string;
  /** The listing without this value. */
  href: string;
}

/** Chip order: the canonical query order. */
const CHIP_ORDER: readonly ListingFacetParam[] = [
  "cat",
  "track",
  "cct",
  "cri",
  "beam",
  "ugr",
  "w",
  "ip",
];

/**
 * The chips of the applied params. `categoryNames` maps `cat` slugs to their
 * names (area pages); an unknown slug shows as itself.
 */
export function filterChips(
  basePath: string,
  params: ListingParams,
  categoryNames: ReadonlyMap<string, string> = new Map(),
): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const param of CHIP_ORDER) {
    for (const entry of params[param] as readonly (string | number)[]) {
      const value = String(entry);
      chips.push({
        param,
        value,
        label:
          param === "cat"
            ? (categoryNames.get(value) ?? value)
            : facetValueLabel(param, value),
        facetLabel: FACET_LABELS[param],
        href: withoutValueHref(basePath, params, param, value),
      });
    }
  }
  return chips;
}

/** Any filter value or a non-default sort: the page is not indexed. */
export function isRefinedListing(params: ListingParams): boolean {
  return countActiveFilters(params) > 0 || params.sort !== "catalog";
}

/**
 * The canonical path of a listing page: the category path, plus `?page=n`
 * from page 2 on. Filters and sort are never part of it.
 */
export function listingCanonicalPath(basePath: string, page: number): string {
  return page > 1 ? `${basePath}?page=${page}` : basePath;
}

/** A page number, or a gap ("…") between non-adjacent numbers. */
export type PaginationItem = number | "gap";

/**
 * The page links to show: first, last, and the current page with one
 * neighbour each side; gaps where numbers are skipped. A gap of exactly one
 * page shows that page instead (a "…" hiding one number helps nobody).
 */
export function paginationItems(
  page: number,
  pageCount: number,
): PaginationItem[] {
  if (pageCount <= 1) return [];
  const shown = new Set<number>([1, pageCount, page - 1, page, page + 1]);
  const numbers = [...shown]
    .filter((n) => n >= 1 && n <= pageCount)
    .sort((a, b) => a - b);
  const items: PaginationItem[] = [];
  let previous = 0;
  for (const n of numbers) {
    if (n - previous === 2) items.push(n - 1);
    else if (n - previous > 2) items.push("gap");
    items.push(n);
    previous = n;
  }
  return items;
}
