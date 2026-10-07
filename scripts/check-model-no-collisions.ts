// CLI: `npm run check:model-nos`. READ ONLY. Lists model nos. used more than
// once ignoring case (ADR 0055): across products they block the new unique
// index, inside one product they fail the next save. Fix them before the old
// `variants.modelNo_1` index is dropped and rebuilt.
// Run with: node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/check-model-no-collisions.ts

/*
 * Prints product ids, slugs and model nos. only: never spec values. Exit code
 * 0 = nothing found (safe to rebuild the index), 1 = clashes found or error.
 */

import process from "node:process";

import { DbConnectionError, connectDb, disconnectDb, mongoose } from "@/lib/db";
import { EnvError } from "@/lib/env";
import {
  findModelNoCollisions,
  type ModelNoOwner,
} from "@/lib/model-no-collisions";
import { ProductModel } from "@/models";

/** Every product that has variants, as id + slug + model nos. */
export async function loadModelNoOwners(): Promise<ModelNoOwner[]> {
  const rows = await ProductModel.find(
    { "variants.0": { $exists: true } },
    { slug: 1, "variants.modelNo": 1 },
  )
    .sort({ _id: 1 })
    .lean<
      {
        _id: mongoose.Types.ObjectId;
        slug: string;
        variants: { modelNo?: unknown }[];
      }[]
    >();
  return rows.map((row) => ({
    id: row._id.toHexString(),
    slug: row.slug,
    modelNos: row.variants.flatMap((variant) =>
      typeof variant.modelNo === "string" ? [variant.modelNo] : [],
    ),
  }));
}

/**
 * Runs the check on the open connection and prints the result through `log`.
 * Returns the exit code. Expects connectDb() to have been awaited.
 */
export async function runModelNoCheck(
  log: (line: string) => void,
): Promise<number> {
  const owners = await loadModelNoOwners();
  const collisions = findModelNoCollisions(owners);
  const count = owners.reduce((sum, owner) => sum + owner.modelNos.length, 0);
  log(
    `Checked ${owners.length} product(s), ${count} model no(s). in database "${mongoose.connection.name}".`,
  );
  if (collisions.length === 0) {
    log(
      'No case-only duplicates. Safe to drop "variants.modelNo_1" in Atlas and run `npm run db:indexes`.',
    );
    return 0;
  }
  const across = collisions.filter((c) => c.productCount > 1).length;
  log(
    `${collisions.length} model no(s). used more than once, ignoring case. Rename one of each:`,
  );
  log(
    `  - ${across} across products: these BLOCK the new index; fix them before dropping the old one.`,
  );
  log(
    `  - ${collisions.length - across} inside one product: the index builds, but that product can't be saved until renamed.`,
  );
  for (const collision of collisions) {
    const where =
      collision.productCount === 1
        ? "inside one product (fails on next save)"
        : `across ${collision.productCount} products (blocks the index)`;
    log(`  ${where}:`);
    for (const owner of collision.owners) {
      log(
        `    ${owner.modelNo}  (product ${owner.id}, /product/${owner.slug})`,
      );
    }
  }
  return 1;
}

async function main(): Promise<number> {
  await connectDb();
  try {
    return await runModelNoCheck((line) => console.log(line));
  } finally {
    await disconnectDb();
  }
}

if (process.argv[1] && /check-model-no-collisions\.ts$/.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // Driver messages can quote data, so only safe messages are printed.
      console.error(
        error instanceof EnvError || error instanceof DbConnectionError
          ? error.message
          : `Check failed: ${error instanceof Error ? error.name : "unknown error"} (details withheld)`,
      );
      process.exitCode = 1;
    },
  );
}
