// CLI: `npm run db:search-index`. Creates the Atlas Search index on
// `products` when missing, updates it when its definition differs, otherwise
// does nothing (ADR 0006, 0066). Never drops an index. Atlas clusters only.
// Then reports the index status: FAILED exits 1, PENDING/BUILDING warns
// (Atlas answers searches with no results until READY). `--wait` polls until
// READY (`--timeout=<seconds>`, default 600) and exits 1 if it never gets there.
// Run with: node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/search-index.ts [--wait] [--timeout=600]

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
  describeSearchIndexStatus,
  ensureProductSearchIndex,
  indexedPaths,
  readProductSearchIndexState,
  SearchIndexUnsupportedError,
  waitForSearchIndex,
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
      return `Created search index "${name}". Atlas builds it in the background; until it is READY, catalog search returns no results (ADR 0066).`;
    case "update":
      return `Updated search index "${name}" (definition changed). Atlas rebuilds it in the background; the old version serves queries meanwhile.`;
    case "noop":
      return `Search index "${name}" is up to date${status ? ` (status: ${status})` : ""}. Nothing changed.`;
  }
}

/** Command-line options. */
export interface SearchIndexSyncOptions {
  /** Poll until READY (or FAILED / timeout). */
  wait?: boolean;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
const WAIT_INTERVAL_MS = 10_000;
const MAX_WAIT_TIMEOUT_S = 3600;

/** `--wait` and `--timeout=<seconds>` (1..3600); anything else is ignored. */
export function parseSearchIndexArgs(
  argv: readonly string[],
): Pick<SearchIndexSyncOptions, "wait" | "timeoutMs"> {
  const wait = argv.includes("--wait");
  const timeout = argv
    .map((arg) => /^--timeout=(\d{1,4})$/.exec(arg)?.[1])
    .find((value) => value !== undefined);
  const seconds = timeout === undefined ? NaN : Number(timeout);
  return {
    wait,
    timeoutMs:
      seconds >= 1 && seconds <= MAX_WAIT_TIMEOUT_S
        ? seconds * 1000
        : DEFAULT_WAIT_TIMEOUT_MS,
  };
}

/**
 * Runs the check on the open connection and prints through `log`. Returns
 * the exit code: 1 when the sync fails, the index is FAILED, or `--wait`
 * timed out before READY. Expects connectDb() to have been awaited.
 */
export async function runSearchIndexSync(
  collection: SearchIndexCollection,
  log: (line: string) => void,
  options: SearchIndexSyncOptions = {},
): Promise<number> {
  log(
    `Search index on "${ProductModel.collection.collectionName}" in database "${mongoose.connection.name}"; indexed fields: ${indexedPaths().join(", ")}`,
  );
  try {
    const result = await ensureProductSearchIndex(collection);
    log(describeSearchIndexOutcome(result.action, result.name, result.status));
    if (options.wait === true) {
      log("Waiting for the index to be READY...");
      const waited = await waitForSearchIndex(collection, {
        timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
        intervalMs: options.intervalMs ?? WAIT_INTERVAL_MS,
        sleep: options.sleep,
        now: options.now,
      });
      const report = describeSearchIndexStatus(waited.state, {
        waitedOut: waited.waitedOut,
      });
      log(report.message);
      return report.exitCode;
    }
    const report = describeSearchIndexStatus(
      await readProductSearchIndexState(collection),
    );
    log(report.message);
    return report.exitCode;
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
    return await runSearchIndexSync(
      collection,
      (line) => console.log(line),
      parseSearchIndexArgs(process.argv.slice(2)),
    );
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
