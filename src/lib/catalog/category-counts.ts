// Cached published-product counts per category (gate-A I-2): how many
// published products name a category as their main OR an extra category.
// Used to hide categories whose whole subtree has no published product (a
// draft-only category name would reveal an unreleased line). Counts only:
// no product field, no spec value, independent of column visibility. Never
// reads a session.

import "server-only";

import { unstable_cache } from "next/cache";

import { MAX_CATEGORY_DEPTH } from "@/lib/constants";
import { connectDb } from "@/lib/db";
import { CATALOG_TAGS } from "@/lib/revalidate";
import { ProductModel } from "@/models";

import { CATALOG_CACHE_VERSION } from "./cache-version";
import type { PublicCategoryView } from "./categories";

interface CountRow {
  _id: unknown;
  n: number;
}

/* [category id, published products naming it], one row per category. */
async function readPublishedCounts(): Promise<[string, number][]> {
  await connectDb();
  const rows = await ProductModel.aggregate<CountRow>([
    { $match: { status: "published" } },
    {
      $project: {
        _id: 0,
        c: {
          $setUnion: [
            { $ifNull: [["$mainCategory"], []] },
            { $ifNull: ["$extraCategories", []] },
          ],
        },
      },
    },
    { $unwind: "$c" },
    { $match: { c: { $ne: null } } },
    { $group: { _id: "$c", n: { $sum: 1 } } },
  ]);
  return rows.map((row): [string, number] => [String(row._id), row.n]);
}

/**
 * Published products per category id (direct, not subtree). One entry per
 * process for the whole catalogue (no argument), tagged `products` (a
 * publish/unpublish changes it) and `categories` (the tree it is read with).
 */
export const listPublishedCategoryCounts: () => Promise<[string, number][]> =
  unstable_cache(
    readPublishedCounts,
    ["catalog", "category-published-counts", CATALOG_CACHE_VERSION],
    { tags: [CATALOG_TAGS.products, CATALOG_TAGS.categories] },
  );

/**
 * The ids of categories whose subtree (itself or any descendant) holds at
 * least one published product. Pure over the given tree and counts; a
 * broken tree (cycle, too deep) is cut, never looped.
 */
export function categoriesWithPublished(
  tree: readonly PublicCategoryView[],
  counts: readonly (readonly [string, number])[],
): Set<string> {
  const known = new Set(tree.map((category) => category.id));
  const parentOf = new Map(
    tree.map((category) => [category.id, category.parentId]),
  );
  const result = new Set<string>();
  for (const [id, n] of counts) {
    if (n <= 0 || !known.has(id)) continue;
    // Mark the category and every ancestor.
    let current: string | null | undefined = id;
    for (
      let depth = 0;
      current && known.has(current) && depth <= MAX_CATEGORY_DEPTH;
      depth += 1
    ) {
      if (result.has(current)) break;
      result.add(current);
      current = parentOf.get(current);
    }
  }
  return result;
}
