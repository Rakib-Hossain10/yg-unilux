// The `datasheets` collection (ADR 0001): one document per restricted .xlsx
// file in the private R2 bucket. Products point to it with `datasheetId`, so
// one file can serve many products. The file itself is never public.

import type { Types } from "mongoose";

import { MAX_DATASHEET_BYTES, XLSX_MIME_TYPE } from "@/lib/constants";
import { mongoose } from "@/lib/db";

import { defineModel } from "./shared";

const { Schema } = mongoose;

/** A datasheet document as stored (and as returned by `lean()`). */
export interface Datasheet {
  _id: Types.ObjectId;
  /** The object key in the private R2 bucket. Stays the same when replaced. */
  storageKey: string;
  /** The original file name, used for the download. */
  fileName: string;
  /** File size in bytes. */
  size: number;
  mimeType: typeof XLSX_MIME_TYPE;
  /** The admin user who uploaded the current file (Better Auth user id). */
  uploadedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const datasheetSchema = new Schema<Datasheet>(
  {
    storageKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 512,
    },
    fileName: { type: String, required: true, trim: true, maxlength: 255 },
    // 1 byte to 10 MB. The upload route also checks the real size and the
    // file signature; this is the last line of defence.
    size: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_DATASHEET_BYTES,
      validate: {
        validator: Number.isInteger,
        message: "size must be whole bytes",
      },
    },
    // .xlsx only.
    mimeType: { type: String, required: true, enum: [XLSX_MIME_TYPE] },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { collection: "datasheets", timestamps: true, strict: "throw" },
);

// One document per stored object, so a key is never shared by two records.
datasheetSchema.index({ storageKey: 1 }, { unique: true });

export const DatasheetModel = defineModel<Datasheet>(
  "Datasheet",
  datasheetSchema,
);
