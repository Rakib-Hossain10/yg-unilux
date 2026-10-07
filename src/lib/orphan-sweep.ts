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

export interface SweepArgs {
  /** Delete for real. Without it the run is a dry run. */
  apply: boolean;
  /**
   * Explicit ceiling the operator accepts for this run (`--max-delete N`). It
   * overrides the mass-delete guard, but a selection larger than N is still
   * refused.
   */
  maxDelete?: number;
}

const ARGS_HELP = "Only --apply and --max-delete <N> are accepted.";

/**
 * `--apply` turns deletion on; `--max-delete N` (N a positive integer, as the
 * next argument) overrides the mass-delete guard up to N deletions. Any other
 * argument, a repeated `--max-delete` or a malformed N is an error.
 */
export function parseSweepArgs(
  argv: readonly string[],
): SweepArgs | { error: string } {
  const args: SweepArgs = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--max-delete") {
      if (args.maxDelete !== undefined) {
        return { error: "--max-delete was given twice." };
      }
      const value = argv[i + 1];
      // Digits only, no sign, no leading zero, no exponent or decimals.
      if (value === undefined || !/^[1-9][0-9]{0,8}$/.test(value)) {
        return {
          error:
            "--max-delete needs a positive whole number, e.g. --max-delete 50.",
        };
      }
      args.maxDelete = Number(value);
      i += 1;
    } else {
      return { error: `Unknown argument "${arg}". ${ARGS_HELP}` };
    }
  }
  return args;
}

/** Cloudinary: refuse to delete more than this share of the listed assets. */
export const MAX_UNGUARDED_IMAGE_SHARE = 0.2;
/**
 * R2 `incoming/`: every object there older than 24 h is junk, so a share
 * makes no sense; an absolute count catches a prefix or listing bug instead.
 */
export const MAX_UNGUARDED_INCOMING_COUNT = 100;

export interface MassDeleteInput {
  /** How many ids the selection chose. */
  selected: number;
  /** How many objects/assets were listed in the swept area. */
  listed: number;
  /**
   * Size of the reference set read from the database. Omitted for a sweep
   * that has none (`incoming/`).
   */
  referenced?: number;
  /** The operator's explicit `--max-delete N`, if any. */
  maxDelete?: number;
}

export interface MassDeleteLimits {
  /** Largest selected/listed ratio allowed without `--max-delete`. */
  maxShare?: number;
  /** Largest selection allowed without `--max-delete`. */
  maxCount?: number;
}

export type MassDeleteVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Decides whether `--apply` may delete the selection (ADR 0051 follow-up,
 * gate E M-1). A wrong or empty database makes every asset look orphaned, so:
 * - nothing selected: always fine;
 * - `--max-delete N` given: allowed only when the selection is at most N
 *   (the operator has looked at the dry run and accepts this many);
 * - otherwise refused when the reference set is empty, the selection is a
 *   larger share of the listing than `maxShare`, or larger than `maxCount`.
 */
export function checkMassDelete(
  input: MassDeleteInput,
  limits: MassDeleteLimits,
): MassDeleteVerdict {
  const { selected, listed, referenced, maxDelete } = input;
  if (selected === 0) return { ok: true };
  if (maxDelete !== undefined) {
    return selected <= maxDelete
      ? { ok: true }
      : {
          ok: false,
          reason: `${selected} selected is more than --max-delete ${maxDelete}.`,
        };
  }
  const override = `Check the dry run, then re-run with --max-delete ${selected} if this is really intended.`;
  if (referenced === 0) {
    return {
      ok: false,
      reason: `The database references nothing, so everything listed looks orphaned (wrong database?). ${override}`,
    };
  }
  if (
    limits.maxShare !== undefined &&
    (listed <= 0 || selected / listed > limits.maxShare)
  ) {
    return {
      ok: false,
      reason: `${selected} of ${listed} listed would be deleted, more than ${Math.round(limits.maxShare * 100)}%. ${override}`,
    };
  }
  if (limits.maxCount !== undefined && selected > limits.maxCount) {
    return {
      ok: false,
      reason: `${selected} would be deleted, more than ${limits.maxCount}. ${override}`,
    };
  }
  return { ok: true };
}
