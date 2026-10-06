// Tests for the product services (src/lib/admin/products.ts) on an in-memory
// MongoDB: list/search/pages, edit form, drafts, updates, publish gate,
// trackSize rule, duplicate model nos, delete, audit entries and tags.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { mongoose } from "@/lib/db";
import {
  AreaModel,
  CategoryModel,
  DatasheetModel,
  ProductModel,
} from "@/models";
import { AuditLogModel } from "@/models/audit-log";
import { setupMemoryDb } from "../../../test/helpers/memory-db";

import {
  createDraft,
  deleteProduct,
  getProductForEdit,
  listProducts,
  MAGNETIC_TRACK_SLUG,
  PRODUCTS_PAGE_SIZE,
  PRODUCT_CHANGED,
  publishProduct,
  unpublishProduct,
  updateProduct,
} from "./products";
import { AUDIT_FAILED_MESSAGE, type ServiceResult } from "./write-result";

setupMemoryDb("yg_admin_products_test");

const { ObjectId } = mongoose.Types;
const ADMIN = new ObjectId().toHexString();

let spot: string; // main category "Spot Lights"
let track: string; // main category "Magnetic Track"
let track5: string; // child of Magnetic Track
let area: string;
let datasheet: string;

beforeAll(async () => {
  // Unique indexes are built by `npm run db:indexes`; build them here so the
  // duplicate-key paths are real.
  await ProductModel.createIndexes();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    ProductModel.deleteMany({}),
    CategoryModel.deleteMany({}),
    AreaModel.deleteMany({}),
    DatasheetModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  const [s, t] = await CategoryModel.create([
    { name: "Spot Lights", slug: "spot-lights", parent: null, order: 0 },
    {
      name: "Magnetic Track",
      slug: MAGNETIC_TRACK_SLUG,
      parent: null,
      order: 1,
    },
  ]);
  const child = await CategoryModel.create({
    name: "5mm",
    slug: "5mm",
    parent: t?._id,
    order: 0,
  });
  spot = s!._id.toHexString();
  track = t!._id.toHexString();
  track5 = child._id.toHexString();
  area = (
    await AreaModel.create({ name: "Retail", slug: "retail", order: 0 })
  )._id.toHexString();
  datasheet = (
    await DatasheetModel.create({
      storageKey: "datasheets/a.xlsx",
      fileName: "a.xlsx",
      size: 10,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      uploadedBy: new ObjectId(),
    })
  )._id.toHexString();
});

function expectOk<T>(result: ServiceResult<T>): T {
  if (!result.ok)
    throw new Error(`expected ok: ${JSON.stringify(result.errors)}`);
  return result.data;
}

function fieldErrorsOf<T>(result: ServiceResult<T>): Record<string, string[]> {
  if (result.ok) throw new Error("expected a failure");
  return result.errors.fieldErrors;
}

async function draft(name = "Arc", mainCategory = spot) {
  return expectOk(await createDraft(ADMIN, { name, mainCategory })).id;
}

/* A minimal valid form payload for updateProduct. */
function form(over: Record<string, unknown> = {}) {
  return {
    name: "Arc",
    mainCategory: spot,
    variants: [{ modelNo: "AR-013A1" }],
    ...over,
  };
}

async function addImage(id: string) {
  await ProductModel.updateOne(
    { _id: id },
    { $push: { images: { publicId: "p/a", order: 0, kind: "gallery" } } },
  );
}

async function actions(): Promise<string[]> {
  const rows = await AuditLogModel.find({}).sort({ _id: 1 }).lean();
  return rows.map((row) => row.action);
}

describe("createDraft", () => {
  it("creates a draft with a unique slug, audits it and returns product tags", async () => {
    const result = await createDraft(ADMIN, {
      name: "Arc",
      mainCategory: spot,
    });
    const { id } = expectOk(result);
    expect(result.tags).toEqual(["products", `product:${id}`]);
    expect(await ProductModel.findById(id).lean()).toMatchObject({
      name: "Arc",
      slug: "arc",
      status: "draft",
    });
    expect(await actions()).toEqual(["product.create"]);

    const second = expectOk(
      await createDraft(ADMIN, { name: "Arc", mainCategory: spot }),
    );
    expect((await ProductModel.findById(second.id).lean())?.slug).toBe("arc-2");
  });

  it("refuses a missing category, bad input and operator objects", async () => {
    const missing = await createDraft(ADMIN, {
      name: "Arc",
      mainCategory: new ObjectId().toHexString(),
    });
    expect(fieldErrorsOf(missing).mainCategory).toBeDefined();
    expect(missing.tags).toEqual([]);

    expect(
      (await createDraft(ADMIN, { name: "", mainCategory: spot })).ok,
    ).toBe(false);
    expect(
      (await createDraft(ADMIN, { name: "Arc", mainCategory: { $ne: null } }))
        .ok,
    ).toBe(false);
    expect(
      (
        await createDraft(ADMIN, {
          name: "Arc",
          mainCategory: spot,
          status: "published",
        })
      ).ok,
    ).toBe(false);
    expect(
      (await createDraft(ADMIN, { name: "零售", mainCategory: spot })).ok,
    ).toBe(false);
    expect(await ProductModel.countDocuments()).toBe(0);
    expect(await actions()).toEqual([]);
  });

  it("throws before writing for a bad actor id", async () => {
    await expect(
      createDraft("admin", { name: "Arc", mainCategory: spot }),
    ).rejects.toThrow(TypeError);
  });

  it("keeps the draft and still returns tags when the audit write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(AuditLogModel, "create").mockRejectedValueOnce(new Error("boom"));
    const result = await createDraft(ADMIN, {
      name: "Arc",
      mainCategory: spot,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.formErrors).toEqual([
      AUDIT_FAILED_MESSAGE,
    ]);
    expect(result.tags).toContain("products");
    expect(await ProductModel.countDocuments()).toBe(1);
  });
});

describe("getProductForEdit", () => {
  it("returns the form values and images, or null for bad/unknown ids", async () => {
    const id = await draft();
    await updateProduct(
      ADMIN,
      id,
      form({ family: "Arc", specs: { driver: ["Lifud"] } }),
    );
    await addImage(id);

    const edit = await getProductForEdit(id);
    expect(edit).toMatchObject({
      id,
      values: {
        name: "Arc",
        family: "Arc",
        modelCode: "",
        mainCategory: spot,
        specs: { driver: ["Lifud"] },
        variants: [
          { modelNo: "AR-013A1", label: "", specs: {}, imagePublicId: "" },
        ],
        datasheetId: null,
        status: "draft",
      },
      images: [{ publicId: "p/a", order: 0, kind: "gallery" }],
    });
    expect(await getProductForEdit(new ObjectId().toHexString())).toBeNull();
    expect(await getProductForEdit("nope")).toBeNull();
    expect(await getProductForEdit({ $ne: null })).toBeNull();
  });

  it("round-trips: saving the loaded values changes nothing", async () => {
    const id = await draft();
    await updateProduct(
      ADMIN,
      id,
      form({
        description: "Text",
        variants: [
          { modelNo: "A1", label: "Lens", specs: { lens: ["PC"] } },
          { modelNo: "A2" },
        ],
        extraSpecs: [{ group: "G", label: "L", value: "V" }],
        filters: { cctK: [3000, 4000] },
      }),
    );
    const edit = await getProductForEdit(id);
    const again = await updateProduct(ADMIN, id, edit?.values);
    expect(again).toEqual({ ok: true, data: { id }, tags: [] });
  });
});

describe("updateProduct", () => {
  it("saves changed fields only, audits field names and returns product tags", async () => {
    const id = await draft();
    const result = await updateProduct(
      ADMIN,
      id,
      form({ family: "Arc", areas: [area], datasheetId: datasheet }),
    );
    expect(result).toEqual({
      ok: true,
      data: { id },
      tags: ["products", `product:${id}`],
    });
    expect(await ProductModel.findById(id).lean()).toMatchObject({
      family: "Arc",
      variants: [{ modelNo: "AR-013A1" }],
    });
    const [entry] = await AuditLogModel.find({})
      .sort({ _id: -1 })
      .limit(1)
      .lean();
    expect(entry).toMatchObject({ action: "product.update" });
    expect(JSON.stringify(entry?.meta)).toContain("areas");
    expect(JSON.stringify(entry?.meta)).not.toContain("AR-013A1");
  });

  it("is a no-op when nothing changed: no write, audit or tags", async () => {
    const id = await draft();
    await updateProduct(ADMIN, id, form());
    const before = await ProductModel.findById(id).lean();
    const auditBefore = await AuditLogModel.countDocuments();

    const result = await updateProduct(ADMIN, id, form());
    expect(result).toEqual({ ok: true, data: { id }, tags: [] });
    expect(await AuditLogModel.countDocuments()).toBe(auditBefore);
    expect((await ProductModel.findById(id).lean())?.updatedAt).toEqual(
      before?.updatedAt,
    );
  });

  it("unsets optional fields cleared in the form and never touches images", async () => {
    const id = await draft();
    await updateProduct(ADMIN, id, form({ family: "Arc", description: "x" }));
    await addImage(id);
    await updateProduct(ADMIN, id, form({ family: "", description: "" }));
    const doc = await ProductModel.findById(id).lean();
    expect(doc?.family).toBeUndefined();
    expect(doc?.description).toBeUndefined();
    expect(doc?.images).toHaveLength(1);
  });

  it("refuses unknown keys such as images or featured", async () => {
    const id = await draft();
    expect((await updateProduct(ADMIN, id, form({ images: [] }))).ok).toBe(
      false,
    );
    expect((await updateProduct(ADMIN, id, form({ featured: true }))).ok).toBe(
      false,
    );
  });

  it("refuses missing categories, areas and datasheets with field errors", async () => {
    const id = await draft();
    const ghost = new ObjectId().toHexString();
    const result = await updateProduct(
      ADMIN,
      id,
      form({
        mainCategory: ghost,
        extraCategories: [new ObjectId().toHexString()],
        areas: [ghost],
        datasheetId: ghost,
      }),
    );
    const errors = fieldErrorsOf(result);
    expect(Object.keys(errors).sort()).toEqual([
      "areas",
      "datasheetId",
      "extraCategories",
      "mainCategory",
    ]);
    expect(result.tags).toEqual([]);
    expect(await actions()).toEqual(["product.create"]);
  });

  it("refuses the main category repeated as an extra category", async () => {
    const id = await draft();
    const result = await updateProduct(
      ADMIN,
      id,
      form({ extraCategories: [spot] }),
    );
    expect(fieldErrorsOf(result).extraCategories).toBeDefined();
  });

  it("returns not found for bad and unknown ids and throws for a bad actor", async () => {
    expect((await updateProduct(ADMIN, "nope", form())).ok).toBe(false);
    expect((await updateProduct(ADMIN, { $ne: null }, form())).ok).toBe(false);
    const gone = await updateProduct(
      ADMIN,
      new ObjectId().toHexString(),
      form(),
    );
    expect(!gone.ok && gone.errors.formErrors[0]).toMatch(/no longer exists/);
    await expect(updateProduct("x", await draft(), form())).rejects.toThrow(
      TypeError,
    );
  });

  it("keeps the change and returns tags when the audit write fails", async () => {
    const id = await draft();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(AuditLogModel, "create").mockRejectedValueOnce(new Error("boom"));
    const result = await updateProduct(ADMIN, id, form({ family: "Arc" }));
    expect(result.ok).toBe(false);
    expect(result.tags).toEqual(["products", `product:${id}`]);
    expect((await ProductModel.findById(id).lean())?.family).toBe("Arc");
  });

  describe("trackSize rule", () => {
    it("is refused for a non-Magnetic-Track product", async () => {
      const id = await draft();
      const result = await updateProduct(ADMIN, id, form({ trackSize: 10 }));
      expect(fieldErrorsOf(result).trackSize).toBeDefined();
      expect(
        (await ProductModel.findById(id).lean())?.trackSize,
      ).toBeUndefined();
    });

    it("is allowed for the Magnetic Track main category, a child, or an extra category", async () => {
      const a = await draft("A", track);
      expectOk(
        await updateProduct(
          ADMIN,
          a,
          form({ mainCategory: track, trackSize: 10 }),
        ),
      );
      const b = await draft("B", track5);
      expectOk(
        await updateProduct(
          ADMIN,
          b,
          form({
            mainCategory: track5,
            trackSize: 5,
            variants: [{ modelNo: "B1" }],
          }),
        ),
      );
      const c = await draft("C", spot);
      expectOk(
        await updateProduct(
          ADMIN,
          c,
          form({
            extraCategories: [track5],
            trackSize: 20,
            variants: [{ modelNo: "C1" }],
          }),
        ),
      );
      expect((await ProductModel.findById(c).lean())?.trackSize).toBe(20);
    });

    it("rejects sizes outside 5, 10, 20 and clears with null", async () => {
      const id = await draft("A", track);
      expect(
        (
          await updateProduct(
            ADMIN,
            id,
            form({ mainCategory: track, trackSize: 7 }),
          )
        ).ok,
      ).toBe(false);
      await updateProduct(
        ADMIN,
        id,
        form({ mainCategory: track, trackSize: 10 }),
      );
      await updateProduct(
        ADMIN,
        id,
        form({ mainCategory: track, trackSize: null }),
      );
      expect(
        (await ProductModel.findById(id).lean())?.trackSize,
      ).toBeUndefined();
    });
  });

  describe("duplicate model no.", () => {
    it("pre-check maps a model no. used by another product to variants.N.modelNo", async () => {
      const a = await draft("A");
      await updateProduct(ADMIN, a, form({ variants: [{ modelNo: "X1" }] }));
      const b = await draft("B");
      const result = await updateProduct(
        ADMIN,
        b,
        form({ name: "B", variants: [{ modelNo: "Y1" }, { modelNo: "X1" }] }),
      );
      expect(fieldErrorsOf(result)).toEqual({
        "variants.1.modelNo": [expect.stringMatching(/another product/)],
      });
      expect(
        await ProductModel.countDocuments({ "variants.modelNo": "X1" }),
      ).toBe(1);
    });

    it("maps the unique-index error (race) to the same field error", async () => {
      const a = await draft("A");
      await updateProduct(ADMIN, a, form({ variants: [{ modelNo: "X1" }] }));
      const b = await draft("B");
      // Skip the pre-check so the partial unique index is what refuses.
      vi.spyOn(ProductModel, "find").mockReturnValue({
        lean: () => Promise.resolve([]),
      } as never);
      const result = await updateProduct(
        ADMIN,
        b,
        form({ name: "B", variants: [{ modelNo: "Y1" }, { modelNo: "X1" }] }),
      );
      expect(fieldErrorsOf(result)).toEqual({
        "variants.1.modelNo": [expect.stringMatching(/another product/)],
      });
    });

    it("refuses repeats inside one product (case-insensitive)", async () => {
      const id = await draft();
      const result = await updateProduct(
        ADMIN,
        id,
        form({ variants: [{ modelNo: "a1" }, { modelNo: "A1" }] }),
      );
      expect(fieldErrorsOf(result).variants).toBeDefined();
    });
  });

  describe("slug", () => {
    it("keeps the slug when empty, refuses a taken one, accepts a free one", async () => {
      const a = await draft("A");
      const b = await draft("B");
      expect((await ProductModel.findById(b).lean())?.slug).toBe("b");
      await updateProduct(ADMIN, b, form({ name: "B2", slug: "" }));
      expect((await ProductModel.findById(b).lean())?.slug).toBe("b");

      const taken = await updateProduct(
        ADMIN,
        b,
        form({ name: "B2", slug: "a" }),
      );
      expect(fieldErrorsOf(taken).slug).toBeDefined();

      expectOk(
        await updateProduct(ADMIN, b, form({ name: "B2", slug: "b-new" })),
      );
      expect((await ProductModel.findById(b).lean())?.slug).toBe("b-new");
      expect(a).toBeTruthy();
    });
  });

  describe("status (T10a: only publish/unpublish change it)", () => {
    it("ignores status in the form, both ways", async () => {
      const id = await draft();
      await addImage(id);
      const result = await updateProduct(
        ADMIN,
        id,
        form({ status: "published" }),
      );
      expect(result.ok).toBe(true);
      expect((await ProductModel.findById(id).lean())?.status).toBe("draft");
      // A draft's save expires only the product tags.
      expect(result.tags).toEqual(["products", `product:${id}`]);

      await publishProduct(ADMIN, id);
      const live = await updateProduct(
        ADMIN,
        id,
        form({ name: "Arc 2", status: "draft" }),
      );
      expect(live.tags).toEqual([
        "products",
        `product:${id}`,
        "categories",
        "areas",
      ]);
      const row = await ProductModel.findById(id).lean();
      expect(row?.status).toBe("published");
      expect(row?.name).toBe("Arc 2");
      expect((await actions()).at(-1)).toBe("product.update");
    });

    it("refuses a save that would leave a published product unpublishable", async () => {
      const id = await draft();
      await updateProduct(ADMIN, id, form());
      await addImage(id);
      await publishProduct(ADMIN, id);
      const result = await updateProduct(ADMIN, id, form({ variants: [] }));
      expect(Object.keys(fieldErrorsOf(result)).sort()).toEqual([
        "status",
        "variants",
      ]);
      expect(result.tags).toEqual([]);
      expect((await ProductModel.findById(id).lean())?.variants).toHaveLength(
        1,
      );
    });
  });

  describe("expectedUpdatedAt (stale page)", () => {
    async function versionOf(id: string): Promise<string> {
      const row = await ProductModel.findById(id).lean();
      return row?.updatedAt.toISOString() ?? "";
    }
    async function touch(id: string) {
      await ProductModel.updateOne(
        { _id: id },
        { $set: { updatedAt: new Date(Date.now() + 5000) } },
        { timestamps: false },
      );
    }

    it("saves while the version matches, refuses once someone wrote since", async () => {
      const id = await draft();
      const ok = await updateProduct(ADMIN, id, form(), {
        expectedUpdatedAt: await versionOf(id),
      });
      expect(ok.ok).toBe(true);

      const loaded = await versionOf(id);
      await touch(id);
      const before = await ProductModel.findById(id).lean();
      const stale = await updateProduct(ADMIN, id, form({ name: "Old tab" }), {
        expectedUpdatedAt: loaded,
      });
      expect(stale).toEqual({
        ok: false,
        errors: { formErrors: [PRODUCT_CHANGED], fieldErrors: {} },
        tags: [],
      });
      expect(await ProductModel.findById(id).lean()).toEqual(before);
      expect(await actions()).toEqual(["product.create", "product.update"]);
    });

    it("refuses a malformed version but allows none", async () => {
      const id = await draft();
      for (const bad of [undefined, "", "2026-13-01", { $gt: "" }, 0]) {
        const result = await updateProduct(ADMIN, id, form(), {
          expectedUpdatedAt: bad,
        });
        expect(!result.ok && result.errors.formErrors).toEqual([
          PRODUCT_CHANGED,
        ]);
      }
      expect((await updateProduct(ADMIN, id, form())).ok).toBe(true);
    });

    it("guards publish and unpublish the same way", async () => {
      const id = await draft();
      await updateProduct(ADMIN, id, form());
      await addImage(id);
      const loaded = await versionOf(id);
      await touch(id);
      const stale = await publishProduct(ADMIN, id, {
        expectedUpdatedAt: loaded,
      });
      expect(!stale.ok && stale.errors.formErrors).toEqual([PRODUCT_CHANGED]);
      expect((await ProductModel.findById(id).lean())?.status).toBe("draft");

      const fresh = await publishProduct(ADMIN, id, {
        expectedUpdatedAt: await versionOf(id),
      });
      expect(fresh.ok).toBe(true);
      const unpub = await unpublishProduct(ADMIN, id, {
        expectedUpdatedAt: loaded,
      });
      expect(!unpub.ok && unpub.errors.formErrors).toEqual([PRODUCT_CHANGED]);
      expect((await ProductModel.findById(id).lean())?.status).toBe(
        "published",
      );
    });

    /*
     * The race the read-time check can't see: the service reads the product
     * (version still matches), then another write lands before its updateOne.
     * The filtered updateOne must then match nothing and report the change.
     */
    function writeAfterNextRead(id: string) {
      const original = ProductModel.findById.bind(ProductModel);
      vi.spyOn(ProductModel, "findById").mockImplementationOnce(((
        ...args: Parameters<typeof original>
      ) => {
        const query = original(...args);
        const lean = query.lean.bind(query);
        query.lean = ((...leanArgs: Parameters<typeof lean>) =>
          lean(...leanArgs).then(async (doc: unknown) => {
            await touch(id);
            return doc;
          })) as unknown as typeof query.lean;
        return query;
      }) as typeof ProductModel.findById);
    }

    it("refuses a save when another write lands between read and write", async () => {
      const id = await draft();
      await updateProduct(ADMIN, id, form());
      const loaded = await versionOf(id);
      writeAfterNextRead(id);
      const result = await updateProduct(ADMIN, id, form({ name: "Racer" }), {
        expectedUpdatedAt: loaded,
      });
      expect(result).toEqual({
        ok: false,
        errors: { formErrors: [PRODUCT_CHANGED], fieldErrors: {} },
        tags: [],
      });
      expect((await ProductModel.findById(id).lean())?.name).toBe("Arc");
      expect(await actions()).toEqual(["product.create", "product.update"]);
    });

    it("refuses a publish when another write lands between read and write", async () => {
      const id = await draft();
      await updateProduct(ADMIN, id, form());
      await addImage(id);
      const loaded = await versionOf(id);
      writeAfterNextRead(id);
      const result = await publishProduct(ADMIN, id, {
        expectedUpdatedAt: loaded,
      });
      expect(!result.ok && result.errors.formErrors).toEqual([PRODUCT_CHANGED]);
      expect(result.tags).toEqual([]);
      expect((await ProductModel.findById(id).lean())?.status).toBe("draft");
      expect((await actions()).at(-1)).toBe("product.update");
    });
  });
});

describe("publishProduct / unpublishProduct", () => {
  it("refuses publish until variant, category and image exist", async () => {
    const id = await draft();
    const first = await publishProduct(ADMIN, id);
    expect(Object.keys(fieldErrorsOf(first)).sort()).toEqual([
      "images",
      "status",
      "variants",
    ]);

    await updateProduct(ADMIN, id, form());
    await addImage(id);
    const done = await publishProduct(ADMIN, id);
    expect(done).toEqual({
      ok: true,
      data: { id },
      tags: ["products", `product:${id}`, "categories", "areas"],
    });
    expect((await ProductModel.findById(id).lean())?.status).toBe("published");
    expect((await actions()).at(-1)).toBe("product.publish");
  });

  it("is a no-op when already in that state, and unpublish returns to draft", async () => {
    const id = await draft();
    expect(await unpublishProduct(ADMIN, id)).toEqual({
      ok: true,
      data: { id },
      tags: [],
    });
    await updateProduct(ADMIN, id, form());
    await addImage(id);
    await publishProduct(ADMIN, id);
    expect(await publishProduct(ADMIN, id)).toEqual({
      ok: true,
      data: { id },
      tags: [],
    });

    const result = await unpublishProduct(ADMIN, id);
    expect(result.ok).toBe(true);
    expect((await ProductModel.findById(id).lean())?.status).toBe("draft");
    expect((await actions()).at(-1)).toBe("product.unpublish");
  });

  it("handles unknown/bad ids and audit failure", async () => {
    expect((await publishProduct(ADMIN, new ObjectId().toHexString())).ok).toBe(
      false,
    );
    expect((await publishProduct(ADMIN, { $ne: null })).ok).toBe(false);
    expect((await unpublishProduct(ADMIN, "x")).ok).toBe(false);

    const id = await draft();
    await updateProduct(ADMIN, id, form());
    await addImage(id);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(AuditLogModel, "create").mockRejectedValueOnce(new Error("boom"));
    const result = await publishProduct(ADMIN, id);
    expect(result.ok).toBe(false);
    expect(result.tags).toContain("categories");
    expect((await ProductModel.findById(id).lean())?.status).toBe("published");
  });
});

describe("deleteProduct", () => {
  it("deletes the document, audits ids and counts only, returns tags", async () => {
    const id = await draft("Secret name");
    await updateProduct(ADMIN, id, form({ name: "Secret name" }));
    await addImage(id);

    const result = await deleteProduct(ADMIN, id);
    expect(result).toEqual({
      ok: true,
      data: { id },
      tags: ["products", `product:${id}`],
    });
    expect(await ProductModel.countDocuments()).toBe(0);
    const [entry] = await AuditLogModel.find({})
      .sort({ _id: -1 })
      .limit(1)
      .lean();
    expect(entry).toMatchObject({
      action: "product.delete",
      meta: { status: "draft", variantCount: 1, imageCount: 1 },
    });
    expect(JSON.stringify(entry)).not.toContain("Secret name");
  });

  it("also expires category and area tags for a published product", async () => {
    const id = await draft();
    await updateProduct(ADMIN, id, form());
    await addImage(id);
    await publishProduct(ADMIN, id);
    const result = await deleteProduct(ADMIN, id);
    expect(result.tags).toEqual([
      "products",
      `product:${id}`,
      "categories",
      "areas",
    ]);
  });

  it("reports missing and bad ids", async () => {
    expect((await deleteProduct(ADMIN, new ObjectId().toHexString())).ok).toBe(
      false,
    );
    expect((await deleteProduct(ADMIN, "x")).ok).toBe(false);
    expect((await deleteProduct(ADMIN, { $ne: null })).ok).toBe(false);
    await expect(deleteProduct("x", await draft())).rejects.toThrow(TypeError);
  });
});

describe("listProducts", () => {
  async function seed(count: number) {
    await ProductModel.insertMany(
      Array.from({ length: count }, (_, i) => ({
        name: `Product ${String(i).padStart(2, "0")}`,
        slug: `product-${i}`,
        mainCategory: new ObjectId(spot),
        variants: [{ modelNo: `M-${i}` }],
        status: i % 2 === 0 ? "published" : "draft",
        updatedAt: new Date(2026, 0, 1, 0, 0, i),
      })),
      { timestamps: false },
    );
  }

  it("pages 25 at a time, newest first, with page info", async () => {
    await seed(30);
    const first = await listProducts({});
    expect(first).toMatchObject({
      total: 30,
      page: 1,
      pageSize: PRODUCTS_PAGE_SIZE,
      pageCount: 2,
    });
    expect(first.items).toHaveLength(25);
    expect(first.items[0]?.name).toBe("Product 29");

    const second = await listProducts({ page: "2" });
    expect(second.items).toHaveLength(5);
    expect(second.items.at(-1)?.name).toBe("Product 00");
    expect((await listProducts({ page: 9 })).items).toEqual([]);
  });

  it("falls back to defaults for bad page, status and category values", async () => {
    await seed(3);
    for (const bad of [
      { page: -4 },
      { page: "abc" },
      { page: { $gt: 0 } },
      { status: "x" },
      { category: "nope" },
      { q: { $ne: "" } },
      null,
      "str",
    ]) {
      const page = await listProducts(bad);
      expect(page.page).toBe(1);
      expect(page.total).toBe(3);
    }
  });

  it("filters by status", async () => {
    await seed(4);
    expect((await listProducts({ status: "published" })).total).toBe(2);
    expect((await listProducts({ status: "draft" })).total).toBe(2);
  });

  it("searches name, family, code and variant model no., trimmed and case-insensitive", async () => {
    const id = await draft("Plain");
    await updateProduct(
      ADMIN,
      id,
      form({
        name: "Plain",
        family: "Orbit",
        modelCode: "OR-9",
        variants: [{ modelNo: "OR-9A1" }],
      }),
    );
    await draft("Other");
    for (const q of ["  orbit ", "or-9", "or-9a1", "plain"]) {
      const page = await listProducts({ q });
      expect(page.items.map((i) => i.id)).toEqual([id]);
    }
    expect((await listProducts({ q: "zzz" })).total).toBe(0);
  });

  it("treats regex metacharacters literally", async () => {
    const id = await draft("Spot (2.0)+");
    await draft("Spot 2x0");
    expect(
      (await listProducts({ q: "(2.0)+" })).items.map((i) => i.id),
    ).toEqual([id]);
    expect((await listProducts({ q: ".*" })).total).toBe(0);
    expect((await listProducts({ q: "[" })).total).toBe(0);
    expect((await listProducts({ q: "\\" })).total).toBe(0);
  });

  it("cuts the search text to 80 characters instead of failing", async () => {
    await draft("Arc");
    const long = "Arc" + "x".repeat(200);
    const page = await listProducts({ q: long });
    expect(page.total).toBe(0);
    const padded = await listProducts({ q: "Arc" + " ".repeat(200) + "b" });
    expect(padded.total).toBe(1);
  });

  it("filters by category including its children and extra categories", async () => {
    const a = await draft("A", track);
    const b = await draft("B", track5);
    const c = await draft("C", spot);
    await updateProduct(
      ADMIN,
      c,
      form({
        name: "C",
        extraCategories: [track5],
        variants: [{ modelNo: "C1" }],
      }),
    );
    await draft("D", spot);
    const ids = (await listProducts({ category: track })).items
      .map((i) => i.id)
      .sort();
    expect(ids).toEqual([a, b, c].sort());
    expect((await listProducts({ category: track5 })).total).toBe(2);
  });

  it("returns list fields only, never spec values", async () => {
    const id = await draft();
    await updateProduct(
      ADMIN,
      id,
      form({
        specs: { driver: ["Secret driver"] },
        variants: [{ modelNo: "A1", specs: { batchNo: ["B-77"] } }],
      }),
    );
    await addImage(id);
    const page = await listProducts({});
    expect(page.items[0]).toEqual({
      id,
      name: "Arc",
      slug: "arc",
      family: null,
      modelCode: null,
      status: "draft",
      mainCategoryId: spot,
      mainCategoryName: "Spot Lights",
      variantCount: 1,
      firstModelNo: "A1",
      imageCount: 1,
      thumbPublicId: "p/a",
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(page)).not.toContain("Secret driver");
    expect(JSON.stringify(page)).not.toContain("B-77");
  });
});
