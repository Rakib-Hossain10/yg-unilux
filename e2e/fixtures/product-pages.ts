// Every product the product-page specs use, seeded ONCE by e2e/test-server.ts
// before `next start` (gate B harness fix). The page checks a slug against the
// cached published-slug list (`listPublishedSlugs`, tagged `products`), which
// fills on the first product-page visit; a product a spec inserted later was
// then a 404 until some admin write expired the tag. Seeding everything up
// front keeps shipped code free of test routes or env switches.
//
// Specs import the constants below and never insert or delete these products.
// The values are fixed (the in-memory database is fresh on every run).
//
// The `categoryId`s are NOT inserted as categories: a main category that
// exists from the start sits above the ones e2e/admin-catalog.qa.spec.ts
// creates and breaks its move-up/edge test. The product page only needs the
// id (related strip = same main category); its breadcrumb is then empty.

import { type Db, ObjectId } from "mongodb";

/** A fixed run marker: the database is new per run, so this never collides. */
export const PRODUCT_PAGE_RUN = "fx1";
const RUN = PRODUCT_PAGE_RUN;
const up = (value: string) => value.toUpperCase();

const id = (hex: string) => new ObjectId(hex);

// ---------------------------------------------------------------------------
// e2e/product-variant-switcher.spec.ts (P5)
// ---------------------------------------------------------------------------
export const SWITCHER = {
  categoryId: id("64f0000000000000000000a1"),
  slug: `e2e-arc-${RUN}`,
  solo: `e2e-solo-${RUN}`,
  a1: up(`AR-${RUN}-A1`),
  a2: up(`AR-${RUN}-A2`),
  soloModelNo: up(`SO-${RUN}`),
} as const;

// ---------------------------------------------------------------------------
// e2e/product-gallery.spec.ts (P6)
// ---------------------------------------------------------------------------
export const GALLERY = {
  categoryId: id("64f0000000000000000000a2"),
  slug: `e2e-lumen-${RUN}`,
  bare: `e2e-bare-${RUN}`,
  b1: up(`LU-${RUN}-B1`),
  b2: up(`LU-${RUN}-B2`),
  photo1: `products/e2e/${RUN}-photo-1`,
  photo2: `products/e2e/${RUN}-photo-2`,
  drawing: `products/e2e/${RUN}-drawing`,
} as const;

// ---------------------------------------------------------------------------
// e2e/product-restricted.spec.ts (P7)
// ---------------------------------------------------------------------------
export const RESTRICTED = {
  categoryId: id("64f0000000000000000000a3"),
  productId: "64f0000000000000000000b3",
  slug: `e2e-restricted-${RUN}`,
  soon: `e2e-restricted-soon-${RUN}`,
  a1: up(`RS-${RUN}-A1`),
  a2: up(`RS-${RUN}-A2`),
  // Unique tokens: a leak is a plain substring match on the page source.
  secret: {
    batchNo: `BATCH~${RUN}`,
    chipType: `CHIP~${RUN}`,
    holder: `HOLDER~${RUN}`,
    chipEfficiency: `EFF~${RUN}`,
    driverA1: `DRIVER-A1~${RUN}`,
    driverA2: `DRIVER-A2~${RUN}`,
  },
} as const;

// ---------------------------------------------------------------------------
// e2e/product-page-gate-b.qa.spec.ts (QA gate B)
// ---------------------------------------------------------------------------
/*
 * A two-variant product with EVERY default-restricted column filled at
 * product and variant level, a family sibling and a related product (same
 * main category, other family), so the strips render. Each token is unique
 * and grep-able; "QAX" never occurs in markup by chance.
 */
export const GATE_B = {
  categoryId: id("64f0000000000000000000a4"),
  productId: "64f0000000000000000000b4",
  siblingId: "64f0000000000000000000c4",
  relatedId: "64f0000000000000000000d4",
  slug: `qa-gateb-${RUN}`,
  siblingSlug: `qa-gateb-sibling-${RUN}`,
  relatedSlug: `qa-gateb-related-${RUN}`,
  family: "Gatebfam",
  v1: up(`GB-${RUN}-V1`),
  v2: up(`GB-${RUN}-V2`),
  /* The default-restricted columns (product level and per variant). */
  restricted: {
    batchNo: `QAXBATCH${RUN}`,
    chipType: `QAXCHIP${RUN}`,
    holder: `QAXHOLDER${RUN}`,
    chipEfficiency: `QAXEFF${RUN}`,
    driverV1: `QAXDRIVER1${RUN}`,
    driverV2: `QAXDRIVER2${RUN}`,
    batchNoV2: `QAXBATCHV2${RUN}`,
  },
  /* Public columns the toggle test makes restricted (and back). */
  publicValues: {
    housingFinish: `QAXFINISH${RUN}`,
    lensV1: `QAXLENS1${RUN}`,
    lensV2: `QAXLENS2${RUN}`,
  },
  /* Free-text variant labels: hidden whenever Lens/Reflector/Diffuser is restricted. */
  labels: { v1: `QAXLABEL1${RUN}`, v2: `QAXLABEL2${RUN}` },
} as const;

// ---------------------------------------------------------------------------
// e2e/product-page.spec.ts (P9, the Phase 4a exit flow)
// ---------------------------------------------------------------------------
/*
 * The exit product: two variants (lens / reflector) that each name their own
 * picture, three images stored drawing-in-the-middle (the page shows photos
 * first: photo1, photo2, drawing), a datasheet, filled quick-panel and table
 * columns and every default-restricted column filled with a grep-able token.
 */
export const EXIT = {
  categoryId: id("64f0000000000000000000a5"),
  productId: "64f0000000000000000000b5",
  slug: `e2e-halo-${RUN}`,
  name: "Halo",
  v1: up(`HA-${RUN}-L1`),
  v2: up(`HA-${RUN}-R2`),
  photo1: `products/e2e/${RUN}-halo-1`,
  photo2: `products/e2e/${RUN}-halo-2`,
  drawing: `products/e2e/${RUN}-halo-drawing`,
  photo2Alt: "Halo, reflector version",
  lumen: { v1: "1500lm", v2: "1650lm" },
  efficacy: { v1: "100lm/W", v2: "110lm/W" },
  restricted: {
    batchNo: `EXITBATCH${RUN}`,
    chipType: `EXITCHIP${RUN}`,
    holder: `EXITHOLDER${RUN}`,
    chipEfficiency: `EXITEFF${RUN}`,
    driverV1: `EXITDRIVER1${RUN}`,
    driverV2: `EXITDRIVER2${RUN}`,
  },
} as const;

/** Every default-restricted token of the gate B product. */
export const GATE_B_RESTRICTED_TOKENS: readonly string[] = Object.values(
  GATE_B.restricted,
);

function productDocs(now: Date): Record<string, unknown>[] {
  const base = {
    extraCategories: [],
    areas: [],
    status: "published",
    featured: false,
    extraSpecs: [],
    publicFiles: [],
    images: [],
    datasheetId: null,
    createdAt: now,
    updatedAt: now,
  };
  const S = SWITCHER;
  const G = GALLERY;
  const R = RESTRICTED;
  const B = GATE_B;
  const X = EXIT;
  return [
    // --- exit flow (P9) ---
    {
      ...base,
      _id: id(X.productId),
      mainCategory: X.categoryId,
      name: X.name,
      slug: X.slug,
      family: X.name,
      modelCode: up(`HA-${RUN}`),
      type: "Recessed downlight",
      // Only `products.datasheetId != null` matters to the page (no file).
      datasheetId: new ObjectId(),
      images: [
        { publicId: X.photo1, order: 0, kind: "gallery" },
        { publicId: X.drawing, order: 1, kind: "dimension" },
        { publicId: X.photo2, order: 2, kind: "gallery", alt: X.photo2Alt },
      ],
      specs: {
        housingMaterial: ["Die-cast aluminium"],
        housingFinish: ["White", "Black"],
        cutOutSize: ["Ø75mm"],
        cct: ["3000K", "4000K"],
        cri: ["90"],
        beamAngle: ["24°", "36°"],
        ugr: ["<19"],
        wattage: ["15W"],
        ipRating: ["IP44"],
        batchNo: [X.restricted.batchNo],
        chipType: [X.restricted.chipType],
        holder: [X.restricted.holder],
        chipEfficiency: [X.restricted.chipEfficiency],
      },
      filters: { cri: [90], wattage: [15] },
      variants: [
        {
          modelNo: X.v1,
          label: "PC lens",
          imagePublicId: X.photo1,
          specs: {
            lens: ["PC lens"],
            driver: [X.restricted.driverV1],
            lumenOutput: [X.lumen.v1],
            lumenEfficiency: [X.efficacy.v1],
          },
        },
        {
          modelNo: X.v2,
          label: "Reflector",
          imagePublicId: X.photo2,
          specs: {
            lens: ["Reflector"],
            driver: [X.restricted.driverV2],
            lumenOutput: [X.lumen.v2],
            lumenEfficiency: [X.efficacy.v2],
          },
        },
      ],
    },
    // --- switcher ---
    {
      ...base,
      mainCategory: S.categoryId,
      name: "Arc",
      slug: S.slug,
      family: "Arc",
      modelCode: up(`AR-${RUN}`),
      specs: {
        housingMaterial: ["Die-cast aluminium"],
        cct: ["3000K", "4000K"],
        wattage: ["12W"],
      },
      variants: [
        {
          modelNo: S.a1,
          label: "Regular lens",
          specs: {
            lens: ["PC lens"],
            lumenOutput: ["1100lm"],
            lumenEfficiency: ["92lm/W"],
          },
        },
        {
          modelNo: S.a2,
          label: "Reflector",
          specs: {
            lens: ["Reflector"],
            lumenOutput: ["1200lm"],
            lumenEfficiency: ["100lm/W"],
          },
        },
      ],
    },
    {
      ...base,
      mainCategory: S.categoryId,
      name: "Solo",
      slug: S.solo,
      specs: { cct: ["2700K"] },
      variants: [{ modelNo: S.soloModelNo, specs: {} }],
    },
    // --- gallery ---
    {
      ...base,
      mainCategory: G.categoryId,
      name: "Lumen",
      slug: G.slug,
      family: "Lumen",
      modelCode: up(`LU-${RUN}`),
      specs: { cct: ["3000K"] },
      images: [
        // Stored drawing-first: the page must still show photos first.
        { publicId: G.drawing, order: 0, kind: "dimension" },
        { publicId: G.photo1, order: 1, kind: "gallery" },
        { publicId: G.photo2, order: 2, kind: "gallery", alt: "Lumen, black" },
      ],
      variants: [
        {
          modelNo: G.b1,
          label: "Lens",
          specs: { lens: ["PC lens"], lumenOutput: ["900lm"] },
        },
        {
          modelNo: G.b2,
          label: "Reflector",
          imagePublicId: G.photo2,
          specs: { lens: ["Reflector"], lumenOutput: ["950lm"] },
        },
      ],
    },
    {
      ...base,
      mainCategory: G.categoryId,
      name: "Bare",
      slug: G.bare,
      specs: {},
      variants: [{ modelNo: up(`BA-${RUN}`), specs: {} }],
    },
    // --- restricted block ---
    {
      ...base,
      _id: id(R.productId),
      mainCategory: R.categoryId,
      name: "Restricted",
      slug: R.slug,
      family: "Restricted",
      modelCode: up(`RS-${RUN}`),
      // Only `products.datasheetId != null` matters to the page (no file).
      datasheetId: new ObjectId(),
      specs: {
        cct: ["3000K"],
        batchNo: [R.secret.batchNo],
        chipType: [R.secret.chipType],
        holder: [R.secret.holder],
        chipEfficiency: [R.secret.chipEfficiency],
      },
      variants: [
        {
          modelNo: R.a1,
          label: "Lens",
          specs: { lens: ["PC lens"], driver: [R.secret.driverA1] },
        },
        {
          modelNo: R.a2,
          label: "Reflector",
          specs: { lens: ["Reflector"], driver: [R.secret.driverA2] },
        },
      ],
    },
    {
      ...base,
      mainCategory: R.categoryId,
      name: "Soon",
      slug: R.soon,
      datasheetId: null,
      specs: { cct: ["2700K"], driver: [R.secret.driverA1] },
      variants: [{ modelNo: up(`SN-${RUN}`), specs: {} }],
    },
    // --- gate B ---
    {
      ...base,
      _id: id(B.productId),
      mainCategory: B.categoryId,
      name: "Gateb",
      slug: B.slug,
      family: B.family,
      modelCode: up(`GB-${RUN}`),
      type: "Recessed spot",
      datasheetId: new ObjectId(),
      // A gallery photo, so og:image and JSON-LD image are rendered too.
      images: [
        { publicId: `products/e2e/${RUN}-gateb`, order: 0, kind: "gallery" },
      ],
      specs: {
        housingMaterial: ["Aluminium"],
        housingFinish: [B.publicValues.housingFinish],
        cct: ["3000K"],
        cri: ["90"],
        wattage: ["10W"],
        ipRating: ["IP44"],
        batchNo: [B.restricted.batchNo],
        chipType: [B.restricted.chipType],
        holder: [B.restricted.holder],
        chipEfficiency: [B.restricted.chipEfficiency],
      },
      // Filter numbers exist for public filter columns only.
      filters: { cri: [90], wattage: [10] },
      variants: [
        {
          modelNo: B.v1,
          label: B.labels.v1,
          specs: {
            lens: [B.publicValues.lensV1],
            driver: [B.restricted.driverV1],
            lumenOutput: ["800lm"],
          },
        },
        {
          modelNo: B.v2,
          label: B.labels.v2,
          specs: {
            lens: [B.publicValues.lensV2],
            driver: [B.restricted.driverV2],
            batchNo: [B.restricted.batchNoV2],
            lumenOutput: ["850lm"],
          },
        },
      ],
    },
    {
      ...base,
      _id: id(B.siblingId),
      mainCategory: B.categoryId,
      name: "Gateb sibling",
      slug: B.siblingSlug,
      family: B.family,
      modelCode: up(`GBS-${RUN}`),
      specs: {
        cct: ["4000K"],
        chipType: [`QAXSIBCHIP${RUN}`],
        driver: [`QAXSIBDRIVER${RUN}`],
      },
      variants: [{ modelNo: up(`GBS-${RUN}-1`), specs: {} }],
    },
    {
      ...base,
      _id: id(B.relatedId),
      mainCategory: B.categoryId,
      name: "Gateb related",
      slug: B.relatedSlug,
      family: "Otherfam",
      modelCode: up(`GBR-${RUN}`),
      specs: { cct: ["2700K"], holder: [`QAXRELHOLDER${RUN}`] },
      variants: [
        {
          modelNo: up(`GBR-${RUN}-1`),
          specs: { driver: [`QAXRELDRIVER${RUN}`] },
        },
      ],
    },
  ];
}

/** Restricted tokens of the gate B sibling and related cards. */
export const GATE_B_STRIP_TOKENS: readonly string[] = [
  `QAXSIBCHIP${RUN}`,
  `QAXSIBDRIVER${RUN}`,
  `QAXRELHOLDER${RUN}`,
  `QAXRELDRIVER${RUN}`,
];

/** Inserts every product-page fixture. Called by e2e/test-server.ts only. */
export async function seedProductPages(db: Db): Promise<void> {
  const now = new Date();
  await db.collection("products").insertMany(productDocs(now));
}
