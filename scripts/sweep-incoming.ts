// CLI: `npm run sweep:incoming` (dry run) / `npm run sweep:incoming -- --apply`.
// Deletes abandoned presigned uploads: R2 objects under `incoming/` older than
// 24 h (ADR 0045). Dry run by default. Storage is reached only through
// src/lib/storage.ts; only keys and the bucket name are printed (never URLs
// or credentials). Mass-delete guard: `--apply` refuses more than 100 objects
// unless `--max-delete N` is given and the selection is at most N.
// Run with: node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/sweep-incoming.ts

import process from "node:process";

import { R2_INCOMING_PREFIX } from "@/lib/constants";
import { EnvError, env } from "@/lib/env";
import {
  MAX_UNGUARDED_INCOMING_COUNT,
  applySelection,
  checkMassDelete,
  parseSweepArgs,
  selectStaleIncoming,
} from "@/lib/orphan-sweep";
import { deleteObject, listObjects } from "@/lib/storage";

async function main(argv: string[]): Promise<number> {
  const args = parseSweepArgs(argv);
  if ("error" in args) {
    console.error(args.error);
    return 1;
  }
  const objects = await listObjects(R2_INCOMING_PREFIX);
  const selected = selectStaleIncoming(objects, new Date());
  console.log(`R2 bucket: ${env.r2().bucket}`);
  console.log(
    `${objects.length} object(s) under ${R2_INCOMING_PREFIX}, ${selected.length} older than 24 h.`,
  );
  for (const key of selected) console.log(`  ${key}`);
  const verdict = checkMassDelete(
    {
      selected: selected.length,
      listed: objects.length,
      maxDelete: args.maxDelete,
    },
    { maxCount: MAX_UNGUARDED_INCOMING_COUNT },
  );
  if (!args.apply) {
    if (!verdict.ok) {
      console.log(`Warning: --apply would refuse. ${verdict.reason}`);
    }
    console.log("Dry run: nothing deleted. Re-run with --apply to delete.");
    return 0;
  }
  if (!verdict.ok) {
    console.error(`Refused: nothing deleted. ${verdict.reason}`);
    return 1;
  }
  const result = await applySelection(selected, true, async (key) => {
    await deleteObject(key);
  });
  console.log(
    `Deleted ${result.deleted.length}, failed ${result.failed.length}.`,
  );
  return result.failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && /sweep-incoming\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(
        error instanceof EnvError
          ? error.message
          : `Sweep failed: ${error instanceof Error ? error.name : "unknown error"} (details withheld)`,
      );
      process.exitCode = 1;
    },
  );
}
