// Tests for saveProductImages (src/lib/admin/product-images.ts) on an
// in-memory MongoDB: add, reorder, remove, idempotence, verification of new
// uploads (Cloudinary mocked), variant and publish guards, versions, audit, tags.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mongoose } from "@/lib/db";
import { CategoryModel, ProductModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";
import { setupMemoryDb } from "../../../test/helpers/memory-db";
import { testPublicId } from "../../../test/helpers/public-ids";

import { PUBLISHED_NEEDS_IMAGE, saveProductImages } from "./product-images";
import { PRODUCT_CHANGED } from "./products";
import { IMAGE_REJECTED } from "./uploads";
import type { ServiceResult } from "./write-result";

const cloudinaryMock = vi.hoisted(() => ({
  inspectImage: vi.fn(),
  destroyImage: vi.fn(),
}));
vi.mock("@/lib/cloudinary", () => cloudinaryMock);

setupMemoryDb("yg_admin_product_images_test");

const { ObjectId } = mongoose.Types;
const ADMIN = new ObjectId().toHexString();

let product: string;
let category: mongoose.Types.ObjectId;

beforeEach(async () => {
  vi.restoreAllMocks();
  cloudinaryMock.inspectImage.mockReset().mockResolvedValue({
    ok: true,
    bytes: 1000,
    format: "jpg",
    width: 1,
    height: 1,
  });
  cloudinaryMock.destroyImage.mockReset().mockResolvedValue(true);
  await Promise.all([
    ProductModel.deleteMany({}),
    CategoryModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  category = (
    await CategoryModel.create({
      name: "Spot Lights",
      slug: "spot-lights",
      parent: null,
      order: 0,
    })
  )._id;
  product = await newProduct("arc");
});

async function newProduct(slug: string): Promise<string> {
  return (
    await ProductModel.create({ name: slug, slug, mainCategory: category })
  )._id.toHexString();
}

/* The n-th image id in `owner`'s folder (default: the test product). */
function img(n: number, owner = product): string {
  return testPublicId(n, owner);
}

function entry(n: number, kind = "gallery", owner = product) {
  return { publicId: img(n, owner), alt: `Image ${n}`, kind };
}

/* Saves directly, as an earlier verified save would have. */
async function store(images: ReturnType<typeof entry>[], extra = {}) {
  await ProductModel.updateOne(
    { _id: product },
    {
      $set: {
        images: images.map((image, order) => ({ ...image, order })),
        ...extra,
      },
    },
  );
}

async function storedImages() {
  const row = await ProductModel.findById(product).lean();
  return JSON.parse(JSON.stringify(row?.images ?? [])) as unknown;
}

function save(images: unknown[], options = {}) {
  return saveProductImages(ADMIN, { productId: product, images }, options);
}

function errorsOf<T>(result: ServiceResult<T>) {
  if (result.ok) throw new Error("expected a failure");
  return result.errors;
}

describe("saveProductImages", () => {
  it("adds verified new uploads in the given order, audits counts and returns tags", async () => {
    const result = await save([entry(0), entry(1, "dimension")]);
    expect(result).toEqual({
      ok: true,
      data: {
        id: product,
        images: [
          { ...entry(0), order: 0 },
          { ...entry(1, "dimension"), order: 1 },
        ],
      },
      tags: ["products", `product:${product}`],
    });
    expect(cloudinaryMock.inspectImage).toHaveBeenCalledTimes(2);
    expect(await storedImages()).toEqual([
      { ...entry(0), order: 0 },
      { ...entry(1, "dimension"), order: 1 },
    ]);
    const audit = await AuditLogModel.find({}).lean();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "product.images.update",
      target: { type: "product", id: product },
      meta: { imageCount: 2, added: 2, removed: 0 },
    });
    // Meta holds counts only: no ids, no alt text.
    expect(JSON.stringify(audit[0]?.meta)).not.toContain("yg/");
    expect(JSON.stringify(audit[0]?.meta)).not.toContain("Image 0");
  });

  it("is idempotent: the same list again changes, verifies and audits nothing", async () => {
    await store([entry(0), entry(1)]);
    const result = await save([entry(0), entry(1)]);
    expect(result).toEqual({
      ok: true,
      data: {
        id: product,
        images: [
          { ...entry(0), order: 0 },
          { ...entry(1), order: 1 },
        ],
      },
      tags: [],
    });
    expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
    expect(await AuditLogModel.countDocuments({})).toBe(0);
  });

  it("reorders, edits alt and kind without re-verifying stored images", async () => {
    await store([entry(0), entry(1)]);
    const changed = { ...entry(0), alt: "Front", kind: "installation" };
    expect((await save([entry(1), changed])).ok).toBe(true);
    expect(await storedImages()).toEqual([
      { ...entry(1), order: 0 },
      { ...changed, order: 1 },
    ]);
    expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
  });

  it("removes images from the list but leaves them in Cloudinary (T17 sweep)", async () => {
    await store([entry(0), entry(1)]);
    expect((await save([entry(1)])).ok).toBe(true);
    expect(await storedImages()).toEqual([{ ...entry(1), order: 0 }]);
    expect(cloudinaryMock.destroyImage).not.toHaveBeenCalled();
    const audit = await AuditLogModel.findOne({}).lean();
    expect(audit?.meta).toEqual({ imageCount: 1, added: 0, removed: 1 });
  });

  it.each(["too_large" as const, "bad_format" as const, "missing" as const])(
    "deletes a new upload that is %s and saves nothing",
    async (reason) => {
      await store([entry(0)]);
      cloudinaryMock.inspectImage.mockImplementation((publicId: string) =>
        Promise.resolve(
          publicId === img(2)
            ? { ok: false, reason }
            : { ok: true, bytes: 1, format: "jpg", width: 1, height: 1 },
        ),
      );
      const before = await storedImages();
      const result = await save([entry(0), entry(1), entry(2)]);
      expect(errorsOf(result)).toEqual({
        formErrors: [],
        fieldErrors: { "images.2.publicId": [IMAGE_REJECTED[reason]] },
      });
      expect(result.tags).toEqual([]);
      expect(cloudinaryMock.destroyImage).toHaveBeenCalledExactlyOnceWith(
        img(2),
      );
      expect(await storedImages()).toEqual(before);
      expect(await AuditLogModel.countDocuments({})).toBe(0);
    },
  );

  it("refuses another product's image and never deletes it", async () => {
    const other = await newProduct("other");
    const result = await save([entry(0), entry(0, "gallery", other)]);
    expect(errorsOf(result).fieldErrors).toEqual({
      "images.1.publicId": [IMAGE_REJECTED.foreign],
    });
    expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
    expect(cloudinaryMock.destroyImage).not.toHaveBeenCalled();
    expect(await storedImages()).toEqual([]);
  });

  it("accepts an image already saved on the product even without re-checking its folder", async () => {
    // e.g. an import that stored ids before this check existed
    const legacy = { publicId: testPublicId(9), alt: "Old", kind: "gallery" };
    await store([legacy]);
    expect((await save([legacy, entry(0)])).ok).toBe(true);
    expect(cloudinaryMock.inspectImage).toHaveBeenCalledExactlyOnceWith(img(0));
  });

  it("refuses to remove an image a variant uses", async () => {
    await store([entry(0), entry(1)], {
      variants: [
        { modelNo: "AR-1", imagePublicId: img(1) },
        { modelNo: "AR-2" },
      ],
    });
    const result = await save([entry(0)]);
    expect(errorsOf(result).fieldErrors).toEqual({
      images: [
        "An image you removed is used by variant AR-1. Choose another image for it first.",
      ],
    });
    expect((await storedImages()) as unknown[]).toHaveLength(2);
  });

  it("refuses to remove the last image of a published product", async () => {
    await store([entry(0)], {
      status: "published",
      variants: [{ modelNo: "AR-1" }],
    });
    const result = await save([]);
    expect(errorsOf(result).fieldErrors).toEqual({
      images: [PUBLISHED_NEEDS_IMAGE],
    });
    expect((await storedImages()) as unknown[]).toHaveLength(1);
  });

  it("lets a draft remove every image", async () => {
    await store([entry(0)]);
    expect((await save([])).ok).toBe(true);
    expect(await storedImages()).toEqual([]);
  });

  it("expires category and area listings for a published product", async () => {
    await store([entry(0)], {
      status: "published",
      variants: [{ modelNo: "AR-1" }],
    });
    const result = await save([entry(0), entry(1)]);
    expect(result.tags).toEqual([
      "products",
      `product:${product}`,
      "categories",
      "areas",
    ]);
  });

  it("refuses a stale version and a malformed one (ADR 0043)", async () => {
    const stale = new Date("2020-01-01T00:00:00.000Z").toISOString();
    for (const expectedUpdatedAt of [stale, "yesterday"]) {
      const result = await save([entry(0)], { expectedUpdatedAt });
      expect(errorsOf(result).formErrors).toEqual([PRODUCT_CHANGED]);
    }
    expect(await storedImages()).toEqual([]);
    expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
  });

  it("saves with the current version", async () => {
    const row = await ProductModel.findById(product).lean();
    const result = await save([entry(0)], {
      expectedUpdatedAt: row?.updatedAt.toISOString(),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses when a variant starts using a removed image between read and write", async () => {
    await store([entry(0), entry(1)]);
    const original = ProductModel.updateOne.bind(ProductModel);
    vi.spyOn(ProductModel, "updateOne").mockImplementationOnce(
      ((...args: Parameters<typeof ProductModel.updateOne>) =>
        ProductModel.collection
          .updateOne(
            { _id: new ObjectId(product) },
            {
              $set: { variants: [{ modelNo: "AR-1", imagePublicId: img(1) }] },
            },
          )
          .then(() => original(...args)) as unknown as ReturnType<
          typeof ProductModel.updateOne
        >) as typeof ProductModel.updateOne,
    );
    const result = await save([entry(0)]);
    expect(errorsOf(result).formErrors).toEqual([PRODUCT_CHANGED]);
    expect((await storedImages()) as unknown[]).toHaveLength(2);
  });

  it.each([
    ["a missing alt", [{ publicId: "", alt: "", kind: "gallery" }]],
    [
      "an order key",
      [{ ...{ publicId: "x", alt: "a", kind: "gallery" }, order: 1 }],
    ],
    ["a non-array", "nope"],
  ])("refuses %s before touching Cloudinary", async (_label, images) => {
    const result = await saveProductImages(ADMIN, {
      productId: product,
      images,
    });
    expect(result.ok).toBe(false);
    expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
  });

  it("refuses an unknown product", async () => {
    const result = await saveProductImages(ADMIN, {
      productId: new ObjectId().toHexString(),
      images: [],
    });
    expect(errorsOf(result).formErrors).toEqual([
      "This product no longer exists. Reload the page.",
    ]);
  });
});
