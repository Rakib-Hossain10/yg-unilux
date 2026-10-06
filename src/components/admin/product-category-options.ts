// The category choices offered by the products module (the new-product picker
// and the list's category filter): main categories in display order, each
// followed by its subcategories as "Main › Sub". Only ids and labels.

import type { CategoryTreeNode } from "@/lib/admin/categories";

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
