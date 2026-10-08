// Cached "More from {family}" strip (ADR 0063): other published products of
// the same family (sheet Model Name). Cards carry no spec values at all, so
// no restricted column can reach the strip. Never reads a session.

import "server-only";

import { Types } from "mongoose";
import { unstable_cache } from "next/cache";

import { connectDb } from "@/lib/db";
import { CATALOG_TAGS } from "@/lib/revalidate";
import { ProductModel } from "@/models";

import {
  PRODUCT_CARD_PROJECTION,
  toProductCardView,
  type ProductCardDoc,
  type ProductCardView,
} from "./view";

const isHexId = (id: string): boolean => /^[0-9a-f]{24}$/i.test(id);

/** The most cards one strip shows. */
export const FAMILY_STRIP_LIMIT = 12;

async function readFamilyProducts(
  family: string,
  excludeId: string,
): Promise<ProductCardView[]> {
  await connectDb();
  const docs = await ProductModel.find(
    {
      family,
      status: "published",
      _id: { $ne: new Types.ObjectId(excludeId) },
    },
    PRODUCT_CARD_PROJECTION,
  )
    .sort({ productNo: 1, name: 1, _id: 1 })
    .limit(FAMILY_STRIP_LIMIT)
    .lean<ProductCardDoc[]>();
  return docs.map(toProductCardView);
}

const cachedFamilyProducts = unstable_cache(
  readFamilyProducts,
  ["catalog", "family-products", "v1"],
  { tags: [CATALOG_TAGS.products] },
);

/**
 * Published products of `family`, except the product `excludeId` (the page
 * itself), by sheet NO. then name. Empty for a blank family or a bad id.
 */
export async function getFamilyProducts(
  family: string | null,
  excludeId: string,
): Promise<ProductCardView[]> {
  const name = family?.trim() ?? "";
  if (name === "" || !isHexId(excludeId)) return [];
  return cachedFamilyProducts(name, excludeId.toLowerCase());
}
