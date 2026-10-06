// The admin URLs of the categories module, built in one place so the actions'
// redirects, the tree's links and the pages never disagree. The base comes
// from the module list (admin-sections.ts).

import { ADMIN_SECTIONS } from "./admin-sections";

export const CATEGORIES_PATH = ADMIN_SECTIONS.categories.href;
export const NEW_CATEGORY_PATH = `${CATEGORIES_PATH}/new`;

/** Edit page of one category. */
export function categoryEditPath(id: string): string {
  return `${CATEGORIES_PATH}/${encodeURIComponent(id)}`;
}

/** New-category page with the parent picker preset to `parentId`. */
export function newSubcategoryPath(parentId: string): string {
  return `${NEW_CATEGORY_PATH}?parent=${encodeURIComponent(parentId)}`;
}
