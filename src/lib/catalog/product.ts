// Cached public reads of one product page and of the published slug list
// (ADR 0062, 0063). Restricted columns are projected away using the current
// column visibility; drafts and unknown slugs are null. Never reads a session.

import "server-only";

import type { Types } from "mongoose";
import { unstable_cache } from "next/cache";

import { getColumnVisibility } from "@/lib/admin/settings";
import { connectDb } from "@/lib/db";
import { CATALOG_TAGS } from "@/lib/revalidate";
import { MAX_SLUG_LENGTH, SLUG_PATTERN } from "@/lib/slug";
import { AreaModel, ProductModel } from "@/models";
import type { Area } from "@/models/area";

import {
  publicProductProjection,
  publicSpecKeys,
  toPublicProductView,
  type PublicAreaView,
  type PublicProductDoc,
  type PublicProductView,
} from "./view";

type AreaDoc = Pick<Area, "_id" | "name" | "slug" | "bwImage" | "order">;

async function loadAreas(
  ids: readonly Types.ObjectId[],
): Promise<PublicAreaView[]> {
  if (ids.length === 0) return [];
  const docs = await AreaModel.find(
    { _id: { $in: [...ids] } },
    { name: 1, slug: 1, bwImage: 1, order: 1 },
  )
    .sort({ order: 1, name: 1 })
    .lean<AreaDoc[]>();
  return docs.map((area) => ({
    id: String(area._id),
    name: area.name,
    slug: area.slug,
    bwImage: area.bwImage ?? null,
  }));
}

async function readPublicProduct(
  slug: string,
): Promise<PublicProductView | null> {
  await connectDb();
  // Inside the cache entry, tagged settings:columns: a visibility change
  // expires it at once (revalidate.ts ALWAYS_IMMEDIATE).
  const publicKeys = publicSpecKeys(await getColumnVisibility());
  const doc = await ProductModel.findOne(
    { slug, status: "published" },
    publicProductProjection(publicKeys),
  ).lean<PublicProductDoc | null>();
  if (!doc) return null;
  const areas = await loadAreas(doc.areas ?? []);
  return toPublicProductView(doc, publicKeys, areas);
}

/*
 * Tags: every product write (admin, import) expires `products`, so that tag
 * covers this entry; a slug-keyed entry cannot carry `product:<id>` because
 * unstable_cache fixes its tags before the id is known (ADR 0063).
 */
const cachedPublicProduct = unstable_cache(
  readPublicProduct,
  ["catalog", "public-product", "v1"],
  {
    tags: [
      CATALOG_TAGS.products,
      CATALOG_TAGS.areas,
      CATALOG_TAGS.settingsColumns,
    ],
  },
);

/**
 * The published product with this slug, restricted columns left out, or null
 * (draft, unknown or malformed slug). Cached until a tag is expired.
 */
export async function getPublicProduct(
  slug: string,
): Promise<PublicProductView | null> {
  if (
    typeof slug !== "string" ||
    slug.length > MAX_SLUG_LENGTH ||
    !SLUG_PATTERN.test(slug)
  ) {
    return null;
  }
  return cachedPublicProduct(slug);
}

/** One published product page, for static params and the sitemap. */
export interface PublishedSlug {
  slug: string;
  updatedAt: string;
}

async function readPublishedSlugs(): Promise<PublishedSlug[]> {
  await connectDb();
  const docs = await ProductModel.find(
    { status: "published" },
    { slug: 1, updatedAt: 1 },
  )
    .sort({ slug: 1 })
    .lean<{ slug: string; updatedAt?: Date }[]>();
  return docs.map((doc) => ({
    slug: doc.slug,
    updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : "",
  }));
}

/** Every published slug (sorted) with its last change. Cached on `products`. */
export const listPublishedSlugs: () => Promise<PublishedSlug[]> =
  unstable_cache(readPublishedSlugs, ["catalog", "published-slugs", "v1"], {
    tags: [CATALOG_TAGS.products],
  });
