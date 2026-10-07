// The ONE shared revalidation helper (CLAUDE.md, ADR 0008): every admin write
// expires the public catalog's cache tags through here. Tags are typed, so a
// caller cannot pass a free string; Server Actions and other callers differ.

import "server-only";

import { revalidateTag, updateTag } from "next/cache";

/*
 * Which Next.js function, per the installed docs (Next 16.3.7):
 * - `updateTag(tag)` (docs/01-app/03-api-reference/04-functions/updateTag.md)
 *   works ONLY inside Server Actions and throws anywhere else. It expires the
 *   tag at once, so the admin's next request waits for fresh data
 *   (read-your-own-writes).
 * - `revalidateTag(tag, profile)` (…/04-functions/revalidateTag.md) works in
 *   Server Functions and Route Handlers. With "max" it serves stale content
 *   while revalidating in the background. The one-argument form is deprecated.
 *
 * Admin services never call either: they return the tags they touched, and
 * the thin action (or route) passes them here (Phase 2 plan, ADR 0035 draft).
 */

/** The fixed catalog tags (ADR 0008). Use these, never string literals. */
export const CATALOG_TAGS = {
  products: "products",
  categories: "categories",
  areas: "areas",
  settingsColumns: "settings:columns",
  datasheets: "datasheets",
} as const;
type StaticCatalogTag = (typeof CATALOG_TAGS)[keyof typeof CATALOG_TAGS];

/*
 * "product:<id>" for one product page. Branded so it can only come from
 * productTag(); a plain `product:${string}` literal would not type-check.
 */
declare const productTagBrand: unique symbol;
export type ProductTag = `product:${string}` & {
  readonly [productTagBrand]: true;
};

/** A cache tag the catalog uses. */
export type CatalogTag = StaticCatalogTag | ProductTag;

/** A tag was malformed (only possible by casting past the types). */
export class InvalidCatalogTagError extends Error {
  override readonly name = "InvalidCatalogTagError";
}

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;
const PRODUCT_TAG = /^product:[0-9a-f]{24}$/;
const STATIC_TAGS: ReadonlySet<string> = new Set(Object.values(CATALOG_TAGS));

/**
 * The tag of one product page. Takes the id as a hex string or a Mongoose
 * ObjectId; throws InvalidCatalogTagError for anything else, so a typo can't
 * silently expire nothing.
 */
export function productTag(id: string | { toHexString(): string }): ProductTag {
  const hex = (typeof id === "string" ? id : id.toHexString()).toLowerCase();
  if (!OBJECT_ID_HEX.test(hex)) {
    throw new InvalidCatalogTagError("A product tag needs a product ObjectId");
  }
  return `product:${hex}` as ProductTag;
}

/** The product list tag plus the product's own tag: what a product write touches. */
export function productTags(
  id: string | { toHexString(): string },
): CatalogTag[] {
  return [CATALOG_TAGS.products, productTag(id)];
}

/** The tags without repeats, in first-seen order. */
export function uniqueTags(tags: readonly CatalogTag[]): CatalogTag[] {
  return [...new Set(tags)];
}

/*
 * De-duplicates and re-checks every tag at runtime before anything is
 * expired, so one forged tag (cast past the types) fails the whole call
 * instead of leaving half the tags expired.
 */
function checkedTags(tags: readonly CatalogTag[]): CatalogTag[] {
  const unique = uniqueTags(tags);
  for (const tag of unique) {
    if (!STATIC_TAGS.has(tag) && !PRODUCT_TAG.test(tag)) {
      throw new InvalidCatalogTagError("Unknown catalog cache tag");
    }
  }
  return unique;
}

/**
 * For admin Server Actions only: expires each tag with `updateTag`, so the
 * admin sees the change on their next request. Next throws if this runs
 * outside a Server Action; use revalidateCatalogFromRoute() there instead.
 */
export function revalidateCatalogInAction(tags: readonly CatalogTag[]): void {
  for (const tag of checkedTags(tags)) updateTag(tag);
}

/*
 * Tags that must never be served stale. Column visibility decides which spec
 * columns the cached projection leaves out (ADR 0002), so after a column is
 * made restricted, stale entries could still show its values (rule 9).
 */
const ALWAYS_IMMEDIATE: ReadonlySet<CatalogTag> = new Set([
  CATALOG_TAGS.settingsColumns,
]);

/** `{ expire: 0 }`: the next request is a blocking miss (revalidateTag.md). */
const EXPIRE_NOW = { expire: 0 } as const;

export interface RouteRevalidateOptions {
  /**
   * Expire every tag at once (`{ expire: 0 }`) instead of serving stale
   * content. Pass it for writes that REMOVE public data, e.g. unpublishing or
   * deleting a product from a job, so the old page is not shown meanwhile.
   */
  immediate?: boolean;
}

/**
 * For Route Handlers, cron and import jobs: marks each tag stale with
 * `revalidateTag(tag, "max")` (stale-while-revalidate, ADR 0008), except
 * `settings:columns` and any `immediate` call, which use `{ expire: 0 }`.
 */
export function revalidateCatalogFromRoute(
  tags: readonly CatalogTag[],
  options: RouteRevalidateOptions = {},
): void {
  for (const tag of checkedTags(tags)) {
    const now = options.immediate === true || ALWAYS_IMMEDIATE.has(tag);
    revalidateTag(tag, now ? EXPIRE_NOW : "max");
  }
}
