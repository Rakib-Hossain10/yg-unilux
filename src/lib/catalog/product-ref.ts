// Uncached lookup of a published product by id for the restricted-specs
// route (P7): does it exist, and does it have a datasheet? Reads no spec
// value, no session and no datasheet record (so no storage key). Also the
// public label (name, model code, slug) /request-access shows (P6).

import "server-only";

import type { Types } from "mongoose";

import { connectDb } from "@/lib/db";
import { OBJECT_ID_PATTERN } from "@/lib/schemas/common";
import { ProductModel } from "@/models";

export interface PublishedProductRef {
  productId: string;
  hasDatasheet: boolean;
}

interface RefDoc {
  _id: Types.ObjectId;
  datasheetId?: Types.ObjectId | null;
}

/** The published product's ref, or null for a draft, unknown or malformed id. */
export async function getPublishedProductRef(
  productId: string,
): Promise<PublishedProductRef | null> {
  if (typeof productId !== "string" || !OBJECT_ID_PATTERN.test(productId)) {
    return null;
  }
  await connectDb();
  const doc = await ProductModel.findOne(
    { _id: productId.toLowerCase(), status: "published" },
    { _id: 1, datasheetId: 1 },
  ).lean<RefDoc | null>();
  if (!doc) return null;
  return { productId: String(doc._id), hasDatasheet: doc.datasheetId != null };
}

/** What /request-access shows about the product it was opened from. */
export interface PublishedProductLabel {
  productId: string;
  slug: string;
  name: string;
  modelCode: string | null;
}

interface LabelDoc {
  _id: Types.ObjectId;
  slug: string;
  name: string;
  modelCode?: string | null;
}

/**
 * The public name, base model code and slug of a published product, or null
 * for a draft, unknown or malformed id (Phase 5 P6). Uncached: the request
 * page renders per request anyway. Reads no spec value and no datasheet.
 */
export async function getPublishedProductLabel(
  productId: string,
): Promise<PublishedProductLabel | null> {
  if (typeof productId !== "string" || !OBJECT_ID_PATTERN.test(productId)) {
    return null;
  }
  await connectDb();
  const doc = await ProductModel.findOne(
    { _id: productId.toLowerCase(), status: "published" },
    { _id: 1, slug: 1, name: 1, modelCode: 1 },
  ).lean<LabelDoc | null>();
  if (!doc) return null;
  return {
    productId: String(doc._id),
    slug: doc.slug,
    name: doc.name,
    modelCode: doc.modelCode ?? null,
  };
}
