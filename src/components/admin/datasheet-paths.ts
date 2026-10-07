// Routes of the datasheets module, in one place for the page and its links.

export const DATASHEETS_PATH = "/admin/datasheets";

/** Rows per page on the datasheets list. */
export const DATASHEETS_PAGE_SIZE = 25;

export interface DatasheetListQuery {
  q: string;
  page: number;
}

/** The list URL for a search and page (defaults left out). */
export function datasheetsListPath({ q, page }: DatasheetListQuery): string {
  const params = new URLSearchParams();
  if (q !== "") params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query === "" ? DATASHEETS_PATH : `${DATASHEETS_PATH}?${query}`;
}

/**
 * Filters and pages the (already loaded) datasheets: case-insensitive match on
 * the file name, newest first as given. Pure, for the page and the tests.
 */
export function pageDatasheets<T extends { fileName: string }>(
  rows: readonly T[],
  { q, page }: DatasheetListQuery,
): { rows: T[]; total: number; page: number; pageCount: number } {
  const needle = q.trim().toLowerCase();
  const matching =
    needle === ""
      ? [...rows]
      : rows.filter((row) => row.fileName.toLowerCase().includes(needle));
  const pageCount = Math.max(
    1,
    Math.ceil(matching.length / DATASHEETS_PAGE_SIZE),
  );
  const current = Math.min(Math.max(1, page), pageCount);
  const start = (current - 1) * DATASHEETS_PAGE_SIZE;
  return {
    rows: matching.slice(start, start + DATASHEETS_PAGE_SIZE),
    total: matching.length,
    page: current,
    pageCount,
  };
}
