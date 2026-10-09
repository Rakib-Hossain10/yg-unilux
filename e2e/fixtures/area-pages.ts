// The areas, categories and products the area-page spec uses (Phase 4b L5),
// seeded ONCE by e2e/test-server.ts before `next start`: the area list and
// the category tree are cached on the first catalog request, so an area a
// spec inserted later would 404 until an admin write expired the tag. Specs
// import the constants and never insert or delete these.
//
// Two areas: "Gallery" (with a black-and-white photo) holds 3 spot products
// and 2 downlights from two main categories of its own; "Lobby" (no photo)
// holds one of those downlights and one of its own. Every default-restricted column is filled with
// a grep-able token, and a draft in Gallery must never be listed. Areas sort
// first (order 0-1), above the ones e2e/admin-catalog.qa.spec.ts creates;
// the categories hold no product of the listing fixtures.

import { type Db, ObjectId } from "mongodb";

const RUN = "fx1";
const id = (hex: string) => new ObjectId(hex);

export const AREA_PAGES = {
  galleryId: id("64f0000000000000000000f1"),
  lobbyId: id("64f0000000000000000000f2"),
  spotId: id("64f0000000000000000000f3"),
  downId: id("64f0000000000000000000f4"),
  gallery: { name: "Gallery Spaces", slug: `e2e-area-gallery-${RUN}` },
  lobby: { name: "Lobby Spaces", slug: `e2e-area-lobby-${RUN}` },
  spot: { name: "Area Spots", slug: `e2e-area-spots-${RUN}` },
  down: { name: "Area Downs", slug: `e2e-area-downs-${RUN}` },
  /** Products in Gallery: 3 spots + 2 downs. */
  galleryCount: 5,
  gallerySpots: 3,
  draftName: "Area Draft",
  lobbyOnlyName: "Lobby Down",
  restricted: {
    batchNo: `ARXBATCH${RUN}`,
    chipType: `ARXCHIP${RUN}`,
    holder: `ARXHOLDER${RUN}`,
    chipEfficiency: `ARXEFF${RUN}`,
    driver: `ARXDRIVER${RUN}`,
  },
} as const;

export const GALLERY_PATH = `/areas/${AREA_PAGES.gallery.slug}`;
export const LOBBY_PATH = `/areas/${AREA_PAGES.lobby.slug}`;
export const AREA_RESTRICTED_TOKENS: readonly string[] = Object.values(
  AREA_PAGES.restricted,
);

/** Inserts the area-page fixtures. Called by e2e/test-server.ts only. */
export async function seedAreaPages(db: Db): Promise<void> {
  const now = new Date();
  const A = AREA_PAGES;
  await db.collection("areas").insertMany([
    {
      _id: A.galleryId,
      ...A.gallery,
      order: 0,
      bwImage: `areas/e2e/${RUN}-gallery`,
      createdAt: now,
      updatedAt: now,
    },
    { _id: A.lobbyId, ...A.lobby, order: 1, createdAt: now, updatedAt: now },
  ]);
  await db.collection("categories").insertMany(
    [
      { _id: A.spotId, ...A.spot },
      { _id: A.downId, ...A.down },
    ].map((category, index) => ({
      ...category,
      parent: null,
      order: 10 + index,
      createdAt: now,
      updatedAt: now,
    })),
  );
  const secret = {
    batchNo: [A.restricted.batchNo],
    chipType: [A.restricted.chipType],
    holder: [A.restricted.holder],
    chipEfficiency: [A.restricted.chipEfficiency],
  };
  const product = (
    name: string,
    slug: string,
    category: ObjectId,
    areas: ObjectId[],
    status: "published" | "draft" = "published",
  ) => ({
    name,
    slug: `e2e-area-${slug}-${RUN}`,
    family: null,
    modelCode: `AR-${slug}-${RUN}`.toUpperCase(),
    productNo: null,
    mainCategory: category,
    extraCategories: [],
    areas,
    status,
    featured: false,
    extraSpecs: [],
    publicFiles: [],
    images: [],
    datasheetId: null,
    specs: { cct: ["3000K"], ...secret },
    filters: { cctK: [3000] },
    variants: [
      {
        modelNo: `AR-${slug}-${RUN}-A`.toUpperCase(),
        specs: { driver: [A.restricted.driver] },
      },
    ],
    createdAt: now,
    updatedAt: now,
  });
  await db
    .collection("products")
    .insertMany([
      ...Array.from({ length: A.gallerySpots }, (_, i) =>
        product(`Area Spot ${i + 1}`, `spot-${i + 1}`, A.spotId, [A.galleryId]),
      ),
      product("Area Down 1", "down-1", A.downId, [A.galleryId]),
      product("Area Down 2", "down-2", A.downId, [A.galleryId, A.lobbyId]),
      product(A.lobbyOnlyName, "lobby-down", A.downId, [A.lobbyId]),
      product(A.draftName, "draft", A.spotId, [A.galleryId], "draft"),
    ]);
}
