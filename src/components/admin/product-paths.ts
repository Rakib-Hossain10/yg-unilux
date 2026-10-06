// The admin URLs of the products module, built in one place so the actions'
// redirects, the table's links, the filters and the pager never disagree.
// The base comes from the module list (admin-sections.ts).

import { ADMIN_SECTIONS } from "./admin-sections";

export const PRODUCTS_PATH = ADMIN_SECTIONS.products.href;
export const NEW_PRODUCT_PATH = `${PRODUCTS_PATH}/new`;

/** Edit page of one product (arrives in T10). */
export function productEditPath(id: string): string {
  return `${PRODUCTS_PATH}/${encodeURIComponent(id)}`;
}

/** The list filters as they appear in the URL; absent = not filtered. */
export interface ProductListQuery {
  q?: string;
  status?: string;
  category?: string;
  page?: number;
}

/**
 * The list URL for a set of filters. Empty values and page 1 are left out,
 * so the plain list is just /admin/products and no `?notice=` is carried
 * over from an earlier redirect.
 */
export function productsListPath(query: ProductListQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status) params.set("status", query.status);
  if (query.category) params.set("category", query.category);
  if (query.page !== undefined && query.page > 1) {
    params.set("page", String(query.page));
  }
  const search = params.toString();
  return search === "" ? PRODUCTS_PATH : `${PRODUCTS_PATH}?${search}`;
}
