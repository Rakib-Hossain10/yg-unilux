// The data steps of GET /api/datasheet/[productId] (rule 2, ADR 0071): the
// published product and its datasheet reference, the datasheet file record,
// the per-user download limit and the download log. The access rule itself
// is permissions.checkDatasheetAccess (never repeated here), and the
// presigned URL is made only by the route itself (storage.ts).
// Uncached on purpose: every answer depends on the viewer.

import "server-only";

import { Types } from "mongoose";

import { DatasheetModel, DownloadLogModel, ProductModel } from "@/models";

import { hasRole } from "./auth";
import { connectDb } from "./db";
import type { AccessUser } from "./permissions";
import {
  buildKey,
  consume,
  hashUserId,
  type RateLimitResult,
  type RateLimitRule,
} from "./rate-limit";
import { OBJECT_ID_PATTERN } from "./schemas/common";

/** 60 downloads per user per hour (plan Q9); the admin is exempt. */
export const DOWNLOAD_LIMIT: RateLimitRule = {
  limit: 60,
  windowSeconds: 3600,
};

/** A published product as the download route needs it. */
export interface DownloadProduct {
  id: string;
  slug: string;
  /** null: no datasheet attached ("Datasheet coming soon"). */
  datasheetId: string | null;
}

interface ProductDoc {
  _id: Types.ObjectId;
  slug: string;
  datasheetId?: Types.ObjectId | null;
}

/**
 * The published product with this id, or null for a draft, an unknown or a
 * malformed id. Reads only the id, slug and datasheet reference.
 */
export async function findDownloadProduct(
  productId: string,
): Promise<DownloadProduct | null> {
  if (!OBJECT_ID_PATTERN.test(productId)) return null;
  await connectDb();
  const doc = await ProductModel.findOne(
    { _id: productId.toLowerCase(), status: "published" },
    { _id: 1, slug: 1, datasheetId: 1 },
  ).lean<ProductDoc | null>();
  if (!doc) return null;
  return {
    id: String(doc._id),
    slug: doc.slug,
    datasheetId: doc.datasheetId == null ? null : String(doc.datasheetId),
  };
}

/** The stored file behind a datasheet. `storageKey` never leaves the server. */
export interface DatasheetFile {
  id: string;
  storageKey: string;
  fileName: string;
}

interface DatasheetDoc {
  _id: Types.ObjectId;
  storageKey: string;
  fileName: string;
}

/** The datasheet record, or null when it no longer exists. */
export async function findDatasheetFile(
  datasheetId: string,
): Promise<DatasheetFile | null> {
  if (!OBJECT_ID_PATTERN.test(datasheetId)) return null;
  await connectDb();
  const doc = await DatasheetModel.findById(datasheetId, {
    _id: 1,
    storageKey: 1,
    fileName: 1,
  }).lean<DatasheetDoc | null>();
  if (!doc) return null;
  return {
    id: String(doc._id),
    storageKey: doc.storageKey,
    fileName: doc.fileName,
  };
}

const EXEMPT: RateLimitResult = {
  allowed: true,
  remaining: DOWNLOAD_LIMIT.limit,
  retryAfterSeconds: 0,
};

/**
 * Counts one download for this user and decides atomically (60 per hour,
 * `download-user`, keyed by the HMAC of the user id). The admin is exempt
 * and counts nothing. Throws RateLimitUnavailableError when the counter
 * can't be reached: the caller must refuse (fail closed).
 */
export async function consumeDownload(
  user: AccessUser,
): Promise<RateLimitResult> {
  if (hasRole(user, "admin")) return EXEMPT;
  return consume(
    buildKey("download-user", hashUserId(user.id)),
    DOWNLOAD_LIMIT,
  );
}

/**
 * Writes the downloadLogs entry (who, which product, which file). Throws on
 * any failure; the route then refuses the download, so the history is
 * complete (plan Q9). Holds no URL and no storage key.
 */
export async function recordDownload(entry: {
  userId: string;
  productId: string;
  datasheetId: string;
}): Promise<void> {
  await connectDb();
  await DownloadLogModel.create({
    user: new Types.ObjectId(entry.userId),
    product: new Types.ObjectId(entry.productId),
    datasheet: new Types.ObjectId(entry.datasheetId),
  });
}
