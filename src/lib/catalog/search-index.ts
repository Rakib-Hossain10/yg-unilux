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
  /** Atlas' flag: queries are served (e.g. the old version during a rebuild). */
  queryable?: boolean;
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
    queryable:
      typeof entry.queryable === "boolean" ? entry.queryable : undefined,
    latestDefinition: entry.latestDefinition,
  };
}

/* The entry named `name` among listed search indexes. */
function findIndex(
  found: readonly unknown[],
  name: string,
): ExistingSearchIndex | undefined {
  return found
    .map(asExisting)
    .find((entry) => entry !== undefined && entry.name === name);
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
  const existing = findIndex(found, name);
  const action = decideSearchIndexAction(existing, definition);
  if (action === "create") {
    await collection.createSearchIndex({ name, type: "search", definition });
  } else if (action === "update") {
    await collection.updateSearchIndex(name, definition);
  }
  return { action, name, status: existing?.status };
}

// ---------------------------------------------------------------------------
// Index status (gate-A L-3): what the operator is told, and the exit code
// ---------------------------------------------------------------------------

/** The status and queryable flag Atlas reports now; undefined = not listed. */
export interface SearchIndexState {
  status?: string;
  queryable?: boolean;
}

/**
 * Lists the product search index again (after a create/update the status
 * changes). Undefined when Atlas does not list it (yet). Throws like
 * ensureProductSearchIndex when the server cannot list search indexes.
 */
export async function readProductSearchIndexState(
  collection: SearchIndexCollection,
): Promise<SearchIndexState | undefined> {
  let found: unknown[];
  try {
    found = await collection
      .listSearchIndexes(PRODUCT_SEARCH_INDEX_NAME)
      .toArray();
  } catch (error) {
    throw new SearchIndexUnsupportedError(
      `This MongoDB server cannot list Atlas Search indexes (${
        error instanceof Error ? error.name : "unknown error"
      }).`,
    );
  }
  const entry = findIndex(found, PRODUCT_SEARCH_INDEX_NAME);
  return entry === undefined
    ? undefined
    : { status: entry.status, queryable: entry.queryable };
}

/**
 * What a status means for the site:
 * - `ready`: search is live (READY);
 * - `serving`: queries are answered, but not by the wanted version yet (a
 *   rebuild of a queryable index, or STALE);
 * - `building`: not queryable yet (PENDING, BUILDING, or not listed yet right
 *   after a create): Atlas answers every search with NO results (ADR 0066),
 *   the regex fallback is not used because `$search` does not fail;
 * - `failed`: FAILED, DOES_NOT_EXIST or DELETING: search returns nothing
 *   until someone fixes the index.
 * An unknown status counts as `building` (not known to serve).
 */
export type SearchIndexHealth = "ready" | "serving" | "building" | "failed";

export function searchIndexHealth(
  state: SearchIndexState | undefined,
): SearchIndexHealth {
  const status = state?.status?.toUpperCase();
  switch (status) {
    case "READY":
      return "ready";
    case "FAILED":
    case "DOES_NOT_EXIST":
    case "DELETING":
      return "failed";
    case "STALE":
      return "serving";
    default:
      return state?.queryable === true ? "serving" : "building";
  }
}

/** The line printed for a state and the script's exit code. */
export interface SearchIndexStatusReport {
  health: SearchIndexHealth;
  exitCode: 0 | 1;
  message: string;
}

/**
 * The operator message and exit code for a status. FAILED (and a vanished
 * index) exits 1; a building or serving index exits 0 with a warning, or 1
 * when the operator waited (`--wait`) and it did not become READY in time. Pure.
 */
export function describeSearchIndexStatus(
  state: SearchIndexState | undefined,
  options: { waitedOut?: boolean } = {},
): SearchIndexStatusReport {
  const health = searchIndexHealth(state);
  const status = state?.status ?? "not listed yet";
  const name = PRODUCT_SEARCH_INDEX_NAME;
  switch (health) {
    case "ready":
      return {
        health,
        exitCode: 0,
        message: `Search index "${name}" is READY: catalog search is live.`,
      };
    case "serving":
      return {
        health,
        exitCode: options.waitedOut === true ? 1 : 0,
        message: `${
          options.waitedOut === true
            ? "ERROR: timed out waiting; "
            : "WARNING: "
        }search index "${name}" is ${status} but queryable: search keeps answering from the previous version until the new one is READY.`,
      };
    case "building":
      return {
        health,
        exitCode: options.waitedOut === true ? 1 : 0,
        message: `${
          options.waitedOut === true
            ? "ERROR: timed out waiting; "
            : "WARNING: "
        }search index "${name}" is ${status}. Until it is READY, Atlas answers every catalog search with NO results (the regex fallback is only used when $search fails, ADR 0066). Re-run with --wait to wait for READY.`,
      };
    case "failed":
      return {
        health,
        exitCode: 1,
        message: `ERROR: search index "${name}" is ${status}. Catalog search returns no results. Check the index in the Atlas UI (Atlas Search tab), fix the cause, then re-run this script.`,
      };
  }
}

/** Polling options for waitForSearchIndex (injectable for tests). */
export interface SearchIndexWaitOptions {
  timeoutMs: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Polls the index until it is READY or FAILED (or serving the wanted
 * version) or `timeoutMs` passes. Returns the last state and whether the
 * wait ran out while the index was still building.
 */
export async function waitForSearchIndex(
  collection: SearchIndexCollection,
  options: SearchIndexWaitOptions,
): Promise<{ state: SearchIndexState | undefined; waitedOut: boolean }> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const start = now();
  for (;;) {
    const state = await readProductSearchIndexState(collection);
    const health = searchIndexHealth(state);
    if (health === "ready" || health === "failed") {
      return { state, waitedOut: false };
    }
    if (now() - start >= options.timeoutMs) return { state, waitedOut: true };
    await sleep(options.intervalMs);
  }
}
