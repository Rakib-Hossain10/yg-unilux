// The `leaders` collection: the people in the About / leadership carousel.
// Photos are always real client photos, stored in Cloudinary.

import type { Types } from "mongoose";

import { mongoose } from "@/lib/db";

import { defineModel, publicIdField, shortText } from "./shared";

const { Schema } = mongoose;

/** A leader's portrait. */
export interface LeaderPhoto {
  /** Cloudinary public id. */
  publicId: string;
  alt?: string;
}

/** A leader document as stored (and as returned by `lean()`). */
export interface Leader {
  _id: Types.ObjectId;
  name: string;
  /** Job title, e.g. "Managing Director". */
  title: string;
  location?: string;
  photo?: LeaderPhoto;
  /** Display order, 0 first. */
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const leaderPhotoSchema = new Schema<LeaderPhoto>(
  {
    publicId: { ...publicIdField, required: true },
    alt: shortText,
  },
  { _id: false, strict: "throw" },
);

const leaderSchema = new Schema<Leader>(
  {
    name: { ...shortText, required: true },
    title: { ...shortText, required: true },
    location: { type: String, trim: true, maxlength: 100 },
    photo: leaderPhotoSchema,
    order: { type: Number, required: true, min: 0, default: 0 },
  },
  // A handful of documents, read in full: no extra indexes needed.
  { collection: "leaders", timestamps: true, strict: "throw" },
);

export const LeaderModel = defineModel<Leader>("Leader", leaderSchema);
