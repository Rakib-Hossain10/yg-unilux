// Search UI helpers shared by the overlay (browser) and the /search page
// (server): result links, the answer parser for GET /api/catalog/search, and
// the count line. Pure and client-safe: no Zod, no server module (the
// header's script stays small); unit tests pin the constants to the server's.

/** The full results page (works without JavaScript). */
export const SEARCH_PATH = "/search";

/** The input's maxLength: MAX_SEARCH_LENGTH in src/lib/catalog/search.ts. */
export const SEARCH_INPUT_MAX_LENGTH = 64;

/** Type-ahead starts at this many characters (MIN_SEARCH_LENGTH). */
export const SEARCH_MIN_LENGTH = 2;

/* The product page's variant parameter (MODEL_PARAM in variant-selection.ts). */
const MODEL_PARAM = "model";

/** A product hit as the UI needs it (from SearchProductHit). */
export interface SearchProductLink {
  id: string;
  slug: string;
  name: string;
  family: string | null;
  modelCode: string | null;
  matchedModelNo: string | null;
  image: { publicId: string; alt: string | null } | null;
}

/** A category hit as the UI needs it (from SearchCategoryHit). */
export interface SearchCategoryLink {
  id: string;
  name: string;
  path: string[];
  slugPath: string[];
}

export interface SearchAnswer {
  query: string;
  products: SearchProductLink[];
  categories: SearchCategoryLink[];
}

/**
 * The product page of a hit; a model-no. hit opens that variant
 * (`/product/<slug>?model=<modelNo>`, ADR 0066 §8).
 */
export function searchProductHref(
  hit: Pick<SearchProductLink, "slug" | "matchedModelNo">,
): string {
  const base = `/product/${encodeURIComponent(hit.slug)}`;
  return hit.matchedModelNo
    ? `${base}?${MODEL_PARAM}=${encodeURIComponent(hit.matchedModelNo)}`
    : base;
}

/**
 * A category hit's listing path, `/products/<main>/<sub>` (the same URL
 * categoryListingPath builds; a test pins the two together).
 */
export function searchCategoryHref(
  hit: Pick<SearchCategoryLink, "slugPath">,
): string {
  if (hit.slugPath.length === 0) return "/products";
  return `/products/${hit.slugPath.map(encodeURIComponent).join("/")}`;
}

/** The results page for a query. */
export function searchPageHref(query: string): string {
  const q = query.trim();
  return q === "" ? SEARCH_PATH : `${SEARCH_PATH}?q=${encodeURIComponent(q)}`;
}

/** Whitespace collapsed and trimmed, as the server normalises it. */
export function tidyQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** True when the query is long enough to search. */
export function isSearchable(query: string): boolean {
  const length = [...tidyQuery(query)].length;
  return length >= SEARCH_MIN_LENGTH && length <= SEARCH_INPUT_MAX_LENGTH;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** "3 products and 1 category", or "No results". */
export function resultSummary(products: number, categories: number): string {
  if (products === 0 && categories === 0) return "No results";
  const parts: string[] = [];
  if (products > 0) parts.push(plural(products, "product", "products"));
  if (categories > 0) {
    parts.push(plural(categories, "category", "categories"));
  }
  return parts.join(" and ");
}

// ---------------------------------------------------------------------------
// Answer parsing (the browser never trusts the shape of a response)
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : null;

/* Only the fields the UI shows are copied: anything else is dropped. */
function toProduct(value: unknown): SearchProductLink | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const slug = str(value.slug);
  const name = str(value.name);
  if (!id || !slug || !name) return null;
  const image = isRecord(value.image) ? value.image : null;
  const publicId = image ? str(image.publicId) : null;
  return {
    id,
    slug,
    name,
    family: str(value.family),
    modelCode: str(value.modelCode),
    matchedModelNo: str(value.matchedModelNo),
    image: publicId ? { publicId, alt: image ? str(image.alt) : null } : null,
  };
}

function toCategory(value: unknown): SearchCategoryLink | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const name = str(value.name);
  const path = strings(value.path);
  const slugPath = strings(value.slugPath);
  if (!id || !name || !path || !slugPath || slugPath.length === 0) return null;
  return { id, name, path, slugPath };
}

/** The search route's JSON as a SearchAnswer, or null for any other shape. */
export function parseSearchAnswer(json: unknown): SearchAnswer | null {
  if (!isRecord(json) || typeof json.query !== "string") return null;
  if (!Array.isArray(json.products) || !Array.isArray(json.categories)) {
    return null;
  }
  return {
    query: json.query,
    products: json.products
      .map(toProduct)
      .filter((hit): hit is SearchProductLink => hit !== null),
    categories: json.categories
      .map(toCategory)
      .filter((hit): hit is SearchCategoryLink => hit !== null),
  };
}
