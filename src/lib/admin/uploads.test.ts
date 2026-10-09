// Tests for the upload services (src/lib/admin/uploads.ts) on an in-memory
// MongoDB: signing only for an existing product or area with a server-chosen
// id, and verifying uploads (owner folder, size, format, delete on reject).

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { isOwnPublicId } from "@/lib/cloudinary-ids";
import { mongoose } from "@/lib/db";
import { AreaModel, CategoryModel, ProductModel } from "@/models";
import { setupMemoryDb } from "../../../test/helpers/memory-db";
import { testPublicId } from "../../../test/helpers/public-ids";

import {
  badFormatMessage,
  IMAGE_REJECTED,
  signCloudinaryUpload,
  verifyUploadedImage,
} from "./uploads";

const cloudinaryMock = vi.hoisted(() => ({
  inspectImage: vi.fn(),
  destroyImage: vi.fn(),
}));
vi.mock("@/lib/cloudinary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cloudinary")>()),
  ...cloudinaryMock,
}));

setupMemoryDb("yg_admin_uploads_test");

const { ObjectId } = mongoose.Types;
const ADMIN = new ObjectId().toHexString();
const SECRET = "Abc_secret-123";

let product: string;
let area: string;
let category: string;

beforeEach(async () => {
  vi.stubEnv(
    "CLOUDINARY_URL",
    `cloudinary://123456789012345:${SECRET}@demo-cloud`,
  );
  cloudinaryMock.inspectImage.mockReset().mockResolvedValue({
    ok: true,
    bytes: 1000,
    format: "png",
    width: 1,
    height: 1,
  });
  cloudinaryMock.destroyImage.mockReset().mockResolvedValue(true);
  await Promise.all([
    ProductModel.deleteMany({}),
    AreaModel.deleteMany({}),
    CategoryModel.deleteMany({}),
  ]);
  const categoryDoc = await CategoryModel.create({
    name: "Spot Lights",
    slug: "spot-lights",
    parent: null,
    order: 0,
  });
  category = categoryDoc._id.toHexString();
  product = (
    await ProductModel.create({
      name: "Arc",
      slug: "arc",
      mainCategory: categoryDoc._id,
    })
  )._id.toHexString();
  area = (
    await AreaModel.create({ name: "Retail", slug: "retail", order: 0 })
  )._id.toHexString();
});

describe("signCloudinaryUpload", () => {
  it.each([
    ["product" as const, () => product],
    ["area" as const, () => area],
    ["category" as const, () => category],
  ])("signs a new id in the %s's own folder", async (target, owner) => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_999);
    const result = await signCloudinaryUpload(ADMIN, {
      target,
      id: owner(),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.tags).toEqual([]);
    const { publicId, fields, uploadUrl } = result.data;
    expect(isOwnPublicId(target, owner(), publicId)).toBe(true);
    expect(uploadUrl).toBe(
      "https://api.cloudinary.com/v1_1/demo-cloud/image/upload",
    );
    expect(fields.timestamp).toBe("1700000000");
    expect(fields.public_id).toBe(publicId);
    // The signature covers exactly the posted fields (api_key excepted).
    const toSign =
      `allowed_formats=${fields.allowed_formats}&overwrite=false` +
      `&public_id=${publicId}&timestamp=${fields.timestamp}`;
    expect(fields.signature).toBe(
      createHash("sha1")
        .update(toSign + SECRET)
        .digest("hex"),
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("picks a fresh id for every upload", async () => {
    const ids = new Set<string>();
    for (let n = 0; n < 3; n += 1) {
      const result = await signCloudinaryUpload(ADMIN, {
        target: "product",
        id: product,
      });
      if (result.ok) ids.add(result.data.publicId);
    }
    expect(ids.size).toBe(3);
  });

  it("refuses an unknown owner, a wrong target and bad input", async () => {
    const missing = new ObjectId().toHexString();
    const gone = await signCloudinaryUpload(ADMIN, {
      target: "product",
      id: missing,
    });
    expect(gone.ok ? null : gone.errors.formErrors).toEqual([
      "This product no longer exists. Reload the page.",
    ]);
    // An area id is not a product, and a category id is not an area (or
    // the other way round): each target is looked up in its own collection.
    expect(
      (await signCloudinaryUpload(ADMIN, { target: "product", id: area })).ok,
    ).toBe(false);
    expect(
      (await signCloudinaryUpload(ADMIN, { target: "area", id: category })).ok,
    ).toBe(false);
    const noCategory = await signCloudinaryUpload(ADMIN, {
      target: "category",
      id: area,
    });
    expect(noCategory.ok ? null : noCategory.errors.formErrors).toEqual([
      "This category no longer exists. Reload the page.",
    ]);
    for (const input of [
      { target: "leader", id: product },
      { target: "product", id: { $ne: null } },
      { target: "product", id: product, publicId: "yg/x" },
      { target: "product", id: product, folder: "evil" },
      null,
    ]) {
      expect((await signCloudinaryUpload(ADMIN, input)).ok).toBe(false);
    }
  });

  it("needs the signed-in admin's id", async () => {
    await expect(
      signCloudinaryUpload("nope", { target: "product", id: product }),
    ).rejects.toThrow(TypeError);
  });
});

describe("verifyUploadedImage", () => {
  it("accepts an upload in the owner's folder that passes the checks", async () => {
    const publicId = testPublicId(0, product);
    await expect(
      verifyUploadedImage({ target: "product", id: product, publicId }),
    ).resolves.toEqual({ ok: true, publicId });
    expect(cloudinaryMock.inspectImage).toHaveBeenCalledWith(publicId);
    expect(cloudinaryMock.destroyImage).not.toHaveBeenCalled();
  });

  it.each(["too_large" as const, "bad_format" as const, "missing" as const])(
    "deletes and refuses an upload that is %s",
    async (reason) => {
      cloudinaryMock.inspectImage.mockResolvedValue({ ok: false, reason });
      const publicId = testPublicId(0, product);
      await expect(
        verifyUploadedImage({ target: "product", id: product, publicId }),
      ).resolves.toEqual({
        ok: false,
        reason,
        message: IMAGE_REJECTED[reason],
      });
      expect(cloudinaryMock.destroyImage).toHaveBeenCalledWith(publicId);
    },
  );

  it("checks a custom format list and names it when the format is wrong", async () => {
    const publicId = testPublicId(0, category, "category");
    const formats = ["png", "svg", "webp"];
    await expect(
      verifyUploadedImage(
        { target: "category", id: category, publicId },
        { formats },
      ),
    ).resolves.toEqual({ ok: true, publicId });
    expect(cloudinaryMock.inspectImage).toHaveBeenCalledWith(publicId, formats);

    cloudinaryMock.inspectImage.mockResolvedValue({
      ok: false,
      reason: "bad_format",
    });
    await expect(
      verifyUploadedImage(
        { target: "category", id: category, publicId },
        { formats },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "bad_format",
      message: badFormatMessage(formats),
    });
    expect(badFormatMessage(formats)).toContain("png, svg, webp");
    expect(cloudinaryMock.destroyImage).toHaveBeenCalledWith(publicId);
  });

  it("does not delete when Cloudinary can't be reached", async () => {
    cloudinaryMock.inspectImage.mockResolvedValue({
      ok: false,
      reason: "unavailable",
    });
    const result = await verifyUploadedImage({
      target: "product",
      id: product,
      publicId: testPublicId(0, product),
    });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(cloudinaryMock.destroyImage).not.toHaveBeenCalled();
  });

  it.each([
    ["another product's id", () => testPublicId(0, area)],
    ["the area folder", () => testPublicId(0, product, "area")],
    ["path traversal", () => `yg/products/${product}/../${area}`],
    ["uppercase", () => testPublicId(0, product).toUpperCase()],
    ["an extra segment", () => `${testPublicId(0, product)}/x`],
  ])(
    "refuses %s without asking Cloudinary or deleting anything",
    async (_label, publicId) => {
      await expect(
        verifyUploadedImage({
          target: "product",
          id: product,
          publicId: publicId(),
        }),
      ).resolves.toEqual({
        ok: false,
        reason: "foreign",
        message: IMAGE_REJECTED.foreign,
      });
      expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
      expect(cloudinaryMock.destroyImage).not.toHaveBeenCalled();
    },
  );
});
