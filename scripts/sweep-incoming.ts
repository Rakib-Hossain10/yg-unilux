// CLI: `npm run sweep:incoming` (dry run) / `npm run sweep:incoming -- --apply`.
// Deletes abandoned presigned uploads: R2 objects under `incoming/` older than
// 24 h (ADR 0045). Dry run by default. Storage is reached only through
// src/lib/storage.ts; only keys are printed (never URLs or credentials).
// Run with: node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/sweep-incoming.ts

import process from "node:process";

import { R2_INCOMING_PREFIX } from "@/lib/constants";
import { EnvError } from "@/lib/env";
import {
  applySelection,
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
  console.log(
    `${objects.length} object(s) under ${R2_INCOMING_PREFIX}, ${selected.length} older than 24 h.`,
  );
  const result = await applySelection(selected, args.apply, async (key) => {
    await deleteObject(key);
  });
  for (const key of result.selected) console.log(`  ${key}`);
  if (!args.apply) {
    console.log("Dry run: nothing deleted. Re-run with --apply to delete.");
    return 0;
  }
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
