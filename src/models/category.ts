// The `categories` collection: the product-type tree (e.g. Spot Lights >
// Recessed). Main categories have `parent: null`; the tree is edited in the
// admin panel, so the list is never hard-coded.

import type { Types } from "mongoose";

import { mongoose } from "@/lib/db";

import { defineModel, publicIdField, shortText, slugField } from "./shared";

const { Schema } = mongoose;

/** A category document as stored (and as returned by `lean()`). */
export interface Category {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  /** null = a main category; otherwise the parent category's id. */
  parent: Types.ObjectId | null;
  /** Position among its siblings, 0 first. */
  order: number;
  /** Icon shown in the mega-menu strip. Its format is decided in Phase 4. */
  icon?: string;
  /** Cloudinary public id of the cover image. */
  coverImage?: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<Category>(
  {
    name: { ...shortText, required: true },
    slug: slugField,
    parent: { type: Schema.Types.ObjectId, ref: "Category", default: null },
    order: { type: Number, required: true, min: 0, default: 0 },
    icon: { type: String, trim: true, maxlength: 255 },
    coverImage: publicIdField,
    description: { type: String, trim: true, maxlength: 2000 },
  },
  { collection: "categories", timestamps: true, strict: "throw" },
);

// Slugs are unique among siblings, so "Recessed" can exist under two parents.
// Main categories share parent null, so their slugs are unique too.
categorySchema.index({ parent: 1, slug: 1 }, { unique: true });
// Children of one parent in display order (menus, the admin tree).
categorySchema.index({ parent: 1, order: 1 });

export const CategoryModel = defineModel<Category>("Category", categorySchema);
