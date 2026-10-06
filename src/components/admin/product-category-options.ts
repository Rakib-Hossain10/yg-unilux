// The category choices offered by the products module (the new-product picker,
// the list's category filter, the edit form): main categories in display order,
// each followed by its subcategories as "Main › Sub". Only ids and labels.
// Server-side only (it reads the service's Magnetic Track slug).

import type { CategoryTreeNode } from "@/lib/admin/categories";
import { MAGNETIC_TRACK_SLUG } from "@/lib/admin/products";

import type { CategoryOption } from "./product-new-form";

export function categoryOptions(tree: CategoryTreeNode[]): CategoryOption[] {
  return tree.flatMap((main) => [
    { id: main.id, label: main.name },
    ...main.children.map((child) => ({
      id: child.id,
      label: `${main.name} › ${child.name}`,
    })),
  ]);
}

/**
 * The ids of Magnetic Track and its subcategories, so the edit form shows the
 * track-size field only where the service accepts one. Same rule as the
 * service (ADR 0041): a main category with slug `magnetic-track` or the name
 * "Magnetic Track" (any case).
 */
export function magneticTrackIds(tree: CategoryTreeNode[]): string[] {
  return tree
    .filter(
      (main) =>
        main.parentId === null &&
        (main.slug === MAGNETIC_TRACK_SLUG ||
          main.name.trim().toLowerCase() === "magnetic track"),
    )
    .flatMap((main) => [main.id, ...main.children.map((child) => child.id)]);
}
