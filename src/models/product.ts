// The `products` collection: one document per product page (one sheet "NO."),
// with its variants (one per sheet row / model no.), specs, filter numbers,
// images and the datasheet it links to. Filled by the admin (Phase 2) and the
// bulk import (Phase 3).

import type { Types } from "mongoose";

import { mongoose } from "@/lib/db";

import {
  PRODUCT_IMAGE_KINDS,
  PRODUCT_STATUSES,
  TRACK_SIZES,
  type ProductImageKind,
  type ProductStatus,
  type TrackSize,
} from "./product-constants";
import { defineModel, publicIdField, shortText, slugField } from "./shared";
import { SPEC_KEYS, type SpecKey, type SpecValues } from "./spec-columns";

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

// Re-exported so existing imports from "@/models/product" keep working.
export { PRODUCT_IMAGE_KINDS, PRODUCT_STATUSES, TRACK_SIZES };
export type { ProductImageKind, ProductStatus, TrackSize };

/** A public product photo or drawing stored in Cloudinary. */
export interface ProductImage {
  publicId: string;
  alt?: string;
  /** Display order within the product, 0 first. */
  order: number;
  kind: ProductImageKind;
}

/**
 * One sheet row: a model no. with an optic or other option. Its specs hold
 * only the values that differ from the product-level specs.
 */
export interface ProductVariant {
  modelNo: string;
  /** Shown on the optic switch, e.g. "Regular lens". */
  label?: string;
  specs?: SpecValues;
  imagePublicId?: string;
}

/** Parsed numbers used by the listing filters. */
export interface ProductFilters {
  cctK?: number[];
  cri?: number[];
  beamDeg?: number[];
  ugr?: number[];
  wattage?: number[];
  ip?: number[];
}

/** Extra information outside the sheet. Always public. */
export interface ExtraSpec {
  group?: string;
  label: string;
  value: string;
}

/** A public download such as an installation guide (never a datasheet). */
export interface PublicFile {
  label: string;
  url: string;
}

/** A product document as stored (and as returned by `lean()`). */
export interface Product {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  modelCode?: string;
  family?: string;
  productNo?: number;
  type?: string;
  description?: string;
  mainCategory: Types.ObjectId;
  extraCategories: Types.ObjectId[];
  areas: Types.ObjectId[];
  trackSize?: TrackSize;
  images: ProductImage[];
  specs?: SpecValues;
  filters?: ProductFilters;
  variants: ProductVariant[];
  extraSpecs: ExtraSpec[];
  publicFiles: PublicFile[];
  datasheetId: Types.ObjectId | null;
  status: ProductStatus;
  featured: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/*
 * Specs: one fixed key per sheet column (see spec-columns.ts), each an array
 * of English display strings. `default: undefined` keeps unused columns out of
 * the document instead of storing 28 empty arrays; a missing key means "not
 * applicable" and is hidden. The same sub-schema is used for variant specs.
 */
const specValue = {
  type: [{ type: String, trim: true, maxlength: 500 }],
  default: undefined,
};
const specsSchema = new Schema<SpecValues>(
  Object.fromEntries(SPEC_KEYS.map((key) => [key, specValue])) as Record<
    SpecKey,
    typeof specValue
  >,
  { _id: false, strict: "throw" },
);

/*
 * Filters: the numbers parsed from the display strings across the product and
 * all its variants (e.g. "3000K" -> 3000), so listings can filter with plain
 * range and $in queries. Empty filters are left out of the document.
 */
const filterValue = { type: [{ type: Number, min: 0 }], default: undefined };
const filtersSchema = new Schema<ProductFilters>(
  {
    cctK: filterValue,
    cri: filterValue,
    beamDeg: filterValue,
    ugr: filterValue,
    wattage: filterValue,
    ip: filterValue,
  },
  { _id: false, strict: "throw" },
);

/*
 * Array items below have no `_id` of their own: each has a natural key
 * (publicId, modelNo) or is always edited as a whole list.
 */
const imageSchema = new Schema<ProductImage>(
  {
    publicId: { ...publicIdField, required: true },
    alt: shortText,
    order: { type: Number, required: true, min: 0, default: 0 },
    kind: {
      type: String,
      required: true,
      enum: PRODUCT_IMAGE_KINDS,
      default: "gallery",
    },
  },
  { _id: false, strict: "throw" },
);

const variantSchema = new Schema<ProductVariant>(
  {
    modelNo: { type: String, required: true, trim: true, maxlength: 64 },
    label: { type: String, trim: true, maxlength: 100 },
    specs: specsSchema,
    imagePublicId: publicIdField,
  },
  { _id: false, strict: "throw" },
);

const extraSpecSchema = new Schema<ExtraSpec>(
  {
    group: { type: String, trim: true, maxlength: 100 },
    label: { type: String, required: true, trim: true, maxlength: 100 },
    value: { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { _id: false, strict: "throw" },
);

const publicFileSchema = new Schema<PublicFile>(
  {
    label: { ...shortText, required: true },
    // HTTPS only: these links are rendered on public pages.
    url: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2048,
      match: /^https:\/\/\S+$/,
    },
  },
  { _id: false, strict: "throw" },
);

/** True when no two variants of one product share a model no. */
function hasUniqueModelNos(variants: ProductVariant[]): boolean {
  const modelNos = variants.map((variant) => variant.modelNo);
  return new Set(modelNos).size === modelNos.length;
}

const productSchema = new Schema<Product>(
  {
    // Identity. `family` is the sheet's Model Name ("Arc", for the "More from
    // Arc" strip), `modelCode` the base model code ("AR-013A"), `productNo`
    // the sheet's NO. and `type` its Model Type.
    name: { ...shortText, required: true },
    slug: slugField,
    modelCode: { type: String, trim: true, maxlength: 64 },
    family: { type: String, trim: true, maxlength: 100 },
    productNo: {
      type: Number,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "productNo must be a whole number",
      },
    },
    type: { type: String, trim: true, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 5000 },

    // Browse dimensions: product type (category tree) and application areas.
    // `extraCategories` lists other categories the product also appears under.
    mainCategory: { type: ObjectId, ref: "Category", required: true },
    extraCategories: {
      type: [{ type: ObjectId, ref: "Category" }],
      default: [],
    },
    areas: { type: [{ type: ObjectId, ref: "Area" }], default: [] },
    trackSize: { type: Number, enum: TRACK_SIZES },

    images: { type: [imageSchema], default: [] },
    specs: specsSchema,
    filters: filtersSchema,
    variants: {
      type: [variantSchema],
      default: [],
      // The unique index below stops two PRODUCTS sharing a model no., but a
      // MongoDB unique index does not compare entries inside one document.
      validate: {
        validator: hasUniqueModelNos,
        message: "Two variants of this product have the same model no.",
      },
    },
    extraSpecs: { type: [extraSpecSchema], default: [] },
    publicFiles: { type: [publicFileSchema], default: [] },
    // The restricted .xlsx (ADR 0001). null = "Datasheet coming soon".
    datasheetId: { type: ObjectId, ref: "Datasheet", default: null },

    status: {
      type: String,
      required: true,
      enum: PRODUCT_STATUSES,
      default: "draft",
    },
    featured: { type: Boolean, required: true, default: false },
  },
  { collection: "products", timestamps: true, strict: "throw" },
);

/*
 * Indexes (ADR 0008). Built by `npm run db:indexes`, never on startup.
 */
// One product page per slug.
productSchema.index({ slug: 1 }, { unique: true });
// No model no. may belong to two products: re-import upserts by model no.
// The partial filter skips products that have no variants yet; without it
// they would all index as "missing" and collide with each other.
productSchema.index(
  { "variants.modelNo": 1 },
  {
    unique: true,
    partialFilterExpression: { "variants.modelNo": { $exists: true } },
  },
);
// Category, area and family pages.
productSchema.index({ mainCategory: 1 });
productSchema.index({ extraCategories: 1 });
productSchema.index({ areas: 1 });
productSchema.index({ family: 1 });
productSchema.index({ status: 1 });
// Published products of one main category: the main listing query.
productSchema.index({ status: 1, mainCategory: 1 });
// "Which products use this datasheet": the in-use count on the datasheets
// list and the check that blocks deleting a datasheet still attached.
productSchema.index({ datasheetId: 1 });

export const ProductModel = defineModel<Product>("Product", productSchema);
