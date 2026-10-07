// CLI: `npm run sweep:cloudinary` (dry run) / `npm run sweep:cloudinary -- --apply`.
// Deletes Cloudinary images under yg/products/ and yg/areas/ that no product
// (images, variant images) or area references and that are older than 24 h:
// images of deleted products and signed uploads that were never saved. Dry
// run by default. Prints public ids only.
// Run with: node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/sweep-cloudinary-orphans.ts

import process from "node:process";

import { destroyImage, listImages } from "@/lib/cloudinary";
import { DbConnectionError, connectDb, disconnectDb } from "@/lib/db";
import { EnvError } from "@/lib/env";
import {
  SWEPT_CLOUDINARY_FOLDERS,
  applySelection,
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
    console.log(
      `${assets.length} image(s) listed, ${referenced.size} referenced, ${selected.length} orphaned (older than 24 h).`,
    );
    const result = await applySelection(selected, args.apply, destroyImage);
    for (const id of result.selected) console.log(`  ${id}`);
    if (!args.apply) {
      console.log("Dry run: nothing deleted. Re-run with --apply to delete.");
      return 0;
    }
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
