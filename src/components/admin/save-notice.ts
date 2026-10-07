// The "saved" notice an admin list page shows after a create/edit/delete
// redirect (e.g. /admin/categories?notice=created). Only these fixed keys are
// read back, so a crafted URL can never put its own text on the page.

export const NOTICE_PARAM = "notice";

export const SAVE_NOTICES = [
  "created",
  "updated",
  "unchanged",
  "deleted",
] as const;
export type SaveNotice = (typeof SAVE_NOTICES)[number];

/**
 * `path` with the notice in the query string, for a redirect after a write.
 * Takes a bare path only: a path that already had a query or a hash would
 * come out malformed, so that is refused as a programming error.
 */
export function withNotice(path: string, notice: SaveNotice): string {
  if (/[?#]/.test(path)) {
    throw new TypeError("withNotice() takes a path without a query or hash");
  }
  return `${path}?${NOTICE_PARAM}=${notice}`;
}

/**
 * The notice in a search param value, or null for anything that is not one
 * of the fixed keys (missing, repeated, misspelt or crafted).
 */
export function readNotice(value: unknown): SaveNotice | null {
  return typeof value === "string" &&
    (SAVE_NOTICES as readonly string[]).includes(value)
    ? (value as SaveNotice)
    : null;
}
