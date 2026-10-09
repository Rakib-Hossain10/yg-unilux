// The query a listing filter form submits, built in the browser when JS
// applies the form (router.replace) instead of a GET submit. Same canonical
// shape as serialiseListingParams (key order, comma lists, defaults left
// out, page dropped), without importing the Zod parser into the client
// bundle: the values are our own checkbox tokens, and the server parses the
// URL again anyway. A unit test pins it to serialiseListingParams.

import { MAX_SLUG_LENGTH } from "@/lib/slug";

/** Key order of a canonical listing query (listing-params SERIAL_ORDER). */
export const LISTING_QUERY_ORDER = [
  "cat",
  "track",
  "cct",
  "cri",
  "beam",
  "ugr",
  "w",
  "ip",
] as const;

/**
 * A token that can never need escaping beyond encodeURIComponent. As long as
 * the longest category slug, so a long `cat` value is never dropped here
 * while the server's parser accepts it.
 */
const TOKEN = new RegExp(`^[a-z0-9.+-]{1,${MAX_SLUG_LENGTH}}$`);

/**
 * The canonical query string ("" for the default listing) of a filter form's
 * entries. Values keep the form's order (options are rendered ascending, so
 * it is the canonical order), duplicates are dropped, and anything that is
 * not a plain token is ignored. `sort=catalog` and `page` are left out.
 */
export function formQuery(
  entries: Iterable<readonly [string, FormDataEntryValue]>,
): string {
  const values = new Map<string, string[]>();
  let sort: string | null = null;
  for (const [key, raw] of entries) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (key === "sort") {
      if (TOKEN.test(value) && value !== "catalog") sort = value;
      continue;
    }
    if (!(LISTING_QUERY_ORDER as readonly string[]).includes(key)) continue;
    if (!TOKEN.test(value)) continue;
    const list = values.get(key) ?? [];
    if (!list.includes(value)) list.push(value);
    values.set(key, list);
  }
  const parts: string[] = [];
  for (const key of LISTING_QUERY_ORDER) {
    const list = values.get(key);
    if (list && list.length > 0) {
      parts.push(`${key}=${list.map(encodeURIComponent).join(",")}`);
    }
  }
  if (sort !== null) parts.push(`sort=${sort}`);
  return parts.join("&");
}

/** `basePath` plus the form's query. */
export function formHref(
  basePath: string,
  entries: Iterable<readonly [string, FormDataEntryValue]>,
): string {
  const query = formQuery(entries);
  return query === "" ? basePath : `${basePath}?${query}`;
}
