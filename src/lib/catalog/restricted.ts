// The ONLY site code that reads restricted spec values (ADR 0002, 0063). It is
// never cached: it checks the viewer's session first, then reads the current
// visibility and only the restricted columns of one published product.

import "server-only";

import { getColumnVisibility } from "@/lib/column-visibility";
import { connectDb } from "@/lib/db";
import { canSeeRestricted, getViewer } from "@/lib/permissions";
import { ProductModel } from "@/models";
import type { Product } from "@/models/product";
import {
  restrictedSpecKeys,
  type SpecKey,
  type SpecValues,
} from "@/models/spec-columns";

import { mergeVariantSpecs, pickSpecs, type Projection } from "./view";

/** One variant's restricted values (product values merged in). */
export interface RestrictedVariantView {
  modelNo: string;
  specs: SpecValues;
}

/** The restricted values of one product, for an allowed viewer only. */
export interface RestrictedSpecsView {
  productId: string;
  /** The restricted columns under the current setting, in sheet order. */
  keys: SpecKey[];
  /** Product-level restricted values. */
  specs: SpecValues;
  /** Same order as the product's variants (and PublicProductView.variants). */
  variants: RestrictedVariantView[];
}

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** Restricted columns only, plus what is needed to line variants up. */
function restrictedProjection(keys: readonly SpecKey[]): Projection {
  const projection: Projection = { "variants.modelNo": 1 };
  for (const key of keys) {
    projection[`specs.${key}`] = 1;
    projection[`variants.specs.${key}`] = 1;
  }
  return projection;
}

type RestrictedDoc = Pick<Product, "_id"> &
  Partial<Pick<Product, "specs" | "variants">>;

/**
 * The restricted spec values of a published product, or null when the
 * current viewer may not see them (visitor, banned, expired, temporary
 * password, not a customer/admin: permissions.canSeeRestricted) or the
 * product is unknown, a draft or the id is malformed. Reads the session and
 * the visibility on every call; must never be wrapped in a cache.
 */
export async function getRestrictedSpecs(
  productId: string,
): Promise<RestrictedSpecsView | null> {
  if (typeof productId !== "string" || !OBJECT_ID_HEX.test(productId)) {
    return null;
  }
  // Permission first: nothing restricted is read for a refused viewer.
  const viewer = await getViewer();
  if (!canSeeRestricted(viewer?.user, new Date())) return null;

  await connectDb();
  const keys = restrictedSpecKeys(await getColumnVisibility());
  const doc = await ProductModel.findOne(
    { _id: productId.toLowerCase(), status: "published" },
    restrictedProjection(keys),
  ).lean<RestrictedDoc | null>();
  if (!doc) return null;

  const specs = pickSpecs(doc.specs, keys);
  return {
    productId: String(doc._id),
    keys,
    specs,
    variants: (doc.variants ?? []).map((variant) => ({
      modelNo: variant.modelNo,
      specs: mergeVariantSpecs(specs, pickSpecs(variant.specs, keys)),
    })),
  };
}
