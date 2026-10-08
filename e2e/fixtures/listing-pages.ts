// The categories and products the listing specs use (Phase 4b L4), seeded
// ONCE by e2e/test-server.ts before `next start`: the category tree is cached
// (`listPublicCategories`, tag `categories`) on the first catalog request, so
// a category a spec inserted later would 404 until an admin write expired
// the tag. Specs import the constants and never insert or delete these.
//
// One main category with two sub-categories; 28 published products under
// "Recessed" (two pages of 24), with CCT / IP / wattage filter numbers and
// every default-restricted column filled with a grep-able token, plus a
// draft that must never be listed.
//
// These main categories exist from the start, so they sit ABOVE the ones
// e2e/admin-catalog.qa.spec.ts creates; its move-up test moves its own
// category to the top of the whole tree before checking the edge.

import { type Db, ObjectId } from "mongodb";

const RUN = "fx1";
const id = (hex: string) => new ObjectId(hex);

export const LISTING = {
  mainId: id("64f0000000000000000000e1"),
  recessedId: id("64f0000000000000000000e2"),
  surfaceId: id("64f0000000000000000000e3"),
  main: { name: "Listing Lights", slug: `e2e-listing-${RUN}` },
  recessed: { name: "Recessed", slug: "recessed" },
  surface: { name: "Surface", slug: "surface" },
  description: "Quiet light for galleries.\nAnd for retail.",
  /** Products under Recessed (two pages of 24). */
  count: 28,
  /** Products with CCT 3000K (even indexes): 14. */
  cct3000: 14,
  /** Products with IP65 (indexes 0-3). */
  ip65: 4,
  draftName: "Listing Draft",
  restricted: {
    batchNo: `LSTXBATCH${RUN}`,
    chipType: `LSTXCHIP${RUN}`,
    holder: `LSTXHOLDER${RUN}`,
    chipEfficiency: `LSTXEFF${RUN}`,
    driver: `LSTXDRIVER${RUN}`,
  },
} as const;

/** The listing path of the sub-category. */
export const LISTING_RECESSED_PATH = `/products/${LISTING.main.slug}/${LISTING.recessed.slug}`;
/** The listing path of the main category. */
export const LISTING_MAIN_PATH = `/products/${LISTING.main.slug}`;
/** Every restricted token of the listing products. */
export const LISTING_RESTRICTED_TOKENS: readonly string[] = Object.values(
  LISTING.restricted,
);

/** The n-th listing product's name (1-based, zero-padded). */
export const listingName = (n: number) =>
  `Listing ${String(n).padStart(2, "0")}`;

/** Inserts the listing fixtures. Called by e2e/test-server.ts only. */
export async function seedListingPages(db: Db): Promise<void> {
  const now = new Date();
  const L = LISTING;
  await db.collection("categories").insertMany([
    {
      _id: L.mainId,
      ...L.main,
      parent: null,
      order: 0,
      description: L.description,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: L.recessedId,
      ...L.recessed,
      parent: L.mainId,
      order: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: L.surfaceId,
      ...L.surface,
      parent: L.mainId,
      order: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const secret = {
    batchNo: [L.restricted.batchNo],
    chipType: [L.restricted.chipType],
    holder: [L.restricted.holder],
    chipEfficiency: [L.restricted.chipEfficiency],
  };
  const products = Array.from({ length: L.count }, (_, i) => ({
    name: listingName(i + 1),
    slug: `e2e-listing-${i + 1}-${RUN}`,
    family: i < 2 ? "Lyra" : null,
    modelCode: `LS-${i + 1}-${RUN}`.toUpperCase(),
    productNo: i + 1,
    mainCategory: L.recessedId,
    extraCategories: [],
    areas: [],
    status: "published",
    featured: false,
    extraSpecs: [],
    publicFiles: [],
    images:
      i === 0
        ? [
            {
              publicId: `products/e2e/${RUN}-listing-1`,
              order: 0,
              kind: "gallery",
            },
          ]
        : [],
    datasheetId: null,
    specs: {
      cct: [i % 2 === 0 ? "3000K" : "4000K"],
      ipRating: [i < L.ip65 ? "IP65" : "IP20"],
      wattage: [i % 3 === 0 ? "30W" : "12W"],
      ...secret,
    },
    filters: {
      cctK: [i % 2 === 0 ? 3000 : 4000],
      ip: [i < L.ip65 ? 65 : 20],
      wattage: [i % 3 === 0 ? 30 : 12],
    },
    variants:
      i === 0
        ? [
            {
              modelNo: `LS-1-${RUN}-A`.toUpperCase(),
              specs: { driver: [L.restricted.driver] },
            },
            {
              modelNo: `LS-1-${RUN}-B`.toUpperCase(),
              specs: { driver: [L.restricted.driver] },
            },
          ]
        : [
            {
              modelNo: `LS-${i + 1}-${RUN}-A`.toUpperCase(),
              specs: { driver: [L.restricted.driver] },
            },
          ],
    createdAt: new Date(now.getTime() - i * 1000),
    updatedAt: now,
  }));
  await db.collection("products").insertMany([
    ...products,
    {
      name: L.draftName,
      slug: `e2e-listing-draft-${RUN}`,
      mainCategory: L.recessedId,
      extraCategories: [],
      areas: [],
      status: "draft",
      featured: false,
      extraSpecs: [],
      publicFiles: [],
      images: [],
      datasheetId: null,
      specs: { cct: ["3000K"] },
      filters: { cctK: [3000] },
      variants: [{ modelNo: `LD-${RUN}`.toUpperCase(), specs: {} }],
      createdAt: now,
      updatedAt: now,
    },
  ]);
}
