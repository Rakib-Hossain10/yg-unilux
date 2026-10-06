// The `downloadLogs` collection: one entry per datasheet download through
// /api/datasheet/[productId] (who, which product, which file, when). Entries
// are only ever added, so there is no updatedAt.

import type { Types } from "mongoose";

import { mongoose } from "@/lib/db";

import { defineModel } from "./shared";

const { Schema } = mongoose;

/** A download log entry as stored (and as returned by `lean()`). */
export interface DownloadLog {
  _id: Types.ObjectId;
  /** The customer or admin who downloaded (Better Auth user id). */
  user: Types.ObjectId;
  product: Types.ObjectId;
  datasheet: Types.ObjectId;
  downloadedAt: Date;
}

const downloadLogSchema = new Schema<DownloadLog>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    datasheet: {
      type: Schema.Types.ObjectId,
      ref: "Datasheet",
      required: true,
    },
    downloadedAt: { type: Date, required: true, default: Date.now },
  },
  // `downloadedAt` is the only timestamp; an entry never changes.
  { collection: "downloadLogs", timestamps: false, strict: "throw" },
);

// A customer's download history (/my-downloads, admin customer page), newest first.
downloadLogSchema.index({ user: 1, downloadedAt: -1 });
// Who downloaded a product's datasheet, newest first (admin).
downloadLogSchema.index({ product: 1, downloadedAt: -1 });

export const DownloadLogModel = defineModel<DownloadLog>(
  "DownloadLog",
  downloadLogSchema,
);
