// CLI: `npm run db:search-index`. Creates the Atlas Search index on
// `products` when missing, updates it when its definition differs, otherwise
// does nothing (ADR 0006, 0066). Never drops an index. Atlas clusters only.
// Run with: node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/search-index.ts

import process from "node:process";

import {
  DbConnectionError,
  connectDb,
  disconnectDb,
  getDb,
  mongoose,
} from "@/lib/db";
import { EnvError } from "@/lib/env";
import {
  ensureProductSearchIndex,
  indexedPaths,
  SearchIndexUnsupportedError,
  type SearchIndexCollection,
} from "@/lib/catalog/search-index";
import { ProductModel } from "@/models";

/** One line per outcome, for the operator. */
export function describeSearchIndexOutcome(
  action: "create" | "update" | "noop",
  name: string,
  status: string | undefined,
): string {
  switch (action) {
    case "create":
      return `Created search index "${name}". Atlas builds it in the background; search uses the regex fallback until it is READY.`;
    case "update":
      return `Updated search index "${name}" (definition changed). Atlas rebuilds it in the background; the old version serves queries meanwhile.`;
    case "noop":
      return `Search index "${name}" is up to date${status ? ` (status: ${status})` : ""}. Nothing changed.`;
  }
}

/**
 * Runs the check on the open connection and prints through `log`. Returns
 * the exit code. Expects connectDb() to have been awaited.
 */
export async function runSearchIndexSync(
  collection: SearchIndexCollection,
  log: (line: string) => void,
): Promise<number> {
  log(
    `Search index on "${ProductModel.collection.collectionName}" in database "${mongoose.connection.name}"; indexed fields: ${indexedPaths().join(", ")}`,
  );
  try {
    const result = await ensureProductSearchIndex(collection);
    log(describeSearchIndexOutcome(result.action, result.name, result.status));
    return 0;
  } catch (error) {
    log(
      error instanceof SearchIndexUnsupportedError
        ? error.message
        : `Search index sync failed: ${error instanceof Error ? error.name : "unknown error"} (details withheld).`,
    );
    return 1;
  }
}

async function main(): Promise<number> {
  await connectDb();
  try {
    const collection = getDb().collection(
      ProductModel.collection.collectionName,
    );
    return await runSearchIndexSync(collection, (line) => console.log(line));
  } finally {
    await disconnectDb();
  }
}

if (process.argv[1] && /search-index\.ts$/.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // Driver messages can quote data, so only safe messages are printed.
      console.error(
        error instanceof EnvError || error instanceof DbConnectionError
          ? error.message
          : `Search index sync failed: ${error instanceof Error ? error.name : "unknown error"} (details withheld)`,
      );
      process.exitCode = 1;
    },
  );
}
