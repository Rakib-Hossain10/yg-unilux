// Every catalog/settings/upload/import admin service refuses a caller that
// is not the signed-in active admin (ADR 0073, extended before the Phase 5
// exit): writes return `denied` with the reason, reads throw
// AdminActorError, and nothing is written — no document in any collection,
// no audit entry, no storage, Cloudinary or email call. The inputs are
// valid and aim at real seeded documents, so a missing check would write.
// (customers.ts and access-requests.ts have the same tests in their own
// files, against real Better Auth.)

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { XLSX_MIME_TYPE } from "@/lib/constants";
import { mongoose } from "@/lib/db";
import { DEFAULT_COLUMN_VISIBILITY } from "@/lib/schemas/settings";
import {
  AreaModel,
  CategoryModel,
  DatasheetModel,
  ProductModel,
  SiteContentModel,
} from "@/models";
import { AuditLogModel } from "@/models/audit-log";
import { refusedActors, testActor } from "../../../test/helpers/admin-actor";
import { setupMemoryDb } from "../../../test/helpers/memory-db";

import {
  commitImportBatch,
  finishImport,
  presignImport,
  previewImport,
} from "../import";

import {
  AdminActorError,
  ACTOR_REFUSED_MESSAGE,
  type AdminActor,
} from "./actor";
import {
  createArea,
  deleteArea,
  getAreaForEdit,
  listAreas,
  moveArea,
  setAreaImage,
  updateArea,
} from "./areas";
import {
  createCategory,
  deleteCategory,
  getCategoryForEdit,
  listCategoryTree,
  moveCategory,
  setCategoryImage,
  signCategoryImageUpload,
  updateCategory,
} from "./categories";
import { getCounts } from "./dashboard";
import {
  deleteDatasheet,
  finalizeDatasheet,
  listDatasheets,
  presignDatasheetUpload,
  renameDatasheet,
} from "./datasheets";
import { saveProductImages } from "./product-images";
import {
  createDraft,
  deleteProduct,
  getProductForEdit,
  listProducts,
  publishProduct,
  unpublishProduct,
  updateProduct,
} from "./products";
import {
  getAdminSettings,
  saveColumnVisibility,
  saveCompanyEmail,
  saveWhatsappNumber,
} from "./settings";
import { signCloudinaryUpload } from "./uploads";
import type { ServiceResult } from "./write-result";

/* Every external call a refused service could make; none may happen. */
const outside = vi.hoisted(() => ({ calls: [] as string[] }));

/*
 * The module with every function replaced by one that records its name and
 * fails. Error classes stay real (services use them with instanceof).
 */
async function recorded<T extends object>(
  name: string,
  load: () => Promise<T>,
): Promise<T> {
  const real = await load();
  return Object.fromEntries(
    Object.entries(real).map(([key, value]) => [
      key,
      typeof value === "function" && !/Error$/.test(key)
        ? () => {
            outside.calls.push(`${name}.${key}`);
            throw new Error(`${name}.${key} must not be called`);
          }
        : value,
    ]),
  ) as T;
}

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: (await import("../../../test/helpers/admin-actor"))
    .fakeSessionFromDb,
}));
vi.mock("@/lib/storage", (importOriginal) =>
  recorded("storage", importOriginal<typeof import("@/lib/storage")>),
);
vi.mock("@/lib/cloudinary", (importOriginal) =>
  recorded("cloudinary", importOriginal<typeof import("@/lib/cloudinary")>),
);
vi.mock("@/lib/email", (importOriginal) =>
  recorded("email", importOriginal<typeof import("@/lib/email")>),
);

setupMemoryDb("yg_admin_actor_services_test");

const { ObjectId } = mongoose.Types;
const SEEDER = new ObjectId();
const IMPORT_KEY = "imports/0f8fad5b-d9cb-469f-a165-70867728950e.xlsx";
const HASH = "a".repeat(64);

let ids: {
  area: string;
  category: string;
  product: string;
  datasheet: string;
};

beforeAll(async () => {
  const [area, category] = await Promise.all([
    AreaModel.create({ name: "Retail", slug: "retail", order: 1 }),
    CategoryModel.create({
      name: "Spot Lights",
      slug: "spot-lights",
      parent: null,
      order: 1,
    }),
  ]);
  const datasheet = await DatasheetModel.create({
    storageKey: "datasheets/3b241101-e2bb-4255-8caf-4136c566a962.xlsx",
    fileName: "Arc.xlsx",
    size: 1000,
    mimeType: XLSX_MIME_TYPE,
    uploadedBy: SEEDER,
  });
  const product = await ProductModel.create({
    name: "Arc",
    slug: "arc-ar-013a",
    status: "draft",
    mainCategory: category._id,
  });
  ids = {
    area: area.id,
    category: category.id,
    product: product.id,
    datasheet: datasheet.id,
  };
});

beforeEach(() => {
  outside.calls.length = 0;
});

/* Every document of every collection a service could touch. */
async function snapshot(): Promise<string> {
  const all = await Promise.all(
    [
      AreaModel,
      CategoryModel,
      DatasheetModel,
      ProductModel,
      SiteContentModel,
      AuditLogModel,
    ].map((model) =>
      (model as typeof AreaModel).find({}).sort({ _id: 1 }).lean().exec(),
    ),
  );
  return JSON.stringify(all);
}

type Write = (actor: AdminActor) => Promise<ServiceResult<unknown>>;
type Read = (actor: AdminActor) => Promise<unknown>;

const WRITES: [string, Write][] = [
  ["createArea", (a) => createArea(a, { name: "Office" })],
  ["updateArea", (a) => updateArea(a, ids.area, { name: "Shops" })],
  [
    "setAreaImage",
    (a) => setAreaImage(a, { areaId: ids.area, publicId: null }),
  ],
  ["moveArea", (a) => moveArea(a, { id: ids.area, direction: "down" })],
  ["deleteArea", (a) => deleteArea(a, ids.area)],
  [
    "createCategory",
    (a) => createCategory(a, { name: "Pendants", parent: null }),
  ],
  [
    "updateCategory",
    (a) => updateCategory(a, ids.category, { name: "Spots", parent: null }),
  ],
  [
    "moveCategory",
    (a) => moveCategory(a, { id: ids.category, direction: "down" }),
  ],
  ["deleteCategory", (a) => deleteCategory(a, ids.category)],
  [
    "signCategoryImageUpload",
    (a) =>
      signCategoryImageUpload(a, { categoryId: ids.category, slot: "icon" }),
  ],
  [
    "setCategoryImage",
    (a) =>
      setCategoryImage(a, {
        categoryId: ids.category,
        slot: "icon",
        publicId: null,
      }),
  ],
  [
    "presignDatasheetUpload",
    (a) =>
      presignDatasheetUpload(a, {
        fileName: "Arc.xlsx",
        size: 1000,
        contentType: XLSX_MIME_TYPE,
      }),
  ],
  [
    "finalizeDatasheet",
    (a) =>
      finalizeDatasheet(a, {
        mode: "new",
        incomingKey: "datasheets/incoming/x.xlsx",
        fileName: "Arc.xlsx",
      }),
  ],
  [
    "renameDatasheet",
    (a) => renameDatasheet(a, { id: ids.datasheet, fileName: "Arc 2.xlsx" }),
  ],
  ["deleteDatasheet", (a) => deleteDatasheet(a, ids.datasheet)],
  [
    "saveProductImages",
    (a) => saveProductImages(a, { productId: ids.product, images: [] }),
  ],
  [
    "createDraft",
    (a) => createDraft(a, { name: "Racer", mainCategory: ids.category }),
  ],
  ["updateProduct", (a) => updateProduct(a, ids.product, { name: "Arc 2" })],
  ["publishProduct", (a) => publishProduct(a, ids.product)],
  ["unpublishProduct", (a) => unpublishProduct(a, ids.product)],
  ["deleteProduct", (a) => deleteProduct(a, ids.product)],
  [
    "saveColumnVisibility",
    (a) =>
      saveColumnVisibility(a, {
        ...DEFAULT_COLUMN_VISIBILITY,
        driver: "public",
      }),
  ],
  ["saveWhatsappNumber", (a) => saveWhatsappNumber(a, "+852 9123 4567")],
  ["saveCompanyEmail", (a) => saveCompanyEmail(a, "info@example.com")],
  [
    "signCloudinaryUpload",
    (a) => signCloudinaryUpload(a, { target: "product", id: ids.product }),
  ],
  [
    "presignImport",
    (a) =>
      presignImport(a, {
        fileName: "products.xlsx",
        size: 4321,
        contentType: XLSX_MIME_TYPE,
      }),
  ],
  [
    "previewImport",
    (a) =>
      previewImport(a, { key: IMPORT_KEY, defaultCategoryId: ids.category }),
  ],
  [
    "commitImportBatch",
    (a) =>
      commitImportBatch(a, {
        key: IMPORT_KEY,
        defaultCategoryId: ids.category,
        etag: '"etag"',
        planHash: HASH,
        entryHashes: [HASH],
        batch: 0,
        acknowledgeRemovals: false,
      }),
  ],
  ["finishImport", (a) => finishImport(a, { key: IMPORT_KEY })],
];

const READS: [string, Read][] = [
  ["listAreas", (a) => listAreas(a)],
  ["getAreaForEdit", (a) => getAreaForEdit(a, ids.area)],
  ["listCategoryTree", (a) => listCategoryTree(a)],
  ["getCategoryForEdit", (a) => getCategoryForEdit(a, ids.category)],
  ["listDatasheets", (a) => listDatasheets(a)],
  ["listProducts", (a) => listProducts(a, {})],
  ["getProductForEdit", (a) => getProductForEdit(a, ids.product)],
  ["getAdminSettings", (a) => getAdminSettings(a)],
  ["getCounts", (a) => getCounts(a)],
];

describe.each(refusedActors())("as %s", (_who, actor, reason) => {
  it.each(WRITES)(
    "%s returns denied and writes nothing",
    async (_name, write) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const before = await snapshot();
      const result = await write(actor);
      expect(result).toEqual({
        ok: false,
        errors: { formErrors: [ACTOR_REFUSED_MESSAGE], fieldErrors: {} },
        tags: [],
        denied: reason,
      });
      expect(await snapshot()).toBe(before);
      expect(outside.calls).toEqual([]);
      // Logged by reason only: never the actor id or the input.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(
        new RegExp(`actor refused: ${reason}$`),
      );
    },
  );

  it.each(READS)("%s throws AdminActorError", async (_name, read) => {
    const error = await read(actor).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdminActorError);
    expect((error as AdminActorError).reason).toBe(reason);
    expect(outside.calls).toEqual([]);
  });
});

describe("a malformed actor is a programming error", () => {
  const bad = { id: "admin", headers: new Headers() };

  it.each(WRITES)("%s throws TypeError before any write", async (_n, write) => {
    const before = await snapshot();
    await expect(write(bad)).rejects.toThrow(TypeError);
    expect(await snapshot()).toBe(before);
  });

  it.each(READS)("%s throws TypeError", async (_n, read) => {
    await expect(read(bad)).rejects.toThrow(TypeError);
  });
});

describe("the signed-in admin", () => {
  it("reads every list (the check lets a real admin through)", async () => {
    const admin = testActor();
    expect((await listAreas(admin)).map((a) => a.id)).toEqual([ids.area]);
    expect((await listCategoryTree(admin)).map((c) => c.id)).toEqual([
      ids.category,
    ]);
    expect((await listDatasheets(admin)).map((d) => d.id)).toEqual([
      ids.datasheet,
    ]);
    expect((await getCounts(admin)).areas).toBe(1);
  });
});

describe("the same inputs as the admin (so the refusals above bite)", () => {
  it.each(
    WRITES.filter(([name]) =>
      [
        "createArea",
        "updateArea",
        "createCategory",
        "renameDatasheet",
        "createDraft",
        "saveWhatsappNumber",
        "saveCompanyEmail",
      ].includes(name),
    ),
  )("%s writes and audits", async (_name, write) => {
    const before = await snapshot();
    const audits = await AuditLogModel.countDocuments();
    const result = await write(testActor());
    expect(result.ok).toBe(true);
    expect(await snapshot()).not.toBe(before);
    expect(await AuditLogModel.countDocuments()).toBe(audits + 1);
  });
});
