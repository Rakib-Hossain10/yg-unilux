// Tests for the area services (src/lib/admin/areas.ts) on an in-memory
// MongoDB: slugs, edit diffs, the b/w image (verified uploads only), move
// up/down, the in-use delete block, audit entries and the returned tags.
// Cloudinary is mocked; nothing leaves the machine.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { mongoose } from "@/lib/db";
import { AreaModel, ProductModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";
import { setupMemoryDb } from "../../../test/helpers/memory-db";
import { testPublicId } from "../../../test/helpers/public-ids";

import {
  BW_IMAGE_AFTER_CREATE,
  BW_IMAGE_USE_UPLOADER,
  createArea,
  deleteArea,
  getAreaForEdit,
  listAreas,
  moveArea,
  setAreaImage,
  updateArea,
} from "./areas";
import { IMAGE_REJECTED } from "./uploads";
import { AUDIT_FAILED_MESSAGE, type ServiceResult } from "./write-result";

const cloudinaryMock = vi.hoisted(() => ({
  inspectImage: vi.fn(),
  destroyImage: vi.fn(),
}));
vi.mock("@/lib/cloudinary", () => cloudinaryMock);

setupMemoryDb("yg_admin_areas_test");

const { ObjectId } = mongoose.Types;
const ADMIN = new ObjectId().toHexString();

beforeAll(async () => {
  // Indexes are built by `npm run db:indexes`, never on startup; build the
  // unique slug index here so the duplicate-key path is real.
  await AreaModel.createIndexes();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  cloudinaryMock.inspectImage.mockReset().mockResolvedValue({
    ok: true,
    bytes: 1000,
    format: "jpg",
    width: 10,
    height: 10,
  });
  cloudinaryMock.destroyImage.mockReset().mockResolvedValue(true);
  await Promise.all([
    AreaModel.deleteMany({}),
    ProductModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
});

/* The data of a successful result; fails the test with its errors otherwise. */
function expectOk<T>(result: ServiceResult<T>): T {
  if (!result.ok)
    throw new Error(`expected ok: ${JSON.stringify(result.errors)}`);
  return result.data;
}

async function create(name: string, slug = "") {
  return expectOk(await createArea(ADMIN, { name, slug })).id;
}

/* A b/w image id in this area's own folder. */
function bw(areaId: string, n = 0): string {
  return testPublicId(n, areaId, "area");
}

/* Stores a b/w image directly, as a verified upload would have. */
async function storeBw(areaId: string, n = 0): Promise<string> {
  const publicId = bw(areaId, n);
  await AreaModel.updateOne({ _id: areaId }, { $set: { bwImage: publicId } });
  return publicId;
}

async function names(): Promise<string[]> {
  return (await listAreas()).map((area) => area.name);
}

async function auditActions(): Promise<string[]> {
  const rows = await AuditLogModel.find({}).sort({ _id: 1 }).lean();
  return rows.map((row) => row.action);
}

describe("createArea", () => {
  it("creates an area with a slug from the name, audits it and returns the areas tag", async () => {
    const result = await createArea(ADMIN, { name: "Retail", bwImage: "" });

    expect(result).toEqual({
      ok: true,
      data: { id: expect.any(String) },
      tags: ["areas"],
    });
    const id = expectOk(result).id;
    expect(await AreaModel.findById(id).lean()).toMatchObject({
      name: "Retail",
      slug: "retail",
      order: 0,
    });
    expect(await AreaModel.findById(id).lean()).not.toHaveProperty("bwImage");

    const [entry, ...rest] = await AuditLogModel.find({}).lean();
    expect(rest).toHaveLength(0);
    expect(entry?.actor?.toHexString()).toBe(ADMIN);
    expect(entry).toMatchObject({
      action: "area.create",
      target: { type: "area", id },
    });
  });

  it("puts each new area last and gives a taken generated slug a -2 suffix", async () => {
    await create("Retail");
    await create("Office");
    await create("Retail");

    expect(await names()).toEqual(["Retail", "Office", "Retail"]);
    const slugs = (await listAreas()).map((area) => area.slug);
    expect(slugs).toEqual(["retail", "office", "retail-2"]);
  });

  it("refuses a typed slug that is taken, writing and auditing nothing more", async () => {
    await create("Retail");
    const result = await createArea(ADMIN, { name: "Shops", slug: "retail" });

    expect(result).toEqual({
      ok: false,
      errors: {
        formErrors: [],
        fieldErrors: { slug: [expect.stringMatching(/already uses/)] },
      },
      tags: [],
    });
    expect(await AreaModel.countDocuments()).toBe(1);
    expect(await auditActions()).toEqual(["area.create"]);
  });

  it("maps a duplicate-key race on insert to the slug field error", async () => {
    await create("Retail");
    vi.spyOn(AreaModel, "exists").mockResolvedValue(null);

    const result = await createArea(ADMIN, { name: "Shops", slug: "retail" });
    expect(!result.ok && result.errors.fieldErrors.slug).toEqual([
      expect.stringMatching(/already uses/),
    ]);
    expect(await AreaModel.countDocuments()).toBe(1);
  });

  it("asks for a slug when the name has none to make one from", async () => {
    const result = await createArea(ADMIN, { name: "零售" });
    expect(!result.ok && result.errors.fieldErrors.slug).toEqual([
      expect.stringMatching(/Enter a slug/),
    ]);
    expect(await AreaModel.countDocuments()).toBe(0);
  });

  it("returns Zod field errors for bad input and writes nothing", async () => {
    const result = await createArea(ADMIN, { name: "", order: 5 });
    expect(result.ok).toBe(false);
    expect(result.tags).toEqual([]);
    expect(!result.ok && result.errors.fieldErrors.name).toBeDefined();
    expect(await AreaModel.countDocuments()).toBe(0);
    expect(await auditActions()).toEqual([]);
  });

  it("throws before writing when the actor id is not an ObjectId", async () => {
    await expect(createArea("admin", { name: "Retail" })).rejects.toThrow(
      TypeError,
    );
    expect(await AreaModel.countDocuments()).toBe(0);
  });

  it("keeps the area and still returns the tags when the audit write fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(AuditLogModel, "create").mockRejectedValueOnce(
      new Error("E11000 secret value Retail"),
    );

    const result = await createArea(ADMIN, { name: "Retail" });

    expect(result).toEqual({
      ok: false,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
      tags: ["areas"],
    });
    expect(await AreaModel.countDocuments({ slug: "retail" })).toBe(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret value");
  });
});

describe("getAreaForEdit and listAreas", () => {
  it("returns the form values, or null for a bad or unknown id", async () => {
    const id = await create("Retail");
    const publicId = await storeBw(id);
    expect(await getAreaForEdit(id)).toEqual({
      id,
      name: "Retail",
      slug: "retail",
      bwImage: publicId,
    });
    expect(await getAreaForEdit(new ObjectId().toHexString())).toBeNull();
    expect(await getAreaForEdit("nope")).toBeNull();
    expect(await getAreaForEdit({ $ne: null })).toBeNull();
  });

  it("lists areas in display order with a null bwImage when unset", async () => {
    await create("Retail");
    await create("Office");
    expect(await listAreas()).toEqual([
      expect.objectContaining({ name: "Retail", bwImage: null, order: 0 }),
      expect.objectContaining({ name: "Office", bwImage: null, order: 1 }),
    ]);
  });
});

describe("updateArea", () => {
  it("saves changed fields, audits their names and returns areas + products tags", async () => {
    const id = await create("Retail");
    const publicId = await storeBw(id);
    const result = await updateArea(ADMIN, id, {
      name: "Retail Spaces",
      slug: "",
      bwImage: publicId,
    });

    expect(result).toEqual({
      ok: true,
      data: { id },
      tags: ["areas", "products"],
    });
    expect(await AreaModel.findById(id).lean()).toMatchObject({
      name: "Retail Spaces",
      slug: "retail",
      bwImage: publicId,
    });
    const entry = await AuditLogModel.findOne({ action: "area.update" }).lean();
    expect(entry?.meta).toEqual({ fields: ["name"] });
  });

  it("removes bwImage when the form sends it blank", async () => {
    const id = await create("Retail");
    await storeBw(id);
    expectOk(await updateArea(ADMIN, id, { name: "Retail", bwImage: "" }));
    const row = await AreaModel.findById(id).lean();
    expect(row).not.toHaveProperty("bwImage");
    const entry = await AuditLogModel.findOne({ action: "area.update" }).lean();
    expect(entry?.meta).toEqual({ fields: ["bwImage"] });
  });

  it("never sets a new bwImage through the form, only keeps or clears it", async () => {
    const id = await create("Retail");
    const stored = await storeBw(id, 0);
    for (const bwImage of [bw(id, 1), testPublicId(0)]) {
      const result = await updateArea(ADMIN, id, { name: "Shops", bwImage });
      expect(result).toEqual({
        ok: false,
        errors: {
          formErrors: [],
          fieldErrors: { bwImage: [BW_IMAGE_USE_UPLOADER] },
        },
        tags: [],
      });
    }
    expect(await AreaModel.findById(id).lean()).toMatchObject({
      name: "Retail",
      bwImage: stored,
    });
    expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
  });

  it("changes nothing, audits nothing and returns no tags when nothing differs", async () => {
    const id = await create("Retail");
    const result = await updateArea(ADMIN, id, { name: "Retail" });
    expect(result).toEqual({ ok: true, data: { id }, tags: [] });
    expect(await auditActions()).toEqual(["area.create"]);
  });

  it("refuses a slug used by another area but allows keeping its own", async () => {
    await create("Retail");
    const office = await create("Office");

    const taken = await updateArea(ADMIN, office, {
      name: "Office",
      slug: "retail",
    });
    expect(taken).toEqual({
      ok: false,
      errors: {
        formErrors: [],
        fieldErrors: { slug: [expect.stringMatching(/already uses/)] },
      },
      tags: [],
    });

    const own = await updateArea(ADMIN, office, {
      name: "Offices",
      slug: "office",
    });
    expect(own.ok).toBe(true);
  });

  it("maps a duplicate-key race on update to the slug field error", async () => {
    await create("Retail");
    const office = await create("Office");
    vi.spyOn(AreaModel, "exists").mockResolvedValue(null);

    const result = await updateArea(ADMIN, office, {
      name: "Office",
      slug: "retail",
    });
    expect(!result.ok && result.errors.fieldErrors.slug).toBeDefined();
    expect((await AreaModel.findById(office).lean())?.slug).toBe("office");
  });

  it("returns not found for bad or unknown ids and Zod errors for bad input", async () => {
    for (const id of [new ObjectId().toHexString(), "nope", { $ne: null }]) {
      const result = await updateArea(ADMIN, id, { name: "X" });
      expect(!result.ok && result.errors.formErrors).toEqual([
        expect.stringMatching(/no longer exists/),
      ]);
    }
    const id = await create("Retail");
    const bad = await updateArea(ADMIN, id, { name: "" });
    expect(!bad.ok && bad.errors.fieldErrors.name).toBeDefined();
    expect(bad.tags).toEqual([]);
  });
});

describe("area b/w image", () => {
  it("refuses a bwImage on create (the upload folder needs the area id)", async () => {
    const result = await createArea(ADMIN, {
      name: "Retail",
      bwImage: testPublicId(0),
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        formErrors: [],
        fieldErrors: { bwImage: [BW_IMAGE_AFTER_CREATE] },
      },
      tags: [],
    });
    expect(await AreaModel.countDocuments({})).toBe(0);
  });

  it("refuses a bwImage that is not in our id shape (gate A L-2)", async () => {
    const id = await create("Retail");
    const result = await updateArea(ADMIN, id, {
      name: "Retail",
      bwImage: "areas/retail-bw",
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? {} : result.errors.fieldErrors).toHaveProperty(
      "bwImage",
    );
  });

  it("setAreaImage saves a verified upload, audits it and returns the areas tag", async () => {
    const id = await create("Retail");
    const publicId = bw(id);
    const result = await setAreaImage(ADMIN, { areaId: id, publicId });
    expect(result).toEqual({
      ok: true,
      data: { id, bwImage: publicId },
      tags: ["areas"],
    });
    expect(cloudinaryMock.inspectImage).toHaveBeenCalledWith(publicId);
    expect(cloudinaryMock.destroyImage).not.toHaveBeenCalled();
    expect((await AreaModel.findById(id).lean())?.bwImage).toBe(publicId);
    const entry = await AuditLogModel.findOne({ action: "area.update" }).lean();
    expect(entry?.meta).toEqual({ fields: ["bwImage"], cleared: false });
  });

  it("setAreaImage clears the image with null or blank", async () => {
    const id = await create("Retail");
    await storeBw(id);
    for (const publicId of [null, ""]) {
      await AreaModel.updateOne({ _id: id }, { $set: { bwImage: bw(id) } });
      expectOk(await setAreaImage(ADMIN, { areaId: id, publicId }));
      expect(await AreaModel.findById(id).lean()).not.toHaveProperty("bwImage");
    }
    expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
  });

  it("setAreaImage with the stored id changes nothing", async () => {
    const id = await create("Retail");
    const publicId = await storeBw(id);
    expect(await setAreaImage(ADMIN, { areaId: id, publicId })).toEqual({
      ok: true,
      data: { id, bwImage: publicId },
      tags: [],
    });
    expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
  });

  it.each([
    ["too_large" as const],
    ["bad_format" as const],
    ["missing" as const],
  ])(
    "setAreaImage deletes and refuses an upload that is %s, saving nothing",
    async (reason) => {
      const id = await create("Retail");
      const before = await storeBw(id, 0);
      cloudinaryMock.inspectImage.mockResolvedValue({ ok: false, reason });
      const publicId = bw(id, 1);
      const result = await setAreaImage(ADMIN, { areaId: id, publicId });
      expect(result).toEqual({
        ok: false,
        errors: {
          formErrors: [],
          fieldErrors: { publicId: [IMAGE_REJECTED[reason]] },
        },
        tags: [],
      });
      expect(cloudinaryMock.destroyImage).toHaveBeenCalledWith(publicId);
      expect((await AreaModel.findById(id).lean())?.bwImage).toBe(before);
      expect(await auditActions()).toEqual(["area.create"]);
    },
  );

  it("setAreaImage keeps the upload when Cloudinary can't be reached", async () => {
    const id = await create("Retail");
    cloudinaryMock.inspectImage.mockResolvedValue({
      ok: false,
      reason: "unavailable",
    });
    const result = await setAreaImage(ADMIN, { areaId: id, publicId: bw(id) });
    expect(result.ok).toBe(false);
    expect(cloudinaryMock.destroyImage).not.toHaveBeenCalled();
    expect(await AreaModel.findById(id).lean()).not.toHaveProperty("bwImage");
  });

  it("setAreaImage refuses another area's or a product's id and never deletes it", async () => {
    const id = await create("Retail");
    const other = await create("Office");
    for (const publicId of [bw(other), testPublicId(0, id, "product")]) {
      const result = await setAreaImage(ADMIN, { areaId: id, publicId });
      expect(result).toEqual({
        ok: false,
        errors: {
          formErrors: [],
          fieldErrors: { publicId: [IMAGE_REJECTED.foreign] },
        },
        tags: [],
      });
    }
    expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
    expect(cloudinaryMock.destroyImage).not.toHaveBeenCalled();
  });

  it("setAreaImage refuses an unknown area and bad input", async () => {
    const missing = new ObjectId().toHexString();
    const result = await setAreaImage(ADMIN, {
      areaId: missing,
      publicId: bw(missing),
    });
    expect(result.ok).toBe(false);
    expect(
      (await setAreaImage(ADMIN, { areaId: "x", publicId: null })).ok,
    ).toBe(false);
    expect(
      (
        await setAreaImage(ADMIN, {
          areaId: missing,
          publicId: null,
          order: 1,
        })
      ).ok,
    ).toBe(false);
    expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
  });
});

describe("moveArea", () => {
  it("swaps an area with its neighbour and returns the areas tag", async () => {
    await create("Retail");
    const office = await create("Office");
    await create("Hotel");

    const result = await moveArea(ADMIN, { id: office, direction: "up" });
    expect(result).toEqual({
      ok: true,
      data: { moved: true },
      tags: ["areas"],
    });
    expect(await names()).toEqual(["Office", "Retail", "Hotel"]);
    expect(await auditActions()).toContain("area.reorder");

    await moveArea(ADMIN, { id: office, direction: "down" });
    expect(await names()).toEqual(["Retail", "Office", "Hotel"]);
  });

  it("does nothing at the ends", async () => {
    const retail = await create("Retail");
    const hotel = await create("Hotel");
    const before = (await auditActions()).length;

    expect(await moveArea(ADMIN, { id: retail, direction: "up" })).toEqual({
      ok: true,
      data: { moved: false },
      tags: [],
    });
    expect(
      (await moveArea(ADMIN, { id: hotel, direction: "down" })).tags,
    ).toEqual([]);
    expect(await names()).toEqual(["Retail", "Hotel"]);
    expect((await auditActions()).length).toBe(before);
  });

  it("repairs tied or gapped orders while moving", async () => {
    await AreaModel.create([
      { name: "A", slug: "a", order: 3 },
      { name: "B", slug: "b", order: 3 },
      { name: "C", slug: "c", order: 9 },
    ]);
    const c = (await AreaModel.findOne({ slug: "c" }).lean())?._id;
    await moveArea(ADMIN, { id: c?.toHexString(), direction: "up" });

    expect(await names()).toEqual(["A", "C", "B"]);
    const orders = (await listAreas()).map((area) => area.order);
    expect(orders).toEqual([0, 1, 2]);
  });

  it("returns not found for an unknown area and Zod errors for bad input", async () => {
    const missing = await moveArea(ADMIN, {
      id: new ObjectId().toHexString(),
      direction: "up",
    });
    expect(!missing.ok && missing.errors.formErrors).toEqual([
      expect.stringMatching(/no longer exists/),
    ]);
    const bad = await moveArea(ADMIN, { id: "x", direction: "sideways" });
    expect(bad.ok).toBe(false);
    expect(bad.tags).toEqual([]);
  });
});

describe("deleteArea", () => {
  it("deletes an unused area, audits it and returns the areas tag", async () => {
    const id = await create("Retail");
    const result = await deleteArea(ADMIN, id);

    expect(result).toEqual({ ok: true, data: { id }, tags: ["areas"] });
    expect(await AreaModel.countDocuments()).toBe(0);
    const entry = await AuditLogModel.findOne({ action: "area.delete" }).lean();
    expect(entry?.target).toMatchObject({ type: "area", id });
  });

  it("refuses while products use the area and says how many", async () => {
    const id = await create("Retail");
    const areaId = new ObjectId(id);
    for (const name of ["Arc", "Bar"]) {
      await ProductModel.create({
        name,
        slug: `${name.toLowerCase()}-${new ObjectId().toHexString()}`,
        mainCategory: new ObjectId(),
        areas: [areaId],
      });
    }

    const result = await deleteArea(ADMIN, id);
    expect(result).toEqual({
      ok: false,
      errors: {
        formErrors: [expect.stringMatching(/^2 products use this area/)],
        fieldErrors: {},
      },
      tags: [],
    });
    expect(await AreaModel.countDocuments()).toBe(1);
    expect(await auditActions()).toEqual(["area.create"]);
  });

  it("is not blocked by products that use other areas", async () => {
    const id = await create("Retail");
    await ProductModel.create({
      name: "Arc",
      slug: "arc-1",
      mainCategory: new ObjectId(),
      areas: [new ObjectId()],
    });
    expect((await deleteArea(ADMIN, id)).ok).toBe(true);
  });

  it("returns not found for bad or unknown ids", async () => {
    for (const id of [new ObjectId().toHexString(), "x", 7]) {
      const result = await deleteArea(ADMIN, id);
      expect(!result.ok && result.errors.formErrors).toEqual([
        expect.stringMatching(/no longer exists/),
      ]);
      expect(result.tags).toEqual([]);
    }
  });
});
