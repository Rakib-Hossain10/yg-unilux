// URLs of the access-request queue. The tab, page and notice are the only
// query values; each is read back from a fixed list, so a crafted URL can't
// put its own text on the page.

import { NOTICE_PARAM, type SaveNotice } from "../save-notice";

export const ACCESS_REQUESTS_PATH = "/admin/access-requests";

export const REQUEST_TABS = ["pending", "handled"] as const;
export type RequestTab = (typeof REQUEST_TABS)[number];

/** The tab in a search param value; anything else is "pending". */
export function readTab(value: unknown): RequestTab {
  return value === "handled" ? "handled" : "pending";
}

/** A page number from a search param value (1 when missing or invalid). */
export function readPage(value: unknown): number {
  const page = typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(page) && page >= 1 && page <= 1000 ? page : 1;
}

/** The list URL; the defaults (pending, page 1) are left out. */
export function accessRequestsListPath({
  tab = "pending",
  page = 1,
  notice,
}: {
  tab?: RequestTab;
  page?: number;
  notice?: SaveNotice;
} = {}): string {
  const params = new URLSearchParams();
  if (tab !== "pending") params.set("tab", tab);
  if (page > 1) params.set("page", String(page));
  if (notice) params.set(NOTICE_PARAM, notice);
  const query = params.toString();
  return query ? `${ACCESS_REQUESTS_PATH}?${query}` : ACCESS_REQUESTS_PATH;
}

/** One request's page (ids are 24 hex characters; anything else 404s). */
export function accessRequestPath(id: string, notice?: SaveNotice): string {
  const path = `${ACCESS_REQUESTS_PATH}/${encodeURIComponent(id)}`;
  return notice ? `${path}?${NOTICE_PARAM}=${notice}` : path;
}
