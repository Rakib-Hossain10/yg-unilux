// Cached public reads of one product page and of the published slug list
// (ADR 0062, 0063). Restricted columns are projected away using the column
// visibility read FRESH outside the cache and passed in as part of the cache
// key; drafts and unknown slugs are null. Never reads a session.

import "server-only";

import type { Types } from "mongoose";
import { unstable_cache } from "next/cache";

import { getColumnVisibility } from "@/lib/column-visibility";
import { connectDb } from "@/lib/db";
import { CATALOG_TAGS } from "@/lib/revalidate";
import { MAX_SLUG_LENGTH, SLUG_PATTERN } from "@/lib/slug";
import { AreaModel, ProductModel } from "@/models";
import {
  restrictedSpecKeys,
  SPEC_KEYS,
  type SpecKey,
} from "@/models/spec-columns";

import { CATALOG_CACHE_VERSION } from "./cache-version";

import {
  PUBLIC_AREA_PROJECTION,
  publicProductProjection,
  toPublicAreaView,
  toPublicProductView,
  type PublicAreaDoc,
  type PublicAreaView,
  type PublicProductDoc,
  type PublicProductView,
} from "./view";

async function loadAreas(
  ids: readonly Types.ObjectId[],
): Promise<PublicAreaView[]> {
  if (ids.length === 0) return [];
  const docs = await AreaModel.find(
    { _id: { $in: [...ids] } },
    PUBLIC_AREA_PROJECTION,
  )
    .sort({ order: 1, name: 1 })
    .lean<PublicAreaDoc[]>();
  return docs.map(toPublicAreaView);
}

/*
 * The public keys for the comma-joined restricted list in the cache key
 * (built by restrictedSpecKeys, which fails closed). A name that is not a
 * spec key is ignored; it can only ever take a column away, never add one.
 */
function publicKeysFromRestricted(restrictedKeys: string): SpecKey[] {
  const restricted = new Set(restrictedKeys.split(","));
  return SPEC_KEYS.filter((key) => !restricted.has(key));
}

async function readPublicProduct(
  slug: string,
  restrictedKeys: string,
): Promise<PublicProductView | null> {
  await connectDb();
  // The projection comes ONLY from the key argument, never from a read
  // inside the entry: an entry is valid for exactly the visibility it is
  // keyed by, so a fill that straddles a visibility save can never be
  // served under the new setting (ADR 0063, gate A M-1).
  const publicKeys = publicKeysFromRestricted(restrictedKeys);
  const doc = await ProductModel.findOne(
    { slug, status: "published" },
    publicProductProjection(publicKeys),
  ).lean<PublicProductDoc | null>();
  if (!doc) return null;
  const areas = await loadAreas(doc.areas ?? []);
  return toPublicProductView(doc, publicKeys, areas);
}

/*
 * Key: slug + the restricted keys (sheet order, comma-joined). Tags: every
 * product write (admin, import) expires `products`, so that tag covers this
 * entry; a slug-keyed entry cannot carry `product:<id>` because
 * unstable_cache fixes its tags before the id is known (ADR 0063).
 * `settings:columns` stays so a visibility change also drops old entries.
 */
const cachedPublicProduct = unstable_cache(
  readPublicProduct,
  ["catalog", "public-product", CATALOG_CACHE_VERSION],
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
  // L-3: only a slug on the (cached, bounded) published list gets an entry,
  // so random slugs cannot fill the cache with misses. A draft or unknown
  // slug is null without touching the product entry.
  const published = await listPublishedSlugs();
  if (!published.some((entry) => entry.slug === slug)) return null;
  // M-1: the visibility is read fresh (one small uncached read) and becomes
  // part of the cache key.
  await connectDb();
  const restricted = restrictedSpecKeys(await getColumnVisibility());
  return cachedPublicProduct(slug, restricted.join(","));
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
  unstable_cache(
    readPublishedSlugs,
    ["catalog", "published-slugs", CATALOG_CACHE_VERSION],
    {
      tags: [CATALOG_TAGS.products],
    },
  );
