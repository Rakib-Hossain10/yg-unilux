// Pure selection logic for the orphan clean-up scripts (Phase 2, T17). No
// I/O and no env: the scripts in scripts/ list the objects, call these
// functions, and delete only what they return, so every rule is unit tested
// with fake data. Nothing here ever builds a URL.

import {
  CLOUDINARY_AREA_FOLDER,
  CLOUDINARY_PRODUCT_FOLDER,
  R2_DATASHEETS_PREFIX,
  R2_INCOMING_PREFIX,
} from "./constants";
import { isPublicId } from "./cloudinary-ids";

const HOUR_MS = 60 * 60 * 1000;

/** Objects in `incoming/` older than this are abandoned uploads. */
export const INCOMING_MAX_AGE_MS = 24 * HOUR_MS;
/** Cloudinary assets younger than this may still be in-flight uploads. */
export const CLOUDINARY_MIN_AGE_MS = 24 * HOUR_MS;
/**
 * A datasheet object is copied to `datasheets/` just before its database
 * record is written, so a very young object is not reported as an orphan.
 */
export const DATASHEET_REPORT_GRACE_MS = HOUR_MS;

/** The Cloudinary folders the sweep looks at, and nothing else. */
export const SWEPT_CLOUDINARY_FOLDERS = [
  CLOUDINARY_PRODUCT_FOLDER,
  CLOUDINARY_AREA_FOLDER,
] as const;

export interface StoredObject {
  key: string;
  lastModified: Date | undefined;
}

export interface ImageAsset {
  publicId: string;
  createdAt: Date | undefined;
}

/**
 * True when `date` is strictly older than `maxAgeMs` at `now`. A missing or
 * invalid date is never "old": an object whose age is unknown is kept.
 */
export function isOlderThan(
  date: Date | undefined,
  now: Date,
  maxAgeMs: number,
): boolean {
  if (!date) return false;
  const time = date.getTime();
  if (Number.isNaN(time)) return false;
  return now.getTime() - time > maxAgeMs;
}

/** Keys under `incoming/` older than 24 h (abandoned presigned uploads). */
export function selectStaleIncoming(
  objects: readonly StoredObject[],
  now: Date,
  maxAgeMs: number = INCOMING_MAX_AGE_MS,
): string[] {
  return objects
    .filter(
      (object) =>
        object.key.startsWith(R2_INCOMING_PREFIX) &&
        object.key.length > R2_INCOMING_PREFIX.length &&
        isOlderThan(object.lastModified, now, maxAgeMs),
    )
    .map((object) => object.key);
}

/**
 * Cloudinary assets under our product/area folders that nothing references
 * and that are older than the safety window. Covers images of deleted
 * products and signed uploads that were never saved. An id that does not
 * match our server-built shape is never selected (it is not ours to delete).
 */
export function selectOrphanImages(
  assets: readonly ImageAsset[],
  referenced: ReadonlySet<string>,
  now: Date,
  minAgeMs: number = CLOUDINARY_MIN_AGE_MS,
): string[] {
  return assets
    .filter(
      (asset) =>
        SWEPT_CLOUDINARY_FOLDERS.some((folder) =>
          asset.publicId.startsWith(`${folder}/`),
        ) &&
        isPublicId(asset.publicId) &&
        !referenced.has(asset.publicId) &&
        isOlderThan(asset.createdAt, now, minAgeMs),
    )
    .map((asset) => asset.publicId);
}

/** Every Cloudinary id the catalog uses: product images, variant images, area images. */
export function collectReferencedImageIds(sources: {
  products: readonly {
    images?: readonly { publicId?: string }[];
    variants?: readonly { imagePublicId?: string }[];
  }[];
  areas: readonly { bwImage?: string }[];
}): Set<string> {
  const ids = new Set<string>();
  const add = (id: string | undefined) => {
    if (id) ids.add(id);
  };
  for (const product of sources.products) {
    for (const image of product.images ?? []) add(image.publicId);
    for (const variant of product.variants ?? []) add(variant.imagePublicId);
  }
  for (const area of sources.areas) add(area.bwImage);
  return ids;
}

/** Keys under `datasheets/` that no `datasheets` document points to. Report only. */
export function selectOrphanDatasheetObjects(
  objects: readonly StoredObject[],
  referencedKeys: ReadonlySet<string>,
  now: Date,
  graceMs: number = DATASHEET_REPORT_GRACE_MS,
): string[] {
  return objects
    .filter(
      (object) =>
        object.key.startsWith(R2_DATASHEETS_PREFIX) &&
        object.key.length > R2_DATASHEETS_PREFIX.length &&
        !referencedKeys.has(object.key) &&
        // Unknown age is reported (nothing deletes it); young is skipped.
        (object.lastModified === undefined ||
          isOlderThan(object.lastModified, now, graceMs)),
    )
    .map((object) => object.key);
}

export interface SweepResult {
  /** Everything the selection chose. */
  selected: string[];
  /** Deleted in this run (always empty in a dry run). */
  deleted: string[];
  /** Selected but the delete failed (only the id is kept, no error detail). */
  failed: string[];
}

/**
 * Deletes the selected ids one by one, only when `apply` is true. A dry run
 * never calls `remove`. `remove` returns false (or throws) on failure; one
 * failure does not stop the rest.
 */
export async function applySelection(
  selected: readonly string[],
  apply: boolean,
  remove: (id: string) => Promise<boolean | void>,
): Promise<SweepResult> {
  const result: SweepResult = {
    selected: [...selected],
    deleted: [],
    failed: [],
  };
  if (!apply) return result;
  for (const id of selected) {
    try {
      const ok = await remove(id);
      (ok === false ? result.failed : result.deleted).push(id);
    } catch {
      // Detail is withheld on purpose (SDK errors can carry request options).
      result.failed.push(id);
    }
  }
  return result;
}

/** `--apply` turns deletion on; any other argument is an error. */
export function parseSweepArgs(
  argv: readonly string[],
): { apply: boolean } | { error: string } {
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else
      return { error: `Unknown argument "${arg}". Only --apply is accepted.` };
  }
  return { apply };
}
