// Cached "Related" strip (ADR 0063): published products of the same main
// category that share an area with the product, excluding the product and its
// own family (they have their own strip). Cards carry no spec values.

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
  type PublicProductView,
} from "./view";

/** The most cards the related strip shows. */
export const RELATED_STRIP_LIMIT = 8;

const isHexId = (id: string): boolean => /^[0-9a-f]{24}$/i.test(id);

async function readRelatedProducts(
  productId: string,
  mainCategoryId: string,
  areaIds: string[],
  family: string,
): Promise<ProductCardView[]> {
  await connectDb();
  const filter: Record<string, unknown> = {
    status: "published",
    mainCategory: new Types.ObjectId(mainCategoryId),
    _id: { $ne: new Types.ObjectId(productId) },
  };
  // No areas on the product: same main category is the only signal.
  if (areaIds.length > 0) {
    filter.areas = { $in: areaIds.map((id) => new Types.ObjectId(id)) };
  }
  if (family !== "") filter.family = { $ne: family };
  const docs = await ProductModel.find(filter, PRODUCT_CARD_PROJECTION)
    .sort({ productNo: 1, name: 1, _id: 1 })
    .limit(RELATED_STRIP_LIMIT)
    .lean<ProductCardDoc[]>();
  return docs.map(toProductCardView);
}

const cachedRelatedProducts = unstable_cache(
  readRelatedProducts,
  ["catalog", "related-products", "v1"],
  { tags: [CATALOG_TAGS.products] },
);

/** What the related query needs from a product view. */
export type RelatedSource = Pick<
  PublicProductView,
  "id" | "mainCategoryId" | "areas" | "family"
>;

/**
 * Up to RELATED_STRIP_LIMIT published products related to `product`. The
 * cache key holds only ids and the family name (sorted, lowercased ids).
 */
export async function getRelatedProducts(
  product: RelatedSource,
): Promise<ProductCardView[]> {
  if (!isHexId(product.id) || !isHexId(product.mainCategoryId)) return [];
  const areaIds = [
    ...new Set(
      product.areas.map((area) => area.id.toLowerCase()).filter(isHexId),
    ),
  ].sort();
  return cachedRelatedProducts(
    product.id.toLowerCase(),
    product.mainCategoryId.toLowerCase(),
    areaIds,
    product.family?.trim() ?? "",
  );
}
