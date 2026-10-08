// The Atlas Search index on `products` (ADR 0006, 0066): its name, its
// definition (PUBLIC fields only: name, family, type, variant model nos.,
// status; never a spec, filter or datasheet field, ADR 0002) and the
// idempotent create/update logic used by `npm run db:search-index`.

import "server-only";

/** The search index name `$search` queries (and the script maintains). */
export const PRODUCT_SEARCH_INDEX_NAME = "products_search";

/* Lowercase keyword: the whole model no. as one case-insensitive token. */
const LOWERCASE_KEYWORD = "lowercaseKeyword";

/* Word prefixes for free text (names, families, types). */
const textField = [
  { type: "string", analyzer: "lucene.standard" },
  {
    type: "autocomplete",
    tokenization: "edgeGram",
    minGrams: 2,
    maxGrams: 15,
    foldDiacritics: true,
  },
] as const;

/**
 * The index definition. `dynamic: false`, so a field not listed here (every
 * spec column, filters, datasheetId) is never indexed and can never match.
 */
export const PRODUCT_SEARCH_INDEX_DEFINITION = {
  analyzer: "lucene.standard",
  searchAnalyzer: "lucene.standard",
  analyzers: [
    {
      name: LOWERCASE_KEYWORD,
      tokenizer: { type: "keyword" },
      tokenFilters: [{ type: "lowercase" }],
    },
  ],
  mappings: {
    dynamic: false,
    fields: {
      name: textField,
      family: textField,
      type: textField,
      status: { type: "token" },
      variants: {
        type: "document",
        dynamic: false,
        fields: {
          modelNo: [
            // Exact, case-insensitive ("ar-013a1" finds "AR-013A1").
            { type: "string", analyzer: LOWERCASE_KEYWORD },
            // Prefixes of the whole model no. ("AR-01" finds "AR-013A1").
            {
              type: "autocomplete",
              analyzer: LOWERCASE_KEYWORD,
              tokenization: "edgeGram",
              minGrams: 2,
              maxGrams: 20,
              foldDiacritics: false,
            },
          ],
        },
      },
    },
  },
} as const;

/** Every document path the definition indexes (for tests and the report). */
export function indexedPaths(): string[] {
  const out: string[] = [];
  const walk = (fields: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(fields)) {
      const nested =
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "fields" in value
          ? (value as { fields: Record<string, unknown> }).fields
          : null;
      if (nested) walk(nested, `${prefix}${key}.`);
      else out.push(`${prefix}${key}`);
    }
  };
  walk(PRODUCT_SEARCH_INDEX_DEFINITION.mappings.fields, "");
  return out.sort();
}

// ---------------------------------------------------------------------------
// Create / update / no-op
// ---------------------------------------------------------------------------

/** One entry of `$listSearchIndexes` (only what we read). */
export interface ExistingSearchIndex {
  name: string;
  status?: string;
  latestDefinition?: unknown;
}

/** The driver calls the script needs (a fake in tests). */
export interface SearchIndexCollection {
  listSearchIndexes(name: string): { toArray(): Promise<unknown[]> };
  createSearchIndex(description: {
    name: string;
    type: "search";
    definition: Record<string, unknown>;
  }): Promise<string>;
  updateSearchIndex(
    name: string,
    definition: Record<string, unknown>,
  ): Promise<void>;
}

export type SearchIndexAction = "create" | "update" | "noop";

/**
 * True when every key and value of `wanted` is in `actual`. Atlas may echo a
 * definition back with defaults added (e.g. `storedSource`); those extra keys
 * do not count as a difference, so re-running the script is a no-op instead
 * of a full index rebuild. Arrays must have the same length, element-wise.
 */
export function definitionContains(actual: unknown, wanted: unknown): boolean {
  if (Array.isArray(wanted)) {
    return (
      Array.isArray(actual) &&
      actual.length === wanted.length &&
      wanted.every((item, index) => definitionContains(actual[index], item))
    );
  }
  if (wanted !== null && typeof wanted === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual))
      return false;
    return Object.entries(wanted).every(([key, value]) =>
      definitionContains((actual as Record<string, unknown>)[key], value),
    );
  }
  return actual === wanted;
}

/** What to do given the existing index (undefined = none) and the wanted definition. */
export function decideSearchIndexAction(
  existing: ExistingSearchIndex | undefined,
  wanted: unknown,
): SearchIndexAction {
  if (existing === undefined) return "create";
  return definitionContains(existing.latestDefinition, wanted)
    ? "noop"
    : "update";
}

/** The server cannot manage Atlas Search indexes (not an Atlas cluster). */
export class SearchIndexUnsupportedError extends Error {
  override readonly name = "SearchIndexUnsupportedError";
}

function asExisting(raw: unknown): ExistingSearchIndex | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.name !== "string") return undefined;
  return {
    name: entry.name,
    status: typeof entry.status === "string" ? entry.status : undefined,
    latestDefinition: entry.latestDefinition,
  };
}

/** The outcome of ensureProductSearchIndex. */
export interface SearchIndexResult {
  action: SearchIndexAction;
  name: string;
  /** Atlas' status of the existing index (noop/update), when reported. */
  status?: string;
}

/**
 * Creates the index when missing, updates it when its definition differs,
 * otherwise does nothing. Throws SearchIndexUnsupportedError when the server
 * cannot list search indexes (a local or in-memory MongoDB). Atlas builds
 * the index in the background; `$search` works once its status is READY.
 */
export async function ensureProductSearchIndex(
  collection: SearchIndexCollection,
): Promise<SearchIndexResult> {
  const name = PRODUCT_SEARCH_INDEX_NAME;
  const definition = PRODUCT_SEARCH_INDEX_DEFINITION as unknown as Record<
    string,
    unknown
  >;
  let found: unknown[];
  try {
    found = await collection.listSearchIndexes(name).toArray();
  } catch (error) {
    throw new SearchIndexUnsupportedError(
      `This MongoDB server cannot list Atlas Search indexes (${
        error instanceof Error ? error.name : "unknown error"
      }). Point MONGODB_URI at an Atlas cluster (M0 or larger) and re-run.`,
    );
  }
  const existing = found
    .map(asExisting)
    .find((entry) => entry !== undefined && entry.name === name);
  const action = decideSearchIndexAction(existing, definition);
  if (action === "create") {
    await collection.createSearchIndex({ name, type: "search", definition });
  } else if (action === "update") {
    await collection.updateSearchIndex(name, definition);
  }
  return { action, name, status: existing?.status };
}
