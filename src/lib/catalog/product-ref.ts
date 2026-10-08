// Uncached lookup of a published product by id for the restricted-specs
// route (P7): does it exist, and does it have a datasheet? Reads no spec
// value, no session and no datasheet record (so no storage key).

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
