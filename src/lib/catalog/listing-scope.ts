// Listing scopes and the MongoDB match they and the filters build (ADR 0065):
// all products, a category subtree (main OR extra category), or one area;
// published only. Shared by listing.ts and facets.ts. No session, no cache.

import "server-only";

import { Types } from "mongoose";

import { OBJECT_ID_PATTERN } from "@/lib/schemas/common";

import { listPublicAreas } from "./areas";
import { listPublicCategories, type PublicCategoryView } from "./categories";
import {
  isMagneticTrackScopeIn,
  mainCategorySubtreesIn,
} from "./category-path";
import {
  FACET_FILTER_KEY,
  FACET_SPEC_KEY,
  NUMERIC_FACET_PARAMS,
  SPEC_FACET_PARAMS,
  WATTAGE_BUCKETS,
  type ListingParams,
  type SpecFacetParam,
} from "./listing-params";

/** What a listing lists. Category ids = the category's whole subtree. */
export type ListingScope =
  | { kind: "all" }
  | { kind: "category"; ids: readonly string[] }
  | { kind: "area"; areaId: string };

/** A scope with valid, lowercased, sorted, deduped ids (a cache argument). */
export type NormalisedScope =
  | { kind: "all" }
  | { kind: "category"; ids: string[] }
  | { kind: "area"; areaId: string };

/** Most category ids one scope may carry (a subtree is far smaller). */
export const MAX_SCOPE_CATEGORY_IDS = 200;

const isId = (value: unknown): value is string =>
  typeof value === "string" && OBJECT_ID_PATTERN.test(value);

/** Sorted, deduped, lowercased valid ids, at most `max`. */
export function normaliseIds(ids: readonly unknown[], max: number): string[] {
  return [...new Set(ids.filter(isId).map((id) => id.toLowerCase()))]
    .sort()
    .slice(0, max);
}

/**
 * The canonical form of a scope, or null when it can match nothing (no valid
 * category id, a malformed area id, an unknown kind).
 */
export function normaliseScope(scope: ListingScope): NormalisedScope | null {
  switch (scope?.kind) {
    case "all":
      return { kind: "all" };
    case "category": {
      if (!Array.isArray(scope.ids)) return null;
      const ids = normaliseIds(scope.ids, MAX_SCOPE_CATEGORY_IDS);
      return ids.length > 0 ? { kind: "category", ids } : null;
    }
    case "area":
      return isId(scope.areaId)
        ? { kind: "area", areaId: scope.areaId.toLowerCase() }
        : null;
    default:
      return null;
  }
}

/**
 * The spec facets that are public for the comma-joined restricted keys of a
 * cache key (the gate-A M-1 pattern: a cached reader derives visibility ONLY
 * from its key argument). An unknown name can only take a facet away.
 */
export function facetsFromRestrictedKey(
  restrictedKeys: string,
): SpecFacetParam[] {
  const restricted = new Set(restrictedKeys.split(","));
  return SPEC_FACET_PARAMS.filter(
    (param) => !restricted.has(FACET_SPEC_KEY[param]),
  );
}

/**
 * The `cat` filter of an area page: the selected main categories that exist
 * (unknown slugs dropped) and the union of their subtree ids.
 */
export function resolveCatFilter(
  tree: readonly PublicCategoryView[],
  slugs: readonly string[],
): { slugs: string[]; ids: string[] } {
  if (slugs.length === 0) return { slugs: [], ids: [] };
  const chosen = mainCategorySubtreesIn(tree).filter((main) =>
    slugs.includes(main.slug),
  );
  return {
    slugs: chosen.map((main) => main.slug).sort(),
    ids: normaliseIds(
      chosen.flatMap((main) => main.subtreeIds),
      MAX_SCOPE_CATEGORY_IDS,
    ),
  };
}

/** A scope checked against the cached tree and area list. */
export interface ResolvedScope {
  scope: NormalisedScope;
  /** The category tree it was checked against (for `cat` and names). */
  tree: PublicCategoryView[];
  /** The scope lies under Magnetic Track: `track` filters and facets apply. */
  trackApplies: boolean;
}

/**
 * Normalises a scope and keeps only ids that exist (categories in the cached
 * tree, the area in the cached area list), so a cache key can only ever hold
 * known ids. Null when nothing is left: the listing is empty.
 */
export async function resolveScope(
  scope: ListingScope,
): Promise<ResolvedScope | null> {
  const normal = normaliseScope(scope);
  if (normal === null) return null;
  const tree = await listPublicCategories();
  switch (normal.kind) {
    case "all":
      return { scope: normal, tree, trackApplies: false };
    case "category": {
      const known = new Set(tree.map((category) => category.id));
      const ids = normal.ids.filter((id) => known.has(id));
      if (ids.length === 0) return null;
      return {
        scope: { kind: "category", ids },
        tree,
        trackApplies: isMagneticTrackScopeIn(tree, ids),
      };
    }
    case "area": {
      const areas = await listPublicAreas();
      if (!areas.some((area) => area.id === normal.areaId)) return null;
      return { scope: normal, tree, trackApplies: false };
    }
  }
}

const objectIds = (ids: readonly string[]) =>
  ids.map((id) => new Types.ObjectId(id));

/** Main OR extra category in `ids` (Q4: a product shows under both). */
export function inCategories(ids: readonly string[]): Record<string, unknown> {
  const list = objectIds(ids);
  return {
    $or: [{ mainCategory: { $in: list } }, { extraCategories: { $in: list } }],
  };
}

/** Published products in the scope. */
export function scopeMatch(scope: NormalisedScope): Record<string, unknown> {
  switch (scope.kind) {
    case "all":
      return { status: "published" };
    case "category":
      return { status: "published", ...inCategories(scope.ids) };
    case "area":
      return {
        status: "published",
        areas: new Types.ObjectId(scope.areaId),
      };
  }
}

/** A `filters.wattage` element condition for one bucket. */
export function wattageRange(
  bucket: (typeof WATTAGE_BUCKETS)[number],
): Record<string, number> {
  const range: Record<string, number> = {};
  if (bucket.gt !== null) range.$gt = bucket.gt;
  if (bucket.lte !== null) range.$lte = bucket.lte;
  return range;
}

/**
 * The scope match plus the filters: OR within a facet, AND across facets.
 * `params` must already be parsed for this scope and visibility; `catIds`
 * is the union of the selected main categories' subtrees (area pages).
 */
export function listingMatch(
  scope: NormalisedScope,
  params: ListingParams,
  catIds: readonly string[],
): Record<string, unknown> {
  const and: Record<string, unknown>[] = [scopeMatch(scope)];
  for (const param of NUMERIC_FACET_PARAMS) {
    const values = params[param];
    if (values.length === 0) continue;
    and.push({ [`filters.${FACET_FILTER_KEY[param]}`]: { $in: [...values] } });
  }
  if (params.w.length > 0) {
    and.push({
      $or: WATTAGE_BUCKETS.filter((bucket) => params.w.includes(bucket.id)).map(
        (bucket) => ({
          "filters.wattage": { $elemMatch: wattageRange(bucket) },
        }),
      ),
    });
  }
  if (params.track.length > 0) {
    and.push({ trackSize: { $in: [...params.track] } });
  }
  if (catIds.length > 0) and.push(inCategories(catIds));
  return and.length === 1 ? (and[0] as Record<string, unknown>) : { $and: and };
}
