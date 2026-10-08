// Commit step of the bulk import (Phase 3 T8, ADR 0061): saves one batch of a
// freshly re-planned import. Checks the preview's entry hashes, uploads only
// the pictures a written product references, then creates or updates each
// product with exactly its plan target. The caller (index.ts) audits and tags.

import "server-only";

import type { Types } from "mongoose";

import { isDuplicateKeyError } from "@/lib/admin/write-result";
import { destroyImage, uploadImageBuffer } from "@/lib/cloudinary";
import {
  IMPORT_BATCH_SIZE,
  IMPORT_UPLOAD_CONCURRENCY,
  MAX_PRODUCT_IMAGES,
} from "@/lib/constants";
import { mongoose } from "@/lib/db";
import { ProductModel } from "@/models";
import type { Product, ProductImage, ProductVariant } from "@/models/product";
import type { ProductStatus } from "@/models/product-constants";

import type { EmbeddedImage } from "./images";
import { combinePlanHash } from "./plan";
import type { ImportPlan, PlanEntry, PlanTarget } from "./types";

const { ObjectId } = mongoose.Types;

/** What happened to one product of the batch. */
export type CommittedStatus =
  "created" | "updated" | "unchanged" | "blocked" | "failed";

export interface CommittedProduct {
  /** Index of the entry in `plan.entries`. */
  index: number;
  sheet: string;
  rows: number[];
  productNo: number | null;
  name: string;
  status: CommittedStatus;
  /** The saved product (null when blocked, or a create that failed). */
  id: string | null;
  slug: string | null;
  /** Plain English for the admin when `failed`; never a cell value. */
  error?: string;
}

export interface CommitBatchSummary {
  created: number;
  updated: number;
  unchanged: number;
  blocked: number;
  failed: number;
  imagesAdded: number;
  variantsRemoved: number;
}

export interface CommitBatchResult {
  batch: number;
  /** How many batches the plan has (entries / IMPORT_BATCH_SIZE, rounded up). */
  batches: number;
  products: CommittedProduct[];
  summary: CommitBatchSummary;
}

/** One product that was written, for the caller's audit entry and tags. */
export interface WrittenProduct {
  id: string;
  /** Published products also expire category and area listings. */
  published: boolean;
  /** The changed field names (updates) or "create". */
  fields: string[];
}

export type CommitOutcome =
  | { kind: "done"; result: CommitBatchResult; written: WrittenProduct[] }
  /** The preview's hashes don't fit this plan, or a product changed. */
  | { kind: "stale" }
  /** A product of the batch removes variants and the admin didn't confirm. */
  | { kind: "needs_ack" }
  /** The batch number is past the last batch. */
  | { kind: "bad_batch" };

export interface CommitBatchInput {
  planHash: string;
  entryHashes: readonly string[];
  batch: number;
  acknowledgeRemovals: boolean;
}

/* Messages for a failed product (shown to the admin, never logged). */
export const COMMIT_ERRORS = {
  taken:
    "Another product took this product's web address or one of its model nos. after the preview. Preview the file again.",
  changed:
    "This product was changed after the preview. Preview the file again.",
  upload:
    "Its pictures could not be uploaded. Try this batch again; if it keeps failing, replace the picture in the sheet.",
  save: "It could not be saved. Try this batch again.",
} as const;

/** How many batches a plan of `entryCount` entries has. */
export function batchCount(entryCount: number): number {
  return Math.ceil(entryCount / IMPORT_BATCH_SIZE);
}

/**
 * Saves batch `input.batch` of `plan` (just re-planned from the previewed
 * file). Nothing is written unless every entry of the batch is either the
 * one the admin previewed (same entry hash) or already saved (it now plans
 * as `unchanged`, e.g. a re-run after a failure): anything else is stale.
 */
export async function commitPlanBatch(args: {
  plan: ImportPlan;
  sheetHash: string;
  files: ReadonlyMap<string, EmbeddedImage>;
  input: CommitBatchInput;
}): Promise<CommitOutcome> {
  const { plan, sheetHash, files, input } = args;
  const entries = plan.entries;

  // The preview's entry hashes must be the ones its planHash was made of,
  // for this very sheet and default category (sheetHash is DB-independent).
  if (
    input.entryHashes.length !== entries.length ||
    combinePlanHash(sheetHash, input.entryHashes) !== input.planHash
  ) {
    return { kind: "stale" };
  }
  const batches = batchCount(entries.length);
  if (input.batch >= batches) return { kind: "bad_batch" };

  const start = input.batch * IMPORT_BATCH_SIZE;
  const slice = entries
    .slice(start, start + IMPORT_BATCH_SIZE)
    .map((entry, offset) => ({ entry, index: start + offset }));

  const toWrite: { entry: PlanEntry; index: number }[] = [];
  for (const item of slice) {
    const previewed = input.entryHashes[item.index];
    if (previewed === item.entry.hash) {
      if (item.entry.status === "create" || item.entry.status === "update") {
        toWrite.push(item);
      }
    } else if (item.entry.status !== "unchanged") {
      return { kind: "stale" };
    }
    // A different hash on an `unchanged` entry: saved by an earlier run.
  }
  if (
    !input.acknowledgeRemovals &&
    toWrite.some(({ entry }) => entry.variantsRemoved.length > 0)
  ) {
    return { kind: "needs_ack" };
  }

  const saved = await loadSaved(toWrite.map(({ entry }) => entry));
  const prepared = toWrite.map(({ entry, index }) =>
    prepare(entry, index, saved),
  );
  await uploadAll(prepared, files);

  const outcomes = new Map<number, CommittedProduct>();
  const written: WrittenProduct[] = [];
  let imagesAdded = 0;
  let variantsRemoved = 0;
  // Sequential: each product is one atomic write; a failure stays its own.
  for (const job of prepared) {
    const outcome = await writeOne(job);
    outcomes.set(job.index, outcome.product);
    if (outcome.written !== null) {
      written.push(outcome.written);
      imagesAdded += job.uploads.length;
      variantsRemoved += job.entry.variantsRemoved.length;
    }
  }

  const products = slice.map(({ entry, index }) => {
    const done = outcomes.get(index);
    if (done !== undefined) return done;
    return committed(
      entry,
      index,
      entry.status === "blocked" ? "blocked" : "unchanged",
      entry.existing?.id ?? null,
      entry.existing?.slug ?? null,
    );
  });
  const count = (status: CommittedStatus) =>
    products.filter((p) => p.status === status).length;
  return {
    kind: "done",
    written,
    result: {
      batch: input.batch,
      batches,
      products,
      summary: {
        created: count("created"),
        updated: count("updated"),
        unchanged: count("unchanged"),
        blocked: count("blocked"),
        failed: count("failed"),
        imagesAdded,
        variantsRemoved,
      },
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Preparing: ids, the saved state of updates, the pictures to upload.
 * ------------------------------------------------------------------------ */

/* The fields of a saved product the commit compares and extends. */
type SavedProduct = Pick<
  Product,
  | "_id"
  | "status"
  | "updatedAt"
  | "family"
  | "type"
  | "productNo"
  | "modelCode"
  | "specs"
  | "filters"
  | "variants"
  | "mainCategory"
  | "extraCategories"
  | "areas"
  | "trackSize"
  | "images"
>;

const SAVED_PROJECTION = {
  status: 1,
  updatedAt: 1,
  family: 1,
  type: 1,
  productNo: 1,
  modelCode: 1,
  specs: 1,
  filters: 1,
  variants: 1,
  mainCategory: 1,
  extraCategories: 1,
  areas: 1,
  trackSize: 1,
  images: 1,
} as const;

async function loadSaved(
  entries: readonly PlanEntry[],
): Promise<Map<string, SavedProduct>> {
  const ids = entries.flatMap((e) =>
    e.status === "update" && e.existing ? [new ObjectId(e.existing.id)] : [],
  );
  if (ids.length === 0) return new Map();
  const docs = await ProductModel.find(
    { _id: { $in: ids } },
    SAVED_PROJECTION,
  ).lean<SavedProduct[]>();
  return new Map(docs.map((doc) => [doc._id.toHexString(), doc]));
}

interface Upload {
  sha256: string;
  publicId: string | null;
}

interface WriteJob {
  entry: PlanEntry;
  target: PlanTarget;
  index: number;
  id: Types.ObjectId;
  /** Null for a create. */
  saved: SavedProduct | null;
  /** Set when the product cannot be written (before any upload). */
  error: string | null;
  /** The pictures this product gets, in plan order, one per sha256. */
  uploads: Upload[];
}

function prepare(
  entry: PlanEntry,
  index: number,
  savedById: ReadonlyMap<string, SavedProduct>,
): WriteJob {
  const target = entry.target as PlanTarget;
  const create = entry.status === "create";
  const id = create
    ? new ObjectId()
    : new ObjectId((entry.existing as { id: string }).id);
  const saved = create ? null : (savedById.get(id.toHexString()) ?? null);
  const job: WriteJob = {
    entry,
    target,
    index,
    id,
    saved,
    error: null,
    uploads: [],
  };
  // Changed since the re-plan read it (or deleted): the write would miss.
  if (
    !create &&
    (saved === null ||
      saved.updatedAt.toISOString() !== entry.existing?.updatedAt)
  ) {
    job.error = COMMIT_ERRORS.changed;
    return job;
  }
  // One copy per product: skip pictures it already holds, stay in the cap.
  const held = new Set(
    (saved?.images ?? []).flatMap((image) =>
      image.sourceSha256 === undefined ? [] : [image.sourceSha256],
    ),
  );
  const room = MAX_PRODUCT_IMAGES - (saved?.images.length ?? 0);
  const shas = [...new Set(entry.imagesToAdd.map((ref) => ref.sha256))]
    .filter((sha) => !held.has(sha))
    .slice(0, Math.max(0, room));
  job.uploads = shas.map((sha256) => ({ sha256, publicId: null }));
  return job;
}

/* At most IMPORT_UPLOAD_CONCURRENCY uploads in flight over the batch. */
async function uploadAll(
  jobs: readonly WriteJob[],
  files: ReadonlyMap<string, EmbeddedImage>,
): Promise<void> {
  const tasks = jobs.flatMap((job) =>
    job.error === null ? job.uploads.map((upload) => ({ job, upload })) : [],
  );
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++] as (typeof tasks)[number];
      task.upload.publicId = await uploadOne(
        task.job.id.toHexString(),
        task.upload.sha256,
        files,
      );
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(IMPORT_UPLOAD_CONCURRENCY, tasks.length) },
      worker,
    ),
  );
}

/* The new public id, or null when the picture could not be uploaded. */
async function uploadOne(
  productId: string,
  sha256: string,
  files: ReadonlyMap<string, EmbeddedImage>,
): Promise<string | null> {
  const file = files.get(sha256);
  if (file === undefined) return null;
  try {
    const result = await uploadImageBuffer(productId, Buffer.from(file.data));
    if (!result.ok) return null;
    // The helper hashes what it sent; it must be the picture we planned.
    if (result.image.sourceSha256 !== sha256) {
      await destroyImage(result.image.publicId);
      return null;
    }
    return result.image.publicId;
  } catch (error) {
    // Only the class name: an SDK error can carry request options.
    console.error(`[import] picture upload failed: ${errorKind(error)}`);
    return null;
  }
}

/* ------------------------------------------------------------------------ *
 * Writing one product.
 * ------------------------------------------------------------------------ */

function committed(
  entry: PlanEntry,
  index: number,
  status: CommittedStatus,
  id: string | null,
  slug: string | null,
  error?: string,
): CommittedProduct {
  return {
    index,
    sheet: entry.sheet,
    rows: [...entry.rows],
    productNo: entry.productNo,
    name: entry.name,
    status,
    id,
    slug,
    ...(error === undefined ? {} : { error }),
  };
}

async function writeOne(
  job: WriteJob,
): Promise<{ product: CommittedProduct; written: WrittenProduct | null }> {
  const { entry, index, target } = job;
  const create = entry.status === "create";
  const hexId = job.id.toHexString();
  // `keepUploads`: the write may have landed (outcome unknown), so the new
  // pictures may be referenced; the Cloudinary orphan sweep removes them
  // if not. Everywhere else nothing references them: destroy them now.
  const fail = async (error: string, keepUploads = false) => {
    if (!keepUploads) await destroyUploads(job);
    return {
      product: committed(
        entry,
        index,
        "failed",
        create ? null : hexId,
        create ? null : target.slug,
        error,
      ),
      written: null,
    };
  };
  if (job.error !== null) return fail(job.error);
  if (job.uploads.some((upload) => upload.publicId === null)) {
    return fail(COMMIT_ERRORS.upload);
  }

  try {
    if (create) {
      await ProductModel.create(createDoc(job));
      return {
        product: committed(entry, index, "created", hexId, target.slug),
        written: { id: hexId, published: false, fields: ["create"] },
      };
    }
    const update = updateDoc(job);
    if (update.fields.length === 0) {
      return {
        product: committed(entry, index, "unchanged", hexId, target.slug),
        written: null,
      };
    }
    const result = await ProductModel.updateOne(
      {
        _id: job.id,
        // Only while nobody wrote since the plan (and its hash) read it.
        updatedAt: (job.saved as SavedProduct).updatedAt,
      },
      update.ops,
      { runValidators: true },
    );
    if (result.matchedCount === 0) return fail(COMMIT_ERRORS.changed);
    return {
      product: committed(entry, index, "updated", hexId, target.slug),
      written: {
        id: hexId,
        published: (job.saved as SavedProduct).status === "published",
        fields: update.fields,
      },
    };
  } catch (error) {
    if (isDuplicateKeyError(error)) return fail(COMMIT_ERRORS.taken);
    console.error(`[import] product write failed: ${errorKind(error)}`);
    // A validation error is a definite "not written"; a network error or
    // timeout may come after the server applied the write.
    return fail(
      COMMIT_ERRORS.save,
      !(error instanceof mongoose.Error.ValidationError),
    );
  }
}

async function destroyUploads(job: WriteJob): Promise<void> {
  for (const upload of job.uploads) {
    if (upload.publicId !== null) await destroyImage(upload.publicId);
  }
}

/* The pictures a product gets, appended after its saved ones. */
function newImages(job: WriteJob): ProductImage[] {
  const saved = job.saved?.images ?? [];
  const base =
    saved.length === 0 ? 0 : Math.max(...saved.map((image) => image.order)) + 1;
  return job.uploads.map((upload, k) => ({
    publicId: upload.publicId as string,
    alt: job.target.name,
    order: base + k,
    kind: "gallery",
    sourceSha256: upload.sha256,
  }));
}

/*
 * The stored variants: the target's, with a NEW variant's sheet picture
 * turned into the public id of this product's copy (uploaded now, or held
 * already under the same sourceSha256). Empty specs are left out.
 */
function storedVariants(job: WriteJob): ProductVariant[] {
  const bySha = new Map<string, string>();
  for (const image of job.saved?.images ?? []) {
    if (image.sourceSha256 !== undefined) {
      bySha.set(image.sourceSha256, image.publicId);
    }
  }
  for (const upload of job.uploads) {
    if (upload.publicId !== null) bySha.set(upload.sha256, upload.publicId);
  }
  return job.target.variants.map((v) => {
    const picture =
      v.imagePublicId ??
      (v.isNew && v.imageSha256 !== null ? bySha.get(v.imageSha256) : null) ??
      null;
    return {
      modelNo: v.modelNo,
      label: v.label,
      ...(Object.keys(v.specs).length === 0 ? {} : { specs: v.specs }),
      ...(picture === null ? {} : { imagePublicId: picture }),
    };
  });
}

/*
 * Every sheet-owned path of the target in its stored form; null = unset.
 * Never name, slug, status or an admin-owned field (ADR 0057 §3).
 */
function sheetOwned(job: WriteJob): Record<string, unknown> {
  const t = job.target;
  const emptyObject = (o: object) => Object.keys(o).length === 0;
  return {
    family: t.family,
    type: t.type,
    productNo: t.productNo,
    modelCode: t.modelCode === "" ? null : t.modelCode,
    specs: emptyObject(t.specs) ? null : t.specs,
    filters: emptyObject(t.filters) ? null : t.filters,
    variants: storedVariants(job),
    mainCategory: new ObjectId(t.mainCategory),
    extraCategories: t.extraCategories.map((id) => new ObjectId(id)),
    areas: t.areas.map((id) => new ObjectId(id)),
    trackSize: t.trackSize,
  };
}

function createDoc(job: WriteJob): Record<string, unknown> {
  const fields = Object.fromEntries(
    Object.entries(sheetOwned(job)).filter(([, value]) => value !== null),
  );
  return {
    _id: job.id,
    name: job.target.name,
    slug: job.target.slug,
    status: "draft" satisfies ProductStatus,
    ...fields,
    images: newImages(job),
  };
}

/* `$set` / `$unset` of the changed sheet-owned paths, `$push` of new pictures. */
function updateDoc(job: WriteJob): {
  ops: Record<string, unknown>;
  fields: string[];
} {
  const saved = job.saved as SavedProduct;
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  const fields: string[] = [];
  for (const [path, value] of Object.entries(sheetOwned(job))) {
    if (sameStored(saved[path as keyof SavedProduct], value)) continue;
    fields.push(path);
    if (value === null) unset[path] = 1;
    else set[path] = value;
  }
  const images = newImages(job);
  if (images.length > 0) fields.push("images");
  return {
    fields,
    ops: {
      ...(Object.keys(set).length > 0 ? { $set: set } : {}),
      ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
      ...(images.length > 0 ? { $push: { images: { $each: images } } } : {}),
    },
  };
}

/*
 * Stored-value equality: ObjectIds as hex, object keys in any order, and
 * "not set" (undefined, null, "", {} and []) all equal, as the plan's diff
 * compares them.
 */
function sameStored(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(prune(JSON.parse(JSON.stringify(value ?? null))));
}

function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(prune);
    return items.length === 0 ? null : items;
  }
  if (value !== null && typeof value === "object") {
    const kept = Object.entries(value)
      .map(([key, v]) => [key, prune(v)] as const)
      .filter(([, v]) => v !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return kept.length === 0 ? null : Object.fromEntries(kept);
  }
  return value === "" ? null : value;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
