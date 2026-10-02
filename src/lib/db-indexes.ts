// Builds the MongoDB indexes declared in our Mongoose schemas (ADR 0018:
// autoIndex is off, so nothing builds them on startup). Used by
// scripts/sync-indexes.ts (`npm run db:indexes`) and by tests.

import "server-only";

import type { RegisteredModel } from "@/models";

/** The outcome for one model. */
export type IndexSyncResult =
  | {
      ok: true;
      model: string;
      collection: string;
      /** Index names now on the collection ([] if it does not exist yet). */
      indexes: string[];
      /**
       * False when the model declares no indexes and the collection has no
       * documents yet: with autoCreate off, MongoDB creates it on first insert.
       */
      collectionExists: boolean;
    }
  | { ok: false; model: string; collection: string; error: string };

/* MongoDB's error code for "collection does not exist". */
const NAMESPACE_NOT_FOUND = 26;

/**
 * Calls `createIndexes()` on each model, one after another, and lists the
 * indexes each collection has afterwards. A failure on one model is recorded
 * and the rest still run. Expects connectDb() to have been awaited.
 *
 * `createIndexes()` only ADDS missing indexes. We never use `syncIndexes()`,
 * which also drops indexes that are not in the schema (for example ones made
 * by hand in Atlas or by Better Auth).
 */
export async function syncIndexes(
  models: readonly RegisteredModel[],
): Promise<IndexSyncResult[]> {
  const results: IndexSyncResult[] = [];
  for (const model of models) {
    const base = {
      model: model.modelName,
      collection: model.collection.collectionName,
    };
    try {
      await model.createIndexes();
      const indexes = await listIndexNames(model);
      results.push({
        ...base,
        ok: true,
        indexes: indexes ?? [],
        collectionExists: indexes !== undefined,
      });
    } catch (error) {
      results.push({ ...base, ok: false, error: describeIndexError(error) });
    }
  }
  return results;
}

/* The collection's index names, or undefined if the collection does not exist. */
async function listIndexNames(
  model: RegisteredModel,
): Promise<string[] | undefined> {
  try {
    const indexes = await model.collection.indexes();
    return indexes.map((index) => index.name ?? JSON.stringify(index.key));
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) {
      return undefined;
    }
    throw error;
  }
}

/*
 * A safe one-line description of an index build error. Server messages are
 * left out on purpose: a duplicate-key error quotes the duplicate value, which
 * can be personal data (an email in loginAttempts) and would end up in
 * terminal or CI logs. The code name and key pattern are enough to act on.
 */
function describeIndexError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const details = error as Error & {
    code?: unknown;
    codeName?: unknown;
    keyPattern?: unknown;
  };
  const parts = [error.name];
  if (typeof details.codeName === "string") parts.push(details.codeName);
  if (typeof details.code === "number") parts.push(`code ${details.code}`);
  if (details.keyPattern && typeof details.keyPattern === "object") {
    parts.push(`on ${JSON.stringify(details.keyPattern)}`);
  }
  if (details.code === 11000) {
    parts.push(
      "(existing documents break a unique index; fix them, then re-run)",
    );
  }
  // 85 IndexOptionsConflict / 86 IndexKeySpecsConflict: an index changed in a
  // schema (e.g. a new TTL) but the old one still exists. We never drop
  // indexes automatically (ADR 0018), so tell the operator what to do.
  if (details.code === 85 || details.code === 86) {
    parts.push(
      "(an index with the same name or keys already exists with different options; drop the old one in Atlas, then re-run)",
    );
  }
  return parts.join(" ");
}
