// QA gate B (Phase 4b, L4-L6): the catalog data the listing/search/menu leak
// test uses, seeded ONCE by e2e/test-server.ts before `next start` (the
// category tree, area list and published-slug list are cached on the first
// catalog request). Specs import the constants and never delete these.
//
// - One main category with one sub-category, plus a second sub-category whose
//   ONLY product is a draft: its name must never appear in the mega-menu, the
//   small-screen menu, the sitemap or search (gate-A I-2 / ADR 0065 L6).
// - One area of its own (order 5: after the area-page fixtures).
// - Two published products with EVERY spec column (all 28) filled at product
//   and variant level with a unique grep-able token, free-text variant labels
//   holding tokens too, and unique filter numbers (CCT 6123 K, CRI 83, beam
//   37 deg, UGR 17, 47 W, IP 66) so the facets can be watched when a column
//   flips restricted <-> public.
// - One draft product (in the listed sub-category and the area) whose name,
//   slug and model no. must never be listed or found.
//
// The main category sorts after the other seeded ones (order 20), so the
// mega-menu's first (active) category and admin-catalog.qa.spec.ts's bounded
// move-up loop are unaffected.

import { type Db, ObjectId } from "mongodb";

import { SPEC_KEYS } from "../../src/models/spec-columns";

const RUN = "fx1";
const id = (hex: string) => new ObjectId(hex);

export const LGB = {
  mainId: id("64f0000000000000000001a1"),
  subId: id("64f0000000000000000001a2"),
  draftCatId: id("64f0000000000000000001a3"),
  areaId: id("64f0000000000000000001b1"),
  p1Id: id("64f0000000000000000001c1"),
  p2Id: id("64f0000000000000000001c2"),
  draftId: id("64f0000000000000000001c3"),
  main: { name: "Gatelist Lights", slug: `qa-lgb-main-${RUN}` },
  sub: { name: "Gatelist Spots", slug: "qa-lgb-spots" },
  draftCat: { name: "Qaxdraftcat Hidden", slug: "qa-lgb-draftcat" },
  area: { name: "Gatelist Hall", slug: `qa-lgb-area-${RUN}` },
  p1: {
    name: "Gatelist One",
    slug: `qa-lgb-one-${RUN}`,
    family: "Lgbfam",
    modelCode: `LGB-${RUN}-1`.toUpperCase(),
    v1: `LGB-${RUN}-1A`.toUpperCase(),
    v2: `LGB-${RUN}-1B`.toUpperCase(),
  },
  p2: {
    name: "Gatelist Two",
    slug: `qa-lgb-two-${RUN}`,
    family: "Lgbfam",
    modelCode: `LGB-${RUN}-2`.toUpperCase(),
    v1: `LGB-${RUN}-2A`.toUpperCase(),
  },
  draft: {
    name: "Qaxdraftprod Secret",
    slug: `qa-lgb-draft-${RUN}`,
    modelNo: `QAXDRAFTMODEL-${RUN}`.toUpperCase(),
  },
  /* Filter numbers (unique among all e2e fixtures). */
  filters: { cctK: 6123, cri: 83, beamDeg: 37, ugr: 17, wattage: 47, ip: 66 },
} as const;

export const LGB_MAIN_PATH = `/products/${LGB.main.slug}`;
export const LGB_SUB_PATH = `${LGB_MAIN_PATH}/${LGB.sub.slug}`;
export const LGB_DRAFTCAT_PATH = `${LGB_MAIN_PATH}/${LGB.draftCat.slug}`;
export const LGB_AREA_PATH = `/areas/${LGB.area.slug}`;

/** The token of one spec column at one place ("p1", "p1v1", ...). */
export const lgbToken = (key: string, where: string) =>
  `LGBX${key}${where}${RUN}`.toUpperCase();

const specsAt = (where: string) =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, [lgbToken(key, where)]]));

const PLACES = ["p1", "p1v1", "p1v2", "p2", "p2v1"] as const;

/** Every spec token of the two published products (all 28 columns). */
export const LGB_SPEC_TOKENS: readonly string[] = PLACES.flatMap((where) =>
  SPEC_KEYS.map((key) => lgbToken(key, where)),
);
/** Spec tokens of the default-restricted columns only. */
export const LGB_DEFAULT_RESTRICTED_TOKENS: readonly string[] = PLACES.flatMap(
  (where) =>
    ["batchNo", "chipType", "holder", "chipEfficiency", "driver"].map((key) =>
      lgbToken(key, where),
    ),
);
/** Variant labels (free text that may repeat optic values). */
export const LGB_LABEL_TOKENS: readonly string[] = [
  `LGBXLABEL1${RUN}`.toUpperCase(),
  `LGBXLABEL2${RUN}`.toUpperCase(),
];
/** What a draft must never show anywhere public. */
export const LGB_DRAFT_TOKENS: readonly string[] = [
  LGB.draft.name,
  LGB.draft.slug,
  LGB.draft.modelNo,
  LGB.draftCat.name,
  LGB.draftCat.slug,
];

/** Inserts the gate B listing fixtures. Called by e2e/test-server.ts only. */
export async function seedListingGateB(db: Db): Promise<void> {
  const now = new Date();
  const L = LGB;
  await db.collection("categories").insertMany([
    {
      _id: L.mainId,
      ...L.main,
      parent: null,
      order: 20,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: L.subId,
      ...L.sub,
      parent: L.mainId,
      order: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: L.draftCatId,
      ...L.draftCat,
      parent: L.mainId,
      order: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.collection("areas").insertOne({
    _id: L.areaId,
    ...L.area,
    order: 5,
    createdAt: now,
    updatedAt: now,
  });
  const base = {
    mainCategory: L.subId,
    extraCategories: [],
    areas: [L.areaId],
    status: "published",
    featured: false,
    extraSpecs: [],
    publicFiles: [],
    images: [],
    datasheetId: null,
    filters: {
      cctK: [L.filters.cctK],
      cri: [L.filters.cri],
      beamDeg: [L.filters.beamDeg],
      ugr: [L.filters.ugr],
      wattage: [L.filters.wattage],
      ip: [L.filters.ip],
    },
    createdAt: now,
    updatedAt: now,
  };
  await db.collection("products").insertMany([
    {
      ...base,
      _id: L.p1Id,
      name: L.p1.name,
      slug: L.p1.slug,
      family: L.p1.family,
      modelCode: L.p1.modelCode,
      productNo: 1,
      images: [
        { publicId: `products/e2e/${RUN}-lgb-1`, order: 0, kind: "gallery" },
      ],
      specs: specsAt("p1"),
      variants: [
        {
          modelNo: L.p1.v1,
          label: LGB_LABEL_TOKENS[0],
          specs: specsAt("p1v1"),
        },
        {
          modelNo: L.p1.v2,
          label: LGB_LABEL_TOKENS[1],
          specs: specsAt("p1v2"),
        },
      ],
    },
    {
      ...base,
      _id: L.p2Id,
      name: L.p2.name,
      slug: L.p2.slug,
      family: L.p2.family,
      modelCode: L.p2.modelCode,
      productNo: 2,
      // An image, so the admin can publish it again (publishCheck).
      images: [
        { publicId: `products/e2e/${RUN}-lgb-2`, order: 0, kind: "gallery" },
      ],
      specs: specsAt("p2"),
      variants: [{ modelNo: L.p2.v1, specs: specsAt("p2v1") }],
    },
    {
      ...base,
      _id: L.draftId,
      status: "draft",
      // In the listed sub-category AND the draft-only one (extra category).
      extraCategories: [L.draftCatId],
      name: L.draft.name,
      slug: L.draft.slug,
      family: "Lgbfam",
      modelCode: L.draft.modelNo,
      productNo: 3,
      specs: specsAt("draft"),
      variants: [{ modelNo: L.draft.modelNo, specs: {} }],
    },
  ]);
}
