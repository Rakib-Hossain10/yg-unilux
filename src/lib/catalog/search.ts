// Catalog search (ADR 0006, 0066): published products by name, family, type
// and variant model no. (Atlas `$search`, escaped-regex fallback only when
// the stage throws) plus category name matches from the cached tree. Cards
// carry no spec value; never reads a session.

import "server-only";

import type { PipelineStage } from "mongoose";
import { unstable_cache } from "next/cache";

import { MAX_CATEGORY_DEPTH } from "@/lib/constants";
import { connectDb } from "@/lib/db";
import { CATALOG_TAGS } from "@/lib/revalidate";
import { ProductModel } from "@/models";
import { modelNoKey } from "@/models/product-constants";

import { CATALOG_CACHE_VERSION } from "./cache-version";
import { listPublicCategories, type PublicCategoryView } from "./categories";
import { PRODUCT_SEARCH_INDEX_NAME } from "./search-index";
import {
  PRODUCT_CARD_PROJECTION,
  toListingCardView,
  type ListingCardDoc,
  type ListingCardView,
} from "./view";

/** Shortest and longest normalised query that is searched. */
export const MIN_SEARCH_LENGTH = 2;
export const MAX_SEARCH_LENGTH = 64;
/** Most product and category hits one answer carries. */
export const MAX_PRODUCT_HITS = 12;
export const MAX_CATEGORY_HITS = 6;

/** A product hit: the listing card plus the model no. that matched, if any. */
export interface SearchProductHit extends ListingCardView {
  /**
   * The variant model no. (stored casing) the query equals or prefixes, or
   * null when the product matched on name, family or type only.
   */
  matchedModelNo: string | null;
}

/** A category whose name contains the query. */
export interface SearchCategoryHit {
  id: string;
  name: string;
  slug: string;
  /** Names from the main category down to this one (for display). */
  path: string[];
  /** Slugs in the same order (the `/products/<main>/<sub>` URL). */
  slugPath: string[];
}

export interface SearchResult {
  /** The normalised query ("" when it was too short or too long). */
  query: string;
  products: SearchProductHit[];
  categories: SearchCategoryHit[];
}

// ---------------------------------------------------------------------------
// Query normalisation
// ---------------------------------------------------------------------------

/* Control characters and ignorable code points (zero-width, soft hyphen). */
const INVISIBLE = /[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * NFKC, invisible characters removed, whitespace collapsed, trimmed. Returns
 * "" unless the result has MIN_SEARCH_LENGTH..MAX_SEARCH_LENGTH characters.
 * Pure.
 */
export function normaliseSearchQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // Never normalise an unbounded string: 4x the cap covers any real input.
  if (raw.length > MAX_SEARCH_LENGTH * 4) return "";
  const text = raw
    .normalize("NFKC")
    .replace(INVISIBLE, (char) => (/\s/.test(char) ? " " : ""))
    .replace(/\s+/g, " ")
    .trim();
  const length = [...text].length;
  return length >= MIN_SEARCH_LENGTH && length <= MAX_SEARCH_LENGTH ? text : "";
}

/** `text` with every regex metacharacter escaped (PCRE and JS alike). Pure. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Pipelines (pure builders)
// ---------------------------------------------------------------------------

/* Card fields, the variant count, and the model nos. ONLY to compute
 * `matchedModelNo` on the server (they never leave this module). */
const SEARCH_CARD_PROJECT: PipelineStage.Project["$project"] = {
  ...PRODUCT_CARD_PROJECTION,
  variantCount: { $size: { $ifNull: ["$variants", []] } },
  "variants.modelNo": 1,
};

/**
 * The Atlas pipeline. `status: published` is a compound `filter` (so drafts
 * never consume the hit limit) AND a `$match` after the stage (fails closed
 * if the index ever lost its `status` mapping). Exact model no. outranks a
 * model-no. prefix, which outranks name, family and type prefixes.
 */
export function buildAtlasSearchPipeline(query: string): PipelineStage[] {
  return [
    {
      $search: {
        index: PRODUCT_SEARCH_INDEX_NAME,
        compound: {
          filter: [{ equals: { path: "status", value: "published" } }],
          should: [
            {
              text: {
                query,
                path: "variants.modelNo",
                score: { boost: { value: 10 } },
              },
            },
            {
              autocomplete: {
                query,
                path: "variants.modelNo",
                score: { boost: { value: 5 } },
              },
            },
            {
              autocomplete: {
                query,
                path: "name",
                score: { boost: { value: 3 } },
              },
            },
            {
              autocomplete: {
                query,
                path: "family",
                score: { boost: { value: 2 } },
              },
            },
            { autocomplete: { query, path: "type" } },
          ],
          minimumShouldMatch: 1,
        },
      },
    },
    { $match: { status: "published" } },
    { $limit: MAX_PRODUCT_HITS },
    { $project: SEARCH_CARD_PROJECT },
  ];
}

/* True when any variant model no. matches `regex` (case-insensitive). */
function anyModelNoMatches(regex: string): Record<string, unknown> {
  return {
    $anyElementTrue: [
      {
        $map: {
          input: { $ifNull: ["$variants", []] },
          as: "variant",
          in: {
            $regexMatch: {
              input: { $ifNull: ["$$variant.modelNo", ""] },
              regex,
              options: "i",
            },
          },
        },
      },
    ],
  };
}

/**
 * The fallback pipeline: escaped, case-insensitive regexes over published
 * products (model no. anchored as a prefix; name, family and type contain).
 * Ranked exact model no. > model-no. prefix > name prefix > contains, ties
 * by name then id (stable), capped at MAX_PRODUCT_HITS.
 */
export function buildFallbackPipeline(query: string): PipelineStage[] {
  const escaped = escapeRegex(query);
  const contains = { $regex: escaped, $options: "i" };
  return [
    {
      $match: {
        status: "published",
        $or: [
          { "variants.modelNo": { $regex: `^${escaped}`, $options: "i" } },
          { name: contains },
          { family: contains },
          { type: contains },
        ],
      },
    },
    {
      $addFields: {
        searchRank: {
          $switch: {
            branches: [
              { case: anyModelNoMatches(`^${escaped}$`), then: 0 },
              { case: anyModelNoMatches(`^${escaped}`), then: 1 },
              {
                case: {
                  $regexMatch: {
                    input: { $ifNull: ["$name", ""] },
                    regex: `^${escaped}`,
                    options: "i",
                  },
                },
                then: 2,
              },
            ],
            default: 3,
          },
        },
        sortName: { $toLower: "$name" },
      },
    },
    { $sort: { searchRank: 1, sortName: 1, _id: 1 } },
    { $limit: MAX_PRODUCT_HITS },
    { $project: SEARCH_CARD_PROJECT },
  ];
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

type SearchDoc = ListingCardDoc & { variants?: { modelNo?: unknown }[] };

/**
 * The stored model no. the query equals (preferred) or prefixes, compared
 * like the unique index (ADR 0055). Pure.
 */
export function matchedModelNoOf(
  modelNos: readonly unknown[],
  query: string,
): string | null {
  const key = modelNoKey(query);
  const stored = modelNos.filter(
    (modelNo): modelNo is string => typeof modelNo === "string",
  );
  return (
    stored.find((modelNo) => modelNoKey(modelNo) === key) ??
    stored.find((modelNo) => modelNoKey(modelNo).startsWith(key)) ??
    null
  );
}

/* Card + matched model no.; the variants list itself is dropped here. */
function toHit(doc: SearchDoc, query: string): SearchProductHit {
  return {
    ...toListingCardView(doc),
    matchedModelNo: matchedModelNoOf(
      (doc.variants ?? []).map((variant) => variant.modelNo),
      query,
    ),
  };
}

/* Thrown inside the cache when `$search` fails, so nothing is cached. */
class AtlasSearchUnavailable extends Error {
  override readonly name = "AtlasSearchUnavailable";
  constructor(readonly reason: string) {
    super("Atlas Search unavailable");
  }
}

/* A safe description of a driver error: never the message (it can quote the query). */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const details = error as Error & { code?: unknown; codeName?: unknown };
  return [
    error.name,
    typeof details.codeName === "string" ? details.codeName : null,
    typeof details.code === "number" ? `code ${details.code}` : null,
  ]
    .filter((part) => part !== null)
    .join(" ");
}

async function readAtlasSearch(key: string): Promise<SearchProductHit[]> {
  await connectDb();
  let docs: SearchDoc[];
  try {
    docs = await ProductModel.aggregate<SearchDoc>(
      buildAtlasSearchPipeline(key),
    );
  } catch (error) {
    throw new AtlasSearchUnavailable(describeError(error));
  }
  return docs.map((doc) => toHit(doc, key));
}

/*
 * Keyed by the lowercased normalised query (results are case-insensitive)
 * and CATALOG_CACHE_VERSION. Product writes expire `products`; `categories`
 * as well, so a tree change refreshes every search answer.
 */
const cachedAtlasSearch = unstable_cache(
  readAtlasSearch,
  ["catalog", "search-products", CATALOG_CACHE_VERSION],
  { tags: [CATALOG_TAGS.products, CATALOG_TAGS.categories] },
);

async function readFallbackSearch(key: string): Promise<SearchProductHit[]> {
  await connectDb();
  const docs = await ProductModel.aggregate<SearchDoc>(
    buildFallbackPipeline(key),
  );
  return docs.map((doc) => toHit(doc, key));
}

/**
 * Published products for a normalised query. Atlas results are cached; the
 * regex fallback is not (a degraded mode must not outlive the outage in the
 * cache) and logs one warning without the query text.
 */
async function searchProducts(key: string): Promise<SearchProductHit[]> {
  try {
    return await cachedAtlasSearch(key);
  } catch (error) {
    if (!(error instanceof AtlasSearchUnavailable)) throw error;
    console.warn(
      `Catalog search: $search failed (${error.reason}); using the regex fallback (ADR 0006).`,
    );
    return readFallbackSearch(key);
  }
}

/* Names and slugs from the main category down to `category` (cycle-safe). */
function pathOf(
  category: PublicCategoryView,
  byId: ReadonlyMap<string, PublicCategoryView>,
): { names: string[]; slugs: string[] } {
  const names: string[] = [];
  const slugs: string[] = [];
  const seen = new Set<string>();
  let current: PublicCategoryView | undefined = category;
  while (
    current &&
    !seen.has(current.id) &&
    names.length < MAX_CATEGORY_DEPTH
  ) {
    seen.add(current.id);
    names.unshift(current.name);
    slugs.unshift(current.slug);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return { names, slugs };
}

/**
 * Categories whose name contains the query (case-insensitive), name prefixes
 * first, then tree order. Pure over the given tree.
 */
export function matchCategories(
  tree: readonly PublicCategoryView[],
  query: string,
): SearchCategoryHit[] {
  const needle = query.toLocaleLowerCase("en");
  const byId = new Map(tree.map((category) => [category.id, category]));
  return tree
    .map((category, index) => {
      const name = category.name.normalize("NFKC").toLocaleLowerCase("en");
      const at = name.indexOf(needle);
      return { category, index, rank: at === 0 ? 0 : at > 0 ? 1 : -1 };
    })
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, MAX_CATEGORY_HITS)
    .map(({ category }) => {
      const { names, slugs } = pathOf(category, byId);
      return {
        id: category.id,
        name: category.name,
        slug: category.slug,
        path: names,
        slugPath: slugs,
      };
    });
}

/**
 * Searches the public catalog. A query that normalises to "" (too short,
 * too long, not a string) answers an empty result without a query.
 */
export async function searchCatalog(raw: unknown): Promise<SearchResult> {
  const query = normaliseSearchQuery(raw);
  if (query === "") return { query: "", products: [], categories: [] };
  const key = query.toLocaleLowerCase("en");
  const [products, tree] = await Promise.all([
    searchProducts(key),
    listPublicCategories(),
  ]);
  return { query, products, categories: matchCategories(tree, key) };
}
