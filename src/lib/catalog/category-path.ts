// Category paths for listing URLs (ADR 0065): `/products/<main>/<sub>` is
// resolved on the cached category tree (sub slugs are unique only among
// siblings), giving the category, its breadcrumb and its subtree ids.

import "server-only";

import { MAX_CATEGORY_DEPTH } from "@/lib/constants";
import { MAX_SLUG_LENGTH, SLUG_PATTERN } from "@/lib/slug";
import { isMagneticTrackCategory } from "@/models/product-constants";

import { listPublicCategories, type PublicCategoryView } from "./categories";
import type { BreadcrumbItem } from "./view";

/** A resolved listing category. */
export interface CategoryPathView {
  category: BreadcrumbItem;
  /** Main category first, ending with `category`. */
  path: BreadcrumbItem[];
  /** The category and every descendant (depth-bounded), sorted. */
  subtreeIds: string[];
  /** Direct sub-categories in display order (the listing's sub links). */
  children: BreadcrumbItem[];
  /** The path's main category is Magnetic Track: the track facet applies. */
  isMagneticTrack: boolean;
}

/** A main category with its subtree (area page category facet / `cat`). */
export interface MainCategorySubtree extends BreadcrumbItem {
  subtreeIds: string[];
}

const item = (category: PublicCategoryView): BreadcrumbItem => ({
  id: category.id,
  name: category.name,
  slug: category.slug,
});

/* Children by parent id, in the tree's display order. */
function childrenIndex(
  tree: readonly PublicCategoryView[],
): Map<string, PublicCategoryView[]> {
  const index = new Map<string, PublicCategoryView[]>();
  for (const category of tree) {
    if (category.parentId === null) continue;
    const list = index.get(category.parentId) ?? [];
    list.push(category);
    index.set(category.parentId, list);
  }
  return index;
}

/*
 * The category and its descendants, at most MAX_CATEGORY_DEPTH levels deep
 * counted from the category. A cycle in damaged data is cut by `seen`, and
 * the category's own ancestors are never counted as its descendants.
 */
function subtreeOf(
  rootId: string,
  children: ReadonlyMap<string, readonly PublicCategoryView[]>,
  ancestors: readonly string[] = [],
): string[] {
  const seen = new Set<string>([...ancestors, rootId]);
  const found = new Set<string>([rootId]);
  let level = [rootId];
  for (let depth = 1; depth < MAX_CATEGORY_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const id of level) {
      for (const child of children.get(id) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        found.add(child.id);
        next.push(child.id);
      }
    }
    level = next;
  }
  return [...found].sort();
}

const isSlug = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MAX_SLUG_LENGTH &&
  SLUG_PATTERN.test(value);

/**
 * Resolves `[main]` or `[main, sub]` against a category tree. Null for an
 * empty or too-long path, a malformed slug, an unknown main slug, or a sub
 * slug that is not a child of that main category. Pure.
 */
export function resolveCategoryPathIn(
  tree: readonly PublicCategoryView[],
  slugs: readonly string[],
): CategoryPathView | null {
  if (slugs.length === 0 || slugs.length > MAX_CATEGORY_DEPTH) return null;
  if (!slugs.every(isSlug)) return null;
  const children = childrenIndex(tree);
  const main = tree.find(
    (category) => category.parentId === null && category.slug === slugs[0],
  );
  if (!main) return null;
  const chain: PublicCategoryView[] = [main];
  for (const slug of slugs.slice(1)) {
    const parent = chain[chain.length - 1] as PublicCategoryView;
    const child = (children.get(parent.id) ?? []).find(
      (candidate) => candidate.slug === slug,
    );
    // A child equal to an ancestor only exists in a damaged (cyclic) tree.
    if (!child || chain.some((step) => step.id === child.id)) return null;
    chain.push(child);
  }
  const category = chain[chain.length - 1] as PublicCategoryView;
  return {
    category: item(category),
    path: chain.map(item),
    subtreeIds: subtreeOf(
      category.id,
      children,
      chain.slice(0, -1).map((step) => step.id),
    ),
    children: (children.get(category.id) ?? [])
      .filter((child) => !chain.some((step) => step.id === child.id))
      .map(item),
    isMagneticTrack: isMagneticTrackCategory(main),
  };
}

/** The listing category for these path slugs (cached tree), or null. */
export async function resolveCategoryPath(
  slugs: readonly string[],
): Promise<CategoryPathView | null> {
  if (!Array.isArray(slugs)) return null;
  return resolveCategoryPathIn(await listPublicCategories(), slugs);
}

/**
 * Every listing path of a tree (main categories, then each one's children),
 * in display order. Pure.
 */
export function categoryPathsIn(
  tree: readonly PublicCategoryView[],
): string[][] {
  const children = childrenIndex(tree);
  const paths: string[][] = [];
  for (const main of tree) {
    if (main.parentId !== null) continue;
    paths.push([main.slug]);
    if (MAX_CATEGORY_DEPTH < 2) continue;
    for (const child of children.get(main.id) ?? []) {
      if (child.id !== main.id) paths.push([main.slug, child.slug]);
    }
  }
  return paths;
}

/** Every listing path (static params, sitemap), from the cached tree. */
export async function listCategoryPaths(): Promise<string[][]> {
  return categoryPathsIn(await listPublicCategories());
}

/** Main categories with their subtree ids, in display order. Pure. */
export function mainCategorySubtreesIn(
  tree: readonly PublicCategoryView[],
): MainCategorySubtree[] {
  const children = childrenIndex(tree);
  return tree
    .filter((category) => category.parentId === null)
    .map((main) => ({
      ...item(main),
      subtreeIds: subtreeOf(main.id, children),
    }));
}

/** Main categories with their subtree ids, from the cached tree. */
export async function listMainCategorySubtrees(): Promise<
  MainCategorySubtree[]
> {
  return mainCategorySubtreesIn(await listPublicCategories());
}

/**
 * True when every id lies under a Magnetic Track main category (the track
 * facet then applies). False for an empty list. Pure.
 */
export function isMagneticTrackScopeIn(
  tree: readonly PublicCategoryView[],
  ids: readonly string[],
): boolean {
  if (ids.length === 0) return false;
  const inTrack = new Set(
    mainCategorySubtreesIn(tree)
      .filter((main) =>
        isMagneticTrackCategory({ slug: main.slug, name: main.name }),
      )
      .flatMap((main) => main.subtreeIds),
  );
  return ids.every((id) => inTrack.has(id));
}
