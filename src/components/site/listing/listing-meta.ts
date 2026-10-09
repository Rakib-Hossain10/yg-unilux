// Titles and meta descriptions of listing pages. Only public category data
// (names, the admin's description) is used: no product data, no spec value.
// Pure.

const META_DESCRIPTION_MAX = 160;

/**
 * The meta description: the category's own description (whitespace
 * collapsed, cut at a word near 160 characters), else `fallback`.
 */
export function listingMetaDescription(
  description: string | null,
  fallback: string,
): string {
  const own = description?.replace(/\s+/g, " ").trim();
  if (!own) return fallback;
  if (own.length <= META_DESCRIPTION_MAX) return own;
  const cut = own.slice(0, META_DESCRIPTION_MAX - 1);
  const space = cut.lastIndexOf(" ");
  const kept = space > 80 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s.,;:–-]+$/, "")}…`;
}

/**
 * The document title: the category name ("Recessed – Spot Lights" for a
 * sub-category, so two "Recessed" pages differ), `root` without a path, and
 * "– page n" from page 2 on.
 */
export function listingMetaTitle(
  path: readonly { name: string }[],
  root: string,
  page: number,
): string {
  const last = path[path.length - 1];
  const first = path[0];
  const base =
    path.length >= 2 && last && first
      ? `${last.name} – ${first.name}`
      : (last?.name ?? root);
  return page > 1 ? `${base} – page ${page}` : base;
}
