// The header's product menu data (Phase 4b L6): main categories with their
// sub-categories and icons, plus the application areas, from the cached
// catalog readers (tags `categories`, `products`, `areas`). Read once per
// render by the (site) and (account) layouts.
//
// Empty categories are hidden: a category shows only when its subtree holds
// at least one published product (category-counts.ts, the same rule as
// search, gate-A I-2), so a draft-only line never shows its name.
//
// Build-safe: without a database (the CI build, a fresh checkout) or during
// an outage the read fails, and the header falls back to plain links
// (`null`). A page prerendered in that state is re-rendered after
// MENU_RETRY_SECONDS instead of keeping the plain header until the next
// catalog write.

import "server-only";

import { unstable_cache } from "next/cache";

import { listPublicAreas } from "@/lib/catalog/areas";
import {
  listPublicCategories,
  type PublicCategoryView,
} from "@/lib/catalog/categories";
import {
  categoriesWithPublished,
  listPublishedCategoryCounts,
} from "@/lib/catalog/category-counts";
import type { PublicAreaView } from "@/lib/catalog/view";
import { EnvError } from "@/lib/env";

import { categoryIconUrl, siteCloudName } from "../cloudinary-image";
import { areaListingPath, categoryListingPath } from "../listing/listing-urls";
import type { MenuCategory, MenuLink, SiteMenu } from "./menu-types";

/** How soon a page prerendered without the menu is rendered again. */
export const MENU_RETRY_SECONDS = 60;

/**
 * The menu for a category tree, its published counts and the areas. Main
 * categories and their direct children keep the tree's display order; any
 * category whose subtree has no published product is left out. Pure.
 */
export function buildSiteMenu(
  tree: readonly PublicCategoryView[],
  counts: readonly (readonly [string, number])[],
  areas: readonly PublicAreaView[],
  cloudName: string | null,
): SiteMenu {
  const listed = categoriesWithPublished(tree, counts);
  const childrenOf = new Map<string, PublicCategoryView[]>();
  for (const category of tree) {
    if (category.parentId === null || !listed.has(category.id)) continue;
    const list = childrenOf.get(category.parentId) ?? [];
    list.push(category);
    childrenOf.set(category.parentId, list);
  }
  const categories: MenuCategory[] = tree
    .filter((main) => main.parentId === null && listed.has(main.id))
    .map((main) => ({
      id: main.id,
      name: main.name,
      href: categoryListingPath([main]),
      iconSrc: categoryIconUrl(cloudName, main.icon, "png"),
      description: main.description?.trim() ? main.description.trim() : null,
      children: (childrenOf.get(main.id) ?? [])
        .filter((child) => child.id !== main.id)
        .map((child): MenuLink => ({
          id: child.id,
          name: child.name,
          href: categoryListingPath([main, child]),
        })),
    }));
  return {
    categories,
    areas: areas.map((area) => ({
      id: area.id,
      name: area.name,
      href: areaListingPath(area),
    })),
  };
}

/* A tiny cached marker whose only job is its `revalidate`: read inside a
 * prerender, it shortens that page's lifetime to MENU_RETRY_SECONDS. */
const menuRetryMarker = unstable_cache(
  async () => true,
  ["site-menu", "retry"],
  { revalidate: MENU_RETRY_SECONDS },
);

/**
 * The menu, or null when the catalog cannot be read. A missing database
 * configuration (CI build) is expected and silent; any other failure logs
 * one warning with the error's name only.
 */
export async function loadSiteMenu(): Promise<SiteMenu | null> {
  try {
    const [tree, counts, areas] = await Promise.all([
      listPublicCategories(),
      listPublishedCategoryCounts(),
      listPublicAreas(),
    ]);
    return buildSiteMenu(tree, counts, areas, siteCloudName());
  } catch (error) {
    if (!(error instanceof EnvError)) {
      console.warn(
        `Site menu: catalog read failed (${error instanceof Error ? error.name : "unknown error"}); the header shows plain links.`,
      );
    }
    await menuRetryMarker().catch(() => undefined);
    return null;
  }
}
