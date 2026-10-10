// URLs of the customers module. The search, status, sort, page and notice are
// the only query values; each is read back from a fixed list (or trimmed and
// capped), so a crafted URL can't put its own text on the page. Client-safe.

import {
  CUSTOMER_SORTS,
  CUSTOMER_STATUS_FILTERS,
  MAX_CUSTOMER_SEARCH_LENGTH,
  type CustomerSort,
  type CustomerStatusFilter,
} from "@/lib/schemas/customer";

import { NOTICE_PARAM, type SaveNotice } from "../save-notice";

export const CUSTOMERS_PATH = "/admin/customers";
export const NEW_CUSTOMER_PATH = `${CUSTOMERS_PATH}/new`;

/** The default list order: newest accounts first. */
export const DEFAULT_SORT: CustomerSort = "created";

/* One search-param value as a string ("" when missing or repeated). */
function single(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The search text from `?q=`: trimmed and capped like the service does. */
export function readSearch(value: unknown): string {
  return single(value).trim().slice(0, MAX_CUSTOMER_SEARCH_LENGTH).trim();
}

/** A known status filter, or null (all customers). */
export function readStatus(value: unknown): CustomerStatusFilter | null {
  const text = single(value);
  return (CUSTOMER_STATUS_FILTERS as readonly string[]).includes(text)
    ? (text as CustomerStatusFilter)
    : null;
}

/** A known sort, or the default. */
export function readSort(value: unknown): CustomerSort {
  const text = single(value);
  return (CUSTOMER_SORTS as readonly string[]).includes(text)
    ? (text as CustomerSort)
    : DEFAULT_SORT;
}

/** A page number from a search param value (1 when missing or invalid). */
export function readPage(value: unknown): number {
  const text = single(value);
  if (!/^[1-9]\d{0,3}$/.test(text)) return 1;
  const page = Number(text);
  return page <= 1000 ? page : 1;
}

export interface CustomerListQuery {
  q?: string;
  status?: CustomerStatusFilter | null;
  sort?: CustomerSort;
  page?: number;
  notice?: SaveNotice;
}

/** The list URL; the defaults (no search, all, newest, page 1) are left out. */
export function customersListPath({
  q = "",
  status = null,
  sort = DEFAULT_SORT,
  page = 1,
  notice,
}: CustomerListQuery = {}): string {
  const params = new URLSearchParams();
  if (q !== "") params.set("q", q);
  if (status !== null) params.set("status", status);
  if (sort !== DEFAULT_SORT) params.set("sort", sort);
  if (page > 1) params.set("page", String(page));
  if (notice) params.set(NOTICE_PARAM, notice);
  const query = params.toString();
  return query ? `${CUSTOMERS_PATH}?${query}` : CUSTOMERS_PATH;
}

/**
 * One customer's page (ids are 24 hex characters; anything else 404s), with
 * an optional download-history page.
 */
export function customerPath(id: string, page = 1): string {
  const path = `${CUSTOMERS_PATH}/${encodeURIComponent(id)}`;
  return page > 1 ? `${path}?page=${page}` : path;
}
