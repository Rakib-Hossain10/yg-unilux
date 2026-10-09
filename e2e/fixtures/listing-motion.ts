// The listing motion spec's data (Phase 4b L7), seeded ONCE by
// e2e/test-server.ts before `next start` (the category tree is cached on the
// first catalog request). One main category whose 12 published products each
// have a different CCT, so its CCT facet collapses behind "Show n more"
// (FACET_COLLAPSE_AT = 8). Sorts after every other seeded main category
// (order 30), so the mega-menu's first category and admin-catalog's bounded
// move-up loop are unaffected. No restricted value is needed here.

import { type Db, ObjectId } from "mongodb";

const RUN = "fx1";

export const LISTING_MOTION = {
  mainId: new ObjectId("64f0000000000000000002a1"),
  main: { name: "Motion Lights", slug: `e2e-motion-${RUN}` },
  /** CCT values in kelvin, one product each (ascending). */
  ccts: Array.from({ length: 12 }, (_, i) => 2200 + i * 300),
} as const;

export const LISTING_MOTION_PATH = `/products/${LISTING_MOTION.main.slug}`;

/** Inserts the fixtures. Called by e2e/test-server.ts only. */
export async function seedListingMotion(db: Db): Promise<void> {
  const now = new Date();
  const M = LISTING_MOTION;
  await db.collection("categories").insertOne({
    _id: M.mainId,
    ...M.main,
    parent: null,
    order: 30,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection("products").insertMany(
    M.ccts.map((k, i) => ({
      name: `Motion ${String(i + 1).padStart(2, "0")}`,
      slug: `e2e-motion-${i + 1}-${RUN}`,
      family: null,
      modelCode: `MO-${i + 1}-${RUN}`.toUpperCase(),
      productNo: 500 + i,
      mainCategory: M.mainId,
      extraCategories: [],
      areas: [],
      status: "published",
      featured: false,
      extraSpecs: [],
      publicFiles: [],
      images: [],
      datasheetId: null,
      specs: { cct: [`${k}K`] },
      filters: { cctK: [k] },
      variants: [{ modelNo: `MO-${i + 1}-${RUN}-A`.toUpperCase(), specs: {} }],
      createdAt: new Date(now.getTime() - i * 1000),
      updatedAt: now,
    })),
  );
}
