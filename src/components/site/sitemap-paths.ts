// The catalog paths listed in /sitemap.xml besides the product pages (Phase
// 4b L6): the listing root, every category listing path that lists at least
// one published product (categoryListingPath, never a filtered URL), the
// applications index and every area page. Paths only: no spec value, no
// query string (filtered and sorted listings are noindex). Pure.

import "server-only";

import type { PublicCategoryView } from "@/lib/catalog/categories";
import { categoriesWithPublished } from "@/lib/catalog/category-counts";
import {
  categoryPathsIn,
  resolveCategoryPathIn,
} from "@/lib/catalog/category-path";
import type { PublicAreaView } from "@/lib/catalog/view";

import {
  AREAS_PATH,
  areaListingPath,
  categoryListingPath,
  PRODUCTS_PATH,
} from "./listing/listing-urls";

export function catalogSitemapPaths(
  tree: readonly PublicCategoryView[],
  counts: readonly (readonly [string, number])[],
  areas: readonly Pick<PublicAreaView, "slug">[],
): string[] {
  const listed = categoriesWithPublished(tree, counts);
  const categories = categoryPathsIn(tree).flatMap((slugs) => {
    const resolved = resolveCategoryPathIn(tree, slugs);
    return resolved && listed.has(resolved.category.id)
      ? [categoryListingPath(resolved.path)]
      : [];
  });
  return [
    PRODUCTS_PATH,
    ...categories,
    AREAS_PATH,
    ...areas.map((area) => areaListingPath(area)),
  ];
}
