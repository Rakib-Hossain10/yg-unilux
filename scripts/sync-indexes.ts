// CLI: builds every MongoDB index declared in src/models (ADR 0018). Run it
// once per new database and after any index change: `npm run db:indexes`.
// It only adds indexes (createIndexes); it never drops one.

/*
 * How it runs (see the `db:indexes` npm script):
 *   node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/sync-indexes.ts
 * - `--conditions=react-server`: src/lib/db.ts imports `server-only`, which
 *   throws unless resolved with the react-server condition (as Next.js does
 *   for server code). No other dependency in this import graph changes with it.
 * - `--env-file-if-exists=.env.local`: Node loads MONGODB_URI from .env.local
 *   when the file exists. Variables already set in the shell win over the
 *   file, so `MONGODB_URI=... npm run db:indexes` targets another database.
 * - `--import tsx`: runs TypeScript and resolves the `@/` path alias.
 */

import process from "node:process";

import { DbConnectionError, connectDb, disconnectDb, mongoose } from "@/lib/db";
import { syncIndexes } from "@/lib/db-indexes";
import { EnvError } from "@/lib/env";
import { indexedModels } from "@/models";

/*
 * Prints a fatal error without leaking data. EnvError and DbConnectionError
 * messages are written to be safe (no values, credentials redacted); any
 * other error shows only its type, because driver messages can quote data.
 */
function reportFatal(stage: string, error: unknown): void {
  const message =
    error instanceof EnvError || error instanceof DbConnectionError
      ? error.message
      : `${error instanceof Error ? error.name : "Unknown error"} (details withheld)`;
  console.error(`Index sync failed while ${stage}.\n${message}`);
}

async function main(): Promise<number> {
  try {
    await connectDb();
  } catch (error) {
    reportFatal("connecting", error);
    await disconnectDb();
    return 1;
  }

  try {
    // The database name is not secret and shows which database was changed.
    console.log(
      `Building indexes in database "${mongoose.connection.name}" (createIndexes; nothing is dropped)`,
    );
    const results = await syncIndexes(indexedModels);
    const width = Math.max(...results.map((r) => r.collection.length));
    for (const result of results) {
      const name = result.collection.padEnd(width);
      if (!result.ok) {
        console.log(`  FAIL  ${name}  ${result.error}`);
      } else if (!result.collectionExists) {
        console.log(
          `  ok    ${name}  (no indexes declared; collection is created on first insert)`,
        );
      } else {
        console.log(`  ok    ${name}  ${result.indexes.join(", ")}`);
      }
    }
    const failed = results.filter((result) => !result.ok).length;
    console.log(
      `Done: ${results.length - failed} of ${results.length} collections ok.`,
    );
    return failed === 0 ? 0 : 1;
  } finally {
    // Close the pool so the process can exit.
    await disconnectDb();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    reportFatal("building indexes", error);
    process.exitCode = 1;
  },
);
