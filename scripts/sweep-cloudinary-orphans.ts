// CLI: `npm run sweep:cloudinary` (dry run) / `npm run sweep:cloudinary -- --apply`.
// Deletes Cloudinary images under yg/products/ and yg/areas/ that no product
// (images, variant images) or area references and that are older than 24 h:
// images of deleted products and signed uploads that were never saved. Dry
// run by default. Prints public ids, the database name and the cloud name.
// Mass-delete guard: `--apply` is refused when the database references no
// image or the selection is over 20% of the listing, unless
// `--max-delete N` is given and the selection is at most N.
// Run with: node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/sweep-cloudinary-orphans.ts

import process from "node:process";

import { destroyImage, listImages } from "@/lib/cloudinary";
import { DbConnectionError, connectDb, disconnectDb, getDb } from "@/lib/db";
import { EnvError, env } from "@/lib/env";
import {
  MAX_UNGUARDED_IMAGE_SHARE,
  SWEPT_CLOUDINARY_FOLDERS,
  applySelection,
  checkMassDelete,
  collectReferencedImageIds,
  parseSweepArgs,
  selectOrphanImages,
} from "@/lib/orphan-sweep";
import { AreaModel, ProductModel } from "@/models";

async function main(argv: string[]): Promise<number> {
  const args = parseSweepArgs(argv);
  if ("error" in args) {
    console.error(args.error);
    return 1;
  }
  await connectDb();
  try {
    const [products, areas] = await Promise.all([
      ProductModel.find(
        {},
        { "images.publicId": 1, "variants.imagePublicId": 1 },
      ).lean(),
      AreaModel.find({}, { bwImage: 1 }).lean(),
    ]);
    const referenced = collectReferencedImageIds({ products, areas });

    // An upload saved after the DB read is younger than the 24 h window, so
    // it is never selected.
    const assets = (
      await Promise.all(
        SWEPT_CLOUDINARY_FOLDERS.map((folder) => listImages(`${folder}/`)),
      )
    ).flat();
    const selected = selectOrphanImages(assets, referenced, new Date());
    // Names only (never the URI or credentials), so the operator can see
    // which database and which cloud are being compared before anything goes.
    console.log(
      `Database: ${getDb().databaseName} | Cloudinary cloud: ${env.cloudinary().cloudName}`,
    );
    console.log(
      `${assets.length} image(s) listed, ${referenced.size} referenced, ${selected.length} orphaned (older than 24 h).`,
    );
    for (const id of selected) console.log(`  ${id}`);
    const verdict = checkMassDelete(
      {
        selected: selected.length,
        listed: assets.length,
        referenced: referenced.size,
        maxDelete: args.maxDelete,
      },
      { maxShare: MAX_UNGUARDED_IMAGE_SHARE },
    );
    if (!args.apply) {
      if (!verdict.ok)
        console.log(`Warning: --apply would refuse. ${verdict.reason}`);
      console.log("Dry run: nothing deleted. Re-run with --apply to delete.");
      return 0;
    }
    if (!verdict.ok) {
      console.error(`Refused: nothing deleted. ${verdict.reason}`);
      return 1;
    }
    const result = await applySelection(selected, true, destroyImage);
    console.log(
      `Deleted ${result.deleted.length}, failed ${result.failed.length}.`,
    );
    return result.failed.length === 0 ? 0 : 1;
  } finally {
    await disconnectDb();
  }
}

function safeMessage(error: unknown): string {
  if (
    error instanceof EnvError ||
    error instanceof DbConnectionError ||
    (error instanceof Error && error.message.startsWith("Cloudinary listing"))
  ) {
    return error.message;
  }
  return `Sweep failed: ${error instanceof Error ? error.name : "unknown error"} (details withheld)`;
}

if (process.argv[1] && /sweep-cloudinary-orphans\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(safeMessage(error));
      process.exitCode = 1;
    },
  );
}
