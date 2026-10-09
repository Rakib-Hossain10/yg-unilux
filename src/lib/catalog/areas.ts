// Cached public list of application areas (ADR 0065): the `/areas` index,
// area pages and the mega-menu "Applications" column. Tagged `areas`; the
// slug lookup reads the same single entry, so random slugs add no entries.

import "server-only";

import { unstable_cache } from "next/cache";

import { connectDb } from "@/lib/db";
import { CATALOG_TAGS } from "@/lib/revalidate";
import { MAX_SLUG_LENGTH, SLUG_PATTERN } from "@/lib/slug";
import { AreaModel } from "@/models";

import { CATALOG_CACHE_VERSION } from "./cache-version";
import {
  PUBLIC_AREA_PROJECTION,
  toPublicAreaView,
  type PublicAreaDoc,
  type PublicAreaView,
} from "./view";

async function readAreas(): Promise<PublicAreaView[]> {
  await connectDb();
  const docs = await AreaModel.find({}, PUBLIC_AREA_PROJECTION)
    .sort({ order: 1, name: 1, _id: 1 })
    .lean<PublicAreaDoc[]>();
  return docs.map(toPublicAreaView);
}

/** Every area in display order (order, then name). Cached on `areas`. */
export const listPublicAreas: () => Promise<PublicAreaView[]> = unstable_cache(
  readAreas,
  ["catalog", "areas", CATALOG_CACHE_VERSION],
  { tags: [CATALOG_TAGS.areas] },
);

/** The area with this slug, or null (unknown or malformed slug). */
export async function getAreaBySlug(
  slug: string,
): Promise<PublicAreaView | null> {
  if (
    typeof slug !== "string" ||
    slug.length > MAX_SLUG_LENGTH ||
    !SLUG_PATTERN.test(slug)
  ) {
    return null;
  }
  return (await listPublicAreas()).find((area) => area.slug === slug) ?? null;
}
