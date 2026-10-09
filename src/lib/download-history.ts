// A signed-in user's own datasheet download history for /my-downloads (plan
// Q8): newest first, 20 per page. Uncached and per user: it is only ever
// called with the id of the session's own user (the page reads it from the
// database session). Reads only: downloadLogs, then the products and
// datasheets those entries name, each with a narrow projection. No spec
// value, restricted or public, and no storage key is ever read.

import "server-only";

import { Types } from "mongoose";
import { z } from "zod";

import { DatasheetModel, DownloadLogModel, ProductModel } from "@/models";

import { connectDb } from "./db";

export const DOWNLOAD_HISTORY_PAGE_SIZE = 20;

/*
 * Deep pages cost a skip over the user's index range; nobody downloads
 * 20 000 datasheets, so bigger numbers are refused before any query.
 */
export const MAX_DOWNLOAD_HISTORY_PAGE = 1000;

/**
 * `?page=` as the page reads it: a whole number from 1 to the cap. Anything
 * else (missing, repeated, "abc", "0", "1e3", "-1", "2.5") is page 1.
 */
export const historyPageSchema = z
  .string()
  .regex(/^[1-9]\d{0,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAX_DOWNLOAD_HISTORY_PAGE))
  .catch(1);

/** A product as one history row shows it; null when it was deleted. */
export interface HistoryProduct {
  id: string;
  name: string;
  family: string | null;
  modelCode: string | null;
  slug: string;
  /** Published now: the name links to its page. */
  listed: boolean;
  /** Published with a datasheet attached: "Download again" can work. */
  downloadable: boolean;
}

export interface DownloadHistoryRow {
  id: string;
  downloadedAt: Date;
  product: HistoryProduct | null;
  /** The datasheet's current file name; null when the file was deleted. */
  fileName: string | null;
}

export interface DownloadHistoryPage {
  rows: DownloadHistoryRow[];
  /** The page shown: the requested one, moved back to the last page if past it. */
  page: number;
  pageCount: number;
  total: number;
}

interface LogLean {
  _id: Types.ObjectId;
  product: Types.ObjectId;
  datasheet: Types.ObjectId;
  downloadedAt: Date;
}

interface ProductLean {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  family?: string;
  modelCode?: string;
  status: string;
  datasheetId?: Types.ObjectId | null;
}

interface DatasheetLean {
  _id: Types.ObjectId;
  fileName: string;
}

/* Distinct ids, as ObjectIds, for one `$in`. */
function uniqueIds(ids: readonly Types.ObjectId[]): Types.ObjectId[] {
  return [...new Set(ids.map(String))].map((id) => new Types.ObjectId(id));
}

const nonEmpty = (value: string | undefined): string | null =>
  value && value.trim() !== "" ? value : null;

/**
 * One page of `userId`'s downloads. An id that isn't an ObjectId has no
 * history (empty page, no query). A page past the end shows the last page.
 * Database errors are thrown.
 */
export async function getDownloadHistory(
  userId: string,
  requestedPage: number,
): Promise<DownloadHistoryPage> {
  const page = historyPageSchema.parse(String(requestedPage));
  if (!Types.ObjectId.isValid(userId) || !/^[0-9a-f]{24}$/i.test(userId)) {
    return { rows: [], page: 1, pageCount: 1, total: 0 };
  }
  await connectDb();
  const user = new Types.ObjectId(userId);

  const total = await DownloadLogModel.countDocuments({ user });
  const pageCount = Math.max(1, Math.ceil(total / DOWNLOAD_HISTORY_PAGE_SIZE));
  const shown = Math.min(page, pageCount);
  if (total === 0) return { rows: [], page: 1, pageCount, total };

  // The { user: 1, downloadedAt: -1 } index serves the filter and the sort;
  // _id breaks ties so paging never repeats or skips an entry.
  const logs = await DownloadLogModel.find(
    { user },
    { product: 1, datasheet: 1, downloadedAt: 1 },
  )
    .sort({ downloadedAt: -1, _id: -1 })
    .skip((shown - 1) * DOWNLOAD_HISTORY_PAGE_SIZE)
    .limit(DOWNLOAD_HISTORY_PAGE_SIZE)
    .lean<LogLean[]>();

  const [products, datasheets] = await Promise.all([
    ProductModel.find(
      { _id: { $in: uniqueIds(logs.map((log) => log.product)) } },
      {
        name: 1,
        slug: 1,
        family: 1,
        modelCode: 1,
        status: 1,
        datasheetId: 1,
      },
    ).lean<ProductLean[]>(),
    DatasheetModel.find(
      { _id: { $in: uniqueIds(logs.map((log) => log.datasheet)) } },
      { fileName: 1 },
    ).lean<DatasheetLean[]>(),
  ]);

  const productById = new Map(products.map((p) => [String(p._id), p]));
  const fileById = new Map(datasheets.map((d) => [String(d._id), d.fileName]));

  const rows = logs.map((log): DownloadHistoryRow => {
    const product = productById.get(String(log.product));
    const listed = product?.status === "published";
    return {
      id: String(log._id),
      downloadedAt: log.downloadedAt,
      fileName: fileById.get(String(log.datasheet)) ?? null,
      product: product
        ? {
            id: String(product._id),
            name: product.name,
            family: nonEmpty(product.family),
            modelCode: nonEmpty(product.modelCode),
            slug: product.slug,
            listed,
            downloadable: listed && product.datasheetId != null,
          }
        : null,
    };
  });

  return { rows, page: shown, pageCount, total };
}
