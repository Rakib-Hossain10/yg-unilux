// The `areas` collection: the application areas (Residential, Retail,
// Hospitality, Office, Healthcare, Education, Exhibition), the second browse
// dimension next to categories. Stored in the database, edited by the admin.

import type { Types } from "mongoose";

import { mongoose } from "@/lib/db";

import { defineModel, publicIdField, shortText, slugField } from "./shared";

const { Schema } = mongoose;

/** An area document as stored (and as returned by `lean()`). */
export interface Area {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  /** Icon for menus. Its format is decided in Phase 4. */
  icon?: string;
  /** Cloudinary public id of the black-and-white image (home page scroll). */
  bwImage?: string;
  /** Display order, 0 first. */
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const areaSchema = new Schema<Area>(
  {
    name: { ...shortText, required: true },
    slug: slugField,
    icon: { type: String, trim: true, maxlength: 255 },
    bwImage: publicIdField,
    order: { type: Number, required: true, min: 0, default: 0 },
  },
  { collection: "areas", timestamps: true, strict: "throw" },
);

// One area page per slug.
areaSchema.index({ slug: 1 }, { unique: true });

export const AreaModel = defineModel<Area>("Area", areaSchema);
