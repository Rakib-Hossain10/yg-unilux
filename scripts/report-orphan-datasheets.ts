// CLI: `npm run report:datasheets`. LIST ONLY, never deletes: R2 objects under
// `datasheets/` that no `datasheets` document references (e.g. left by a
// failed DB write after the copy, ADR 0045). The admin decides what to do.
// Run with: node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/report-orphan-datasheets.ts

import process from "node:process";

import { R2_DATASHEETS_PREFIX } from "@/lib/constants";
import { DbConnectionError, connectDb, disconnectDb } from "@/lib/db";
import { EnvError } from "@/lib/env";
import { selectOrphanDatasheetObjects } from "@/lib/orphan-sweep";
import { listObjects } from "@/lib/storage";
import { DatasheetModel } from "@/models";

async function main(): Promise<number> {
  await connectDb();
  try {
    const documents = await DatasheetModel.find({}, { storageKey: 1 }).lean();
    const referenced = new Set(documents.map((d) => d.storageKey));
    const objects = await listObjects(R2_DATASHEETS_PREFIX);
    const orphans = selectOrphanDatasheetObjects(
      objects,
      referenced,
      new Date(),
    );
    console.log(
      `${objects.length} object(s) under ${R2_DATASHEETS_PREFIX}, ${referenced.size} referenced, ${orphans.length} orphaned.`,
    );
    for (const key of orphans) console.log(`  ${key}`);
    console.log("Report only: nothing was deleted.");
    return 0;
  } finally {
    await disconnectDb();
  }
}

if (process.argv[1] && /report-orphan-datasheets\.ts$/.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(
        error instanceof EnvError || error instanceof DbConnectionError
          ? error.message
          : `Report failed: ${error instanceof Error ? error.name : "unknown error"} (details withheld)`,
      );
      process.exitCode = 1;
    },
  );
}
