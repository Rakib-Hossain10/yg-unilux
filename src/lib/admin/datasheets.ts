// Admin services for datasheets (ADR 0001, 0009, 0045): sign a direct upload
// to R2, finalize it (verify, copy to `datasheets/`, write the document),
// replace a file in place, rename, list with an in-use count, and delete.
// The .xlsx never has a public URL; the browser only ever gets a short-lived
// presigned PUT to `incoming/`. Each write audits and returns its cache tags.

import "server-only";

import { randomUUID } from "node:crypto";

import { MAX_DATASHEET_BYTES, XLSX_MIME_TYPE } from "@/lib/constants";
import { connectDb, mongoose } from "@/lib/db";
import { CATALOG_TAGS, type CatalogTag } from "@/lib/revalidate";
import {
  datasheetIdSchema,
  finalizeDatasheetInputSchema,
  INCOMING_KEY_PATTERN,
  presignDatasheetInputSchema,
  renameDatasheetInputSchema,
} from "@/lib/schemas/datasheet";
import {
  copyObject,
  deleteObject,
  getObjectBytes,
  headObject,
  presignPut,
} from "@/lib/storage";
import { checkXlsx, XLSX_REJECTED } from "@/lib/xlsx-signature";
import { DatasheetModel, ProductModel } from "@/models";
import type { Datasheet } from "@/models/datasheet";

import {
  assertActorId,
  auditAndFinish,
  formError,
  invalidInput,
  unchanged,
  type ServiceResult,
} from "./write-result";

const { ObjectId } = mongoose.Types;

const TAGS: CatalogTag[] = [CATALOG_TAGS.datasheets];

export const DATASHEET_NOT_FOUND =
  "This datasheet no longer exists. Reload the page.";
export const UPLOAD_NOT_FOUND =
  "The upload was not found or has expired. Upload the file again.";
export const UPLOAD_FAILED =
  "The file could not be saved right now. Try again in a minute.";
export const SIZE_MISMATCH = `The file is larger than ${MAX_DATASHEET_BYTES / (1024 * 1024)} MB.`;

/** Admin-facing text for a datasheet that products still use. */
function inUseMessage(count: number): string {
  const who = count === 1 ? "1 product uses" : `${count} products use`;
  const them = count === 1 ? "that product" : "those products";
  return `${who} this datasheet. Detach it from ${them} first.`;
}

// ---------------------------------------------------------------------------
// Reads (admin only, never cached)
// ---------------------------------------------------------------------------

export interface DatasheetListItem {
  id: string;
  fileName: string;
  size: number;
  uploadedBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** How many products point at it with `datasheetId`. */
  inUse: number;
}

type ListRow = Pick<
  Datasheet,
  "_id" | "fileName" | "size" | "uploadedBy" | "createdAt" | "updatedAt"
>;

/**
 * Every datasheet, newest upload first, with how many products use it. The
 * storage key is not returned: the UI never needs it. Two queries: the
 * documents, then one grouped count over the `datasheetId` index.
 */
export async function listDatasheets(): Promise<DatasheetListItem[]> {
  await connectDb();
  const rows = await DatasheetModel.find(
    {},
    { fileName: 1, size: 1, uploadedBy: 1, createdAt: 1, updatedAt: 1 },
  )
    .sort({ updatedAt: -1, _id: -1 })
    .lean<ListRow[]>();
  if (rows.length === 0) return [];

  const counts = await ProductModel.aggregate<{
    _id: mongoose.Types.ObjectId;
    n: number;
  }>([
    { $match: { datasheetId: { $in: rows.map((row) => row._id) } } },
    { $group: { _id: "$datasheetId", n: { $sum: 1 } } },
  ]);
  const used = new Map(counts.map((c) => [c._id.toHexString(), c.n]));

  return rows.map((row) => ({
    id: row._id.toHexString(),
    fileName: row.fileName,
    size: row.size,
    uploadedBy: row.uploadedBy.toHexString(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    inUse: used.get(row._id.toHexString()) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Step 1: presign
// ---------------------------------------------------------------------------

export interface DatasheetUploadTicket {
  uploadUrl: string;
  /** Send these headers with the PUT. */
  headers: { "Content-Type": string };
  /** Pass back to finalizeDatasheet(). */
  incomingKey: string;
  expiresIn: number;
}

/**
 * Hands the browser a presigned PUT to a server-chosen `incoming/<uuid>.xlsx`
 * (5 minutes, content type and length signed). Nothing is written to the
 * database and the bucket is not touched, so there are no tags. The real
 * checks happen in finalizeDatasheet(): the size is signed but the content
 * is not trusted.
 */
export async function presignDatasheetUpload(
  actorId: string,
  input: unknown,
): Promise<ServiceResult<DatasheetUploadTicket>> {
  assertActorId(actorId);
  const parsed = presignDatasheetInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);

  const incomingKey = `incoming/${randomUUID()}.xlsx`;
  const put = await presignPut({
    key: incomingKey,
    contentType: XLSX_MIME_TYPE,
    contentLength: parsed.data.size,
  });
  return {
    ok: true,
    data: {
      uploadUrl: put.url,
      headers: put.headers,
      incomingKey,
      expiresIn: put.expiresIn,
    },
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// Step 3: finalize
// ---------------------------------------------------------------------------

/* Best-effort cleanup: never throws, logs only the error's class name. */
async function deleteQuietly(key: string, what: string): Promise<void> {
  try {
    await deleteObject(key);
  } catch (error) {
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[datasheets] could not delete ${what}: ${kind}`);
  }
}

export interface SavedDatasheet {
  id: string;
  fileName: string;
  size: number;
}

/**
 * Turns an uploaded `incoming/` object into a datasheet (mode "new") or
 * replaces the file of an existing one (mode "replace", same `storageKey`,
 * so products and the later download route keep working).
 *
 * Order: validate the key -> HEAD (exists, size, ETag) -> read at most 10 MB
 * if the ETag still matches -> checkXlsx (zip magic, workbook parts, entry
 * cap) -> copy to `datasheets/<uuid>.xlsx` (or onto the existing key) only if
 * the source still has that ETag -> write the document -> audit. An object
 * replaced in between fails the condition: generic error, nothing stored. The `incoming/` object is deleted on EVERY path, success,
 * rejection or thrown error (`finally`). A brand-new copy whose document
 * write failed is deleted too, so it does not become an orphan.
 */
export async function finalizeDatasheet(
  actorId: string,
  input: unknown,
): Promise<ServiceResult<SavedDatasheet>> {
  assertActorId(actorId);
  const parsed = finalizeDatasheetInputSchema.safeParse(input);
  if (!parsed.success) {
    // A bad request can still name a real incoming object: don't leave it.
    const raw =
      typeof input === "object" && input !== null && "incomingKey" in input
        ? input.incomingKey
        : undefined;
    if (typeof raw === "string" && INCOMING_KEY_PATTERN.test(raw)) {
      await deleteQuietly(raw, "an incoming upload");
    }
    return invalidInput(parsed.error);
  }
  const request = parsed.data;
  const { incomingKey, fileName } = request;

  try {
    await connectDb();

    let existing: Pick<Datasheet, "_id" | "storageKey"> | null = null;
    if (request.mode === "replace") {
      existing = await DatasheetModel.findById(request.datasheetId, {
        storageKey: 1,
      }).lean<Pick<Datasheet, "_id" | "storageKey"> | null>();
      if (!existing) return formError(DATASHEET_NOT_FOUND);
    }

    const head = await headObject(incomingKey);
    if (head === null) return formError(UPLOAD_NOT_FOUND);
    if (head.size > MAX_DATASHEET_BYTES) return formError(SIZE_MISMATCH);
    // The presigned PUT stays usable for 5 minutes, so the incoming object
    // can be replaced while we work (gate E L-1). Pin one version by its
    // ETag: the read and the copy both carry it as a condition, so the copy
    // is exactly the bytes checkXlsx accepted, or it fails with
    // StorageConditionError (generic error below, nothing written). Without
    // an ETag the version cannot be pinned, so refuse.
    const etag = head.etag;
    if (!etag) return formError(UPLOAD_FAILED);

    const bytes = await getObjectBytes(incomingKey, MAX_DATASHEET_BYTES, {
      ifMatch: etag,
    });
    if (bytes === null) return formError(UPLOAD_NOT_FOUND);
    const check = await checkXlsx(bytes);
    if (!check.ok) return formError(XLSX_REJECTED[check.reason]);

    const size = bytes.length;
    const storageKey =
      existing?.storageKey ?? `datasheets/${randomUUID()}.xlsx`;
    await copyObject(incomingKey, storageKey, { ifMatch: etag });

    if (existing) {
      const result = await DatasheetModel.updateOne(
        { _id: existing._id },
        { $set: { fileName, size, uploadedBy: new ObjectId(actorId) } },
        { runValidators: true },
      );
      if (result.matchedCount === 0) {
        // Deleted while we worked: the copy recreated its object. Remove it.
        await deleteQuietly(storageKey, "a replaced datasheet's object");
        return formError(DATASHEET_NOT_FOUND);
      }
      return await auditAndFinish(
        {
          actorId,
          action: "datasheet.replace",
          target: { type: "datasheet", id: existing._id.toHexString() },
          meta: { size },
        },
        { id: existing._id.toHexString(), fileName, size },
        TAGS,
      );
    }

    let id: string;
    try {
      const created = await DatasheetModel.create({
        storageKey,
        fileName,
        size,
        mimeType: XLSX_MIME_TYPE,
        uploadedBy: new ObjectId(actorId),
      });
      id = created._id.toHexString();
    } catch (error) {
      await deleteQuietly(storageKey, "an unsaved datasheet's object");
      throw error;
    }
    return await auditAndFinish(
      {
        actorId,
        action: "datasheet.upload",
        target: { type: "datasheet", id },
        meta: { size },
      },
      { id, fileName, size },
      TAGS,
    );
  } catch (error) {
    // R2 or the database failed: generic message, class name only in the log.
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[datasheets] finalize failed: ${kind}`);
    return formError(UPLOAD_FAILED);
  } finally {
    await deleteQuietly(incomingKey, "an incoming upload");
  }
}

// ---------------------------------------------------------------------------
// Rename and delete
// ---------------------------------------------------------------------------

/** Changes the file name shown (and used for downloads). The file is untouched. */
export async function renameDatasheet(
  actorId: string,
  input: unknown,
): Promise<ServiceResult<{ id: string; fileName: string }>> {
  assertActorId(actorId);
  const parsed = renameDatasheetInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { id, fileName } = parsed.data;

  await connectDb();
  const current = await DatasheetModel.findById(id, {
    fileName: 1,
  }).lean<Pick<Datasheet, "fileName"> | null>();
  if (!current) return formError(DATASHEET_NOT_FOUND);
  if (current.fileName === fileName) return unchanged({ id, fileName });

  const result = await DatasheetModel.updateOne(
    { _id: new ObjectId(id) },
    { $set: { fileName } },
    { runValidators: true },
  );
  if (result.matchedCount === 0) return formError(DATASHEET_NOT_FOUND);

  return auditAndFinish(
    {
      actorId,
      action: "datasheet.rename",
      target: { type: "datasheet", id },
    },
    { id, fileName },
    TAGS,
  );
}

/**
 * Deletes a datasheet, refused while any product still points at it (the
 * admin is told how many). The R2 object is deleted BEFORE the document: if
 * R2 fails the document stays and the delete can be retried; the reverse
 * order would leave an unreachable private file. A product can only attach a
 * datasheet that exists (updateProduct checks), so the window between the
 * in-use check and the delete is a few milliseconds.
 */
export async function deleteDatasheet(
  actorId: string,
  id: unknown,
): Promise<ServiceResult<{ id: string }>> {
  assertActorId(actorId);
  const parsedId = datasheetIdSchema.safeParse(id);
  if (!parsedId.success) return formError(DATASHEET_NOT_FOUND);
  const selfId = new ObjectId(parsedId.data);

  await connectDb();
  const doc = await DatasheetModel.findById(selfId, {
    storageKey: 1,
  }).lean<Pick<Datasheet, "storageKey"> | null>();
  if (!doc) return formError(DATASHEET_NOT_FOUND);

  // Uses the { datasheetId } index.
  const inUse = await ProductModel.countDocuments({ datasheetId: selfId });
  if (inUse > 0) return formError(inUseMessage(inUse));

  try {
    await deleteObject(doc.storageKey);
  } catch (error) {
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[datasheets] could not delete the stored file: ${kind}`);
    return formError(UPLOAD_FAILED);
  }

  const result = await DatasheetModel.deleteOne({ _id: selfId });
  if (result.deletedCount === 0) return formError(DATASHEET_NOT_FOUND);

  return auditAndFinish(
    {
      actorId,
      action: "datasheet.delete",
      target: { type: "datasheet", id: parsedId.data },
    },
    { id: parsedId.data },
    TAGS,
  );
}
