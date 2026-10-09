// Cached category index for the public site (ADR 0063) and the product
// breadcrumb built from it: main category first, down to the product's main
// category. Tagged `categories`; never reads a session.

import "server-only";

import { unstable_cache } from "next/cache";

import { MAX_CATEGORY_DEPTH } from "@/lib/constants";
import { connectDb } from "@/lib/db";
import { CATALOG_TAGS } from "@/lib/revalidate";
import { CategoryModel } from "@/models";
import type { Category } from "@/models/category";

import { CATALOG_CACHE_VERSION } from "./cache-version";
import type { BreadcrumbItem, PublicProductView } from "./view";

/**
 * One category as the public site needs it. Every field is public (no spec
 * value, rule 9). `icon` and `coverImage` are Cloudinary public ids; the
 * icon may be an SVG upload, so it must always be delivered with an explicit
 * raster format (f_png / f_webp), never inlined (Phase 4b Q7).
 */
export interface PublicCategoryView extends BreadcrumbItem {
  parentId: string | null;
  order: number;
  icon: string | null;
  coverImage: string | null;
  description: string | null;
}

type CategoryDoc = Pick<
  Category,
  | "_id"
  | "name"
  | "slug"
  | "parent"
  | "order"
  | "icon"
  | "coverImage"
  | "description"
>;

async function readCategories(): Promise<PublicCategoryView[]> {
  await connectDb();
  const docs = await CategoryModel.find(
    {},
    {
      name: 1,
      slug: 1,
      parent: 1,
      order: 1,
      icon: 1,
      coverImage: 1,
      description: 1,
    },
  )
    .sort({ order: 1, name: 1 })
    .lean<CategoryDoc[]>();
  return docs.map((doc) => ({
    id: String(doc._id),
    name: doc.name,
    slug: doc.slug,
    parentId: doc.parent ? String(doc.parent) : null,
    order: doc.order,
    icon: doc.icon ?? null,
    coverImage: doc.coverImage ?? null,
    description: doc.description ?? null,
  }));
}

/** Every category (the whole tree is small), cached on `categories`. */
export const listPublicCategories: () => Promise<PublicCategoryView[]> =
  unstable_cache(
    readCategories,
    ["catalog", "categories", CATALOG_CACHE_VERSION],
    {
      tags: [CATALOG_TAGS.categories],
    },
  );

/**
 * The path from the main (top) category down to the product's main category.
 * Empty when the category no longer exists. A broken tree (a cycle or more
 * levels than MAX_CATEGORY_DEPTH) is cut, never looped.
 */
export async function getBreadcrumb(
  product: Pick<PublicProductView, "mainCategoryId">,
): Promise<BreadcrumbItem[]> {
  const byId = new Map(
    (await listPublicCategories()).map((category) => [category.id, category]),
  );
  const path: BreadcrumbItem[] = [];
  const seen = new Set<string>();
  let current = byId.get(product.mainCategoryId);
  while (current && !seen.has(current.id) && path.length < MAX_CATEGORY_DEPTH) {
    seen.add(current.id);
    path.unshift({ id: current.id, name: current.name, slug: current.slug });
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}
