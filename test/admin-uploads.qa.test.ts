// QA gate C (Phase 2, T11-T13): attacks and races against the upload path that
// the feature tests do not make. Covers the R2 and Cloudinary id shapes, the
// Cloudinary signature checked from the service output with an independent
// SHA-1, verification (who may be destroyed), saveProductImages and
// setAreaImage with stolen / foreign ids, the datasheet finalize/replace/delete
// pipeline (key forgery, size lies, error leakage, audit and tags, races), the
// .xlsx checker under corruption, the admin-only CSP from next.config, and
// static rules: no storage key outside the service, no server-only import in
// client code, no secret in the built client bundle.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { v2 as cloudinary } from "cloudinary";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { saveProductImages } from "@/lib/admin/product-images";
import { createArea, setAreaImage, updateArea } from "@/lib/admin/areas";
import {
  deleteDatasheet,
  finalizeDatasheet,
  presignDatasheetUpload,
  renameDatasheet,
} from "@/lib/admin/datasheets";
import {
  getProductForEdit,
  publishProduct,
  updateProduct,
} from "@/lib/admin/products";
import { signCloudinaryUpload, verifyUploadedImage } from "@/lib/admin/uploads";
import {
  buildPublicId,
  isOwnPublicId,
  isPublicId,
  PUBLIC_ID_PATTERN,
} from "@/lib/cloudinary-ids";
import { MAX_DATASHEET_BYTES, MAX_IMAGE_BYTES } from "@/lib/constants";
import { mongoose } from "@/lib/db";
import {
  DATASHEET_KEY_PATTERN,
  INCOMING_KEY_PATTERN,
} from "@/lib/schemas/datasheet";
import { checkXlsx } from "@/lib/xlsx-signature";
import {
  AreaModel,
  CategoryModel,
  DatasheetModel,
  ProductModel,
} from "@/models";
import { AuditLogModel } from "@/models/audit-log";

import { setupMemoryDb } from "./helpers/memory-db";
import { testPublicId, testUuid } from "./helpers/public-ids";

/* A Map-backed bucket; `onDelete` lets a test run a rival call mid-delete. */
const bucket = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array>(),
  calls: [] as string[],
  onDelete: undefined as undefined | ((key: string) => Promise<void>),
}));
vi.mock("@/lib/storage", () => ({
  presignPut: vi.fn(async (o: { key: string; contentType: string }) => {
    bucket.calls.push(`presign:${o.key}`);
    return {
      url: `https://r2.test/${o.key}?sig=1`,
      headers: { "Content-Type": o.contentType },
      expiresIn: 300,
    };
  }),
  headObject: vi.fn(async (key: string) => {
    bucket.calls.push(`head:${key}`);
    const bytes = bucket.objects.get(key);
    return bytes ? { size: bytes.length, contentType: undefined } : null;
  }),
  getObjectBytes: vi.fn(async (key: string) => {
    bucket.calls.push(`get:${key}`);
    return bucket.objects.get(key) ?? null;
  }),
  copyObject: vi.fn(async (from: string, to: string) => {
    bucket.calls.push(`copy:${from}->${to}`);
    const bytes = bucket.objects.get(from);
    if (!bytes) throw new Error("no source");
    bucket.objects.set(to, bytes);
  }),
  deleteObject: vi.fn(async (key: string) => {
    bucket.calls.push(`delete:${key}`);
    bucket.objects.delete(key);
    await bucket.onDelete?.(key);
  }),
}));

setupMemoryDb("yg_admin_uploads_qa_test");

const { ObjectId } = mongoose.Types;
const ADMIN = new ObjectId().toHexString();
const SECRET = "Qa_Gate_C_secret-9876";
const API_KEY = "123456789012345";

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UUID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INCOMING_A = `incoming/${UUID_A}.xlsx`;
const INCOMING_B = `incoming/${UUID_B}.xlsx`;

async function workbook(): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Specs").addRow(["NO.", "Model"]);
  return new Uint8Array(await book.xlsx.writeBuffer());
}

const HTML_BYTES = new TextEncoder().encode(
  "<html><body>not a workbook</body></html>".repeat(4),
);

beforeAll(async () => {
  await Promise.all([
    ProductModel.createIndexes(),
    DatasheetModel.createIndexes(),
  ]);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.stubEnv("CLOUDINARY_URL", `cloudinary://${API_KEY}:${SECRET}@qa-cloud`);
  bucket.objects.clear();
  bucket.calls.length = 0;
  bucket.onDelete = undefined;
  await Promise.all([
    ProductModel.deleteMany({}),
    CategoryModel.deleteMany({}),
    AreaModel.deleteMany({}),
    DatasheetModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
});

/* ------------------------------------------------------------------------ */
/* Key and id shapes                                                         */
/* ------------------------------------------------------------------------ */

describe("R2 key shapes", () => {
  it("accept exactly incoming/<uuid v4>.xlsx and datasheets/<uuid v4>.xlsx", () => {
    expect(INCOMING_KEY_PATTERN.test(INCOMING_A)).toBe(true);
    expect(DATASHEET_KEY_PATTERN.test(`datasheets/${UUID_A}.xlsx`)).toBe(true);
  });

  it.each([
    ["traversal", `incoming/../datasheets/${UUID_A}.xlsx`],
    ["another prefix", `datasheets/${UUID_A}.xlsx`],
    ["a leading slash", `/incoming/${UUID_A}.xlsx`],
    ["a trailing newline", `${INCOMING_A}\n`],
    ["an upper-case uuid", `incoming/${UUID_A.toUpperCase()}.xlsx`],
    ["a uuid v1", `incoming/aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa.xlsx`],
    ["a nested path", `incoming/x/${UUID_A}.xlsx`],
    ["another extension", `incoming/${UUID_A}.xlsm`],
    ["a query string", `${INCOMING_A}?x=1`],
  ])("incoming pattern refuses %s", (_name, key) => {
    expect(INCOMING_KEY_PATTERN.test(key)).toBe(false);
  });

  // The pattern is built in a template literal, where `\.` is just `.`, so the
  // dot before xlsx matches any character (finding L-1). Not exploitable (the
  // key can't leave incoming/), but the shape is looser than documented.
  it.fails("incoming pattern requires a literal dot before xlsx", () => {
    expect(INCOMING_KEY_PATTERN.test(`incoming/${UUID_A}Xxlsx`)).toBe(false);
  });
  it.fails("datasheet pattern requires a literal dot before xlsx", () => {
    expect(DATASHEET_KEY_PATTERN.test(`datasheets/${UUID_A}_xlsx`)).toBe(false);
  });
});

describe("Cloudinary public id shapes", () => {
  const OWNER = "0123456789abcdef01234567";
  const OTHER = "89abcdef0123456789abcdef";
  const good = `yg/products/${OWNER}/${testUuid(1)}`;

  it("accepts the built shape and ties it to its owner", () => {
    expect(isPublicId(good)).toBe(true);
    expect(isOwnPublicId("product", OWNER, good)).toBe(true);
    expect(isOwnPublicId("product", OTHER, good)).toBe(false);
    expect(isOwnPublicId("area", OWNER, good)).toBe(false);
  });

  it.each([
    ["traversal", `yg/products/${OWNER}/../${OTHER}/${testUuid(1)}`],
    ["a trailing newline", `${good}\n`],
    [
      "an upper-case owner",
      `yg/products/${OWNER.toUpperCase()}/${testUuid(1)}`,
    ],
    ["a short owner", `yg/products/0123/${testUuid(1)}`],
    ["a file extension", `${good}.jpg`],
    ["a transformation", `c_scale,w_5/${good}`],
    ["a URL", `https://res.cloudinary.com/x/image/upload/${good}`],
    [
      "a non-ASCII digit",
      `yg/products/${OWNER.replace("0", "٠")}/${testUuid(1)}`,
    ],
    ["a uuid v1", `yg/products/${OWNER}/00000000-0000-1000-8000-000000000001`],
    ["a bare name", "my-image"],
  ])("refuses %s", (_name, id) => {
    expect(PUBLIC_ID_PATTERN.test(id)).toBe(false);
    expect(isOwnPublicId("product", OWNER, id)).toBe(false);
  });

  it("buildPublicId throws instead of building an id the patterns would refuse", () => {
    expect(() => buildPublicId("product", "not-an-id", testUuid(1))).toThrow();
    expect(() => buildPublicId("product", OWNER, "not-a-uuid")).toThrow();
    expect(() =>
      buildPublicId("product", OWNER, UUID_A.toUpperCase()),
    ).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Cloudinary signing and verification                                       */
/* ------------------------------------------------------------------------ */

async function makeProduct(name: string, images: string[] = []) {
  const category =
    (await CategoryModel.findOne({})) ??
    (await CategoryModel.create({
      name: "Spot Lights",
      slug: "spot-lights",
      parent: null,
      order: 0,
    }));
  return ProductModel.create({
    name,
    slug: name.toLowerCase().replace(/\W+/g, "-"),
    mainCategory: category._id,
    status: "draft",
    variants: [{ modelNo: `${name}-1`.toUpperCase().replace(/\W+/g, "-") }],
    images: images.map((publicId, order) => ({
      publicId,
      alt: "a",
      order,
      kind: "gallery",
    })),
  });
}

describe("signCloudinaryUpload", () => {
  it("signs a fresh id in the owner's folder with an independently computed SHA-1", async () => {
    const product = await makeProduct("Signed");
    const id = product._id.toHexString();
    const result = await signCloudinaryUpload(ADMIN, { target: "product", id });
    if (!result.ok) throw new Error("expected ok");
    const { fields, publicId, uploadUrl } = result.data;

    expect(isOwnPublicId("product", id, publicId)).toBe(true);
    expect(uploadUrl).toBe(
      "https://api.cloudinary.com/v1_1/qa-cloud/image/upload",
    );
    expect(Object.keys(fields).sort()).toEqual(
      [
        "allowed_formats",
        "api_key",
        "overwrite",
        "public_id",
        "signature",
        "timestamp",
      ].sort(),
    );
    expect(fields.overwrite).toBe("false");
    expect(fields.allowed_formats).toBe("jpg,png,webp,avif");
    expect(fields.public_id).toBe(publicId);
    expect(Math.abs(Number(fields.timestamp) - Date.now() / 1000)).toBeLessThan(
      10,
    );

    // Cloudinary's rule, written out here and not read from the code: sort
    // every signed param, join name=value with &, append the secret, SHA-1.
    const toSign = Object.entries(fields)
      .filter(([name]) => name !== "api_key" && name !== "signature")
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    expect(fields.signature).toBe(
      createHash("sha1")
        .update(toSign + SECRET)
        .digest("hex"),
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.tags).toEqual([]);
  });

  it("never reuses an id, and writes nothing", async () => {
    const product = await makeProduct("Twice");
    const id = product._id.toHexString();
    const a = await signCloudinaryUpload(ADMIN, { target: "product", id });
    const b = await signCloudinaryUpload(ADMIN, { target: "product", id });
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.data.publicId).not.toBe(b.data.publicId);
    expect(await AuditLogModel.countDocuments()).toBe(0);
    expect((await ProductModel.findById(id))?.images).toHaveLength(0);
  });

  it("refuses a missing owner, a foreign target, extra keys and operator ids without signing", async () => {
    const sign = vi.spyOn(cloudinary.utils, "api_sign_request");
    const ghost = new ObjectId().toHexString();
    const cases: unknown[] = [
      { target: "product", id: ghost },
      { target: "area", id: ghost },
      { target: "datasheet", id: ghost },
      { target: "product", id: { $ne: null } },
      { target: "product", id: "../../etc" },
      { target: "product", id: ghost, publicId: "yg/products/x/y" },
      { target: "product" },
      null,
      "product",
    ];
    for (const input of cases) {
      const result = await signCloudinaryUpload(ADMIN, input);
      expect(result.ok).toBe(false);
      expect(result.tags).toEqual([]);
    }
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses an empty actor id (no unauthenticated service call)", async () => {
    await expect(
      signCloudinaryUpload("", { target: "product", id: "a".repeat(24) }),
    ).rejects.toThrow();
  });
});

describe("verifyUploadedImage: what is deleted, and what never is", () => {
  const OWNER = new ObjectId().toHexString();
  const own = `yg/products/${OWNER}/${testUuid(7)}`;

  function stubCloudinary(resource: unknown) {
    const lookup = vi.spyOn(cloudinary.api, "resource");
    if (resource instanceof Error) lookup.mockRejectedValue(resource);
    else lookup.mockResolvedValue(resource as never);
    const destroy = vi
      .spyOn(cloudinary.uploader, "destroy")
      .mockResolvedValue({ result: "ok" } as never);
    return { lookup, destroy };
  }

  it("accepts an image of exactly the size limit and refuses one byte more (and deletes it)", async () => {
    const ok = stubCloudinary({
      resource_type: "image",
      format: "JPG",
      bytes: MAX_IMAGE_BYTES,
    });
    expect(
      await verifyUploadedImage({
        target: "product",
        id: OWNER,
        publicId: own,
      }),
    ).toMatchObject({ ok: true });
    expect(ok.destroy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    const big = stubCloudinary({
      resource_type: "image",
      format: "jpg",
      bytes: MAX_IMAGE_BYTES + 1,
    });
    expect(
      await verifyUploadedImage({
        target: "product",
        id: OWNER,
        publicId: own,
      }),
    ).toMatchObject({ ok: false, reason: "too_large" });
    expect(big.destroy).toHaveBeenCalledWith(
      own,
      expect.objectContaining({ invalidate: true }),
    );
  });

  it.each(["svg", "pdf", "gif", "bmp", "tiff", "heic", "mp4"])(
    "refuses and deletes a stored %s",
    async (format) => {
      const { destroy } = stubCloudinary({
        resource_type: "image",
        format,
        bytes: 1000,
      });
      const result = await verifyUploadedImage({
        target: "product",
        id: OWNER,
        publicId: own,
      });
      expect(result).toMatchObject({ ok: false, reason: "bad_format" });
      expect(destroy).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses a non-image resource type and zero or non-numeric sizes", async () => {
    for (const body of [
      { resource_type: "video", format: "jpg", bytes: 10 },
      { resource_type: "image", format: "jpg", bytes: 0 },
      { resource_type: "image", format: "jpg", bytes: "10" },
      { resource_type: "image", format: "jpg", bytes: Number.NaN },
      {},
    ]) {
      vi.restoreAllMocks();
      stubCloudinary(body);
      const result = await verifyUploadedImage({
        target: "product",
        id: OWNER,
        publicId: own,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("never deletes an id outside the owner's folder, and never asks Cloudinary about it", async () => {
    const { lookup, destroy } = stubCloudinary({
      resource_type: "image",
      format: "jpg",
      bytes: 10,
    });
    const other = new ObjectId().toHexString();
    for (const publicId of [
      `yg/products/${other}/${testUuid(1)}`, // another product's live image
      `yg/areas/${OWNER}/${testUuid(1)}`, // the area folder of the same id
      "yg/products/..%2f/x",
      "",
    ]) {
      const result = await verifyUploadedImage({
        target: "product",
        id: OWNER,
        publicId,
      });
      expect(result).toMatchObject({ ok: false, reason: "foreign" });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("deletes nothing and leaks nothing when Cloudinary cannot be reached", async () => {
    const error = Object.assign(
      new Error(`boom ${SECRET} api_key=${API_KEY}`),
      {
        http_code: 500,
      },
    );
    const { destroy } = stubCloudinary(error);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await verifyUploadedImage({
      target: "product",
      id: OWNER,
      publicId: own,
    });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(destroy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(API_KEY);
  });

  it("treats a 404 as missing and does not try to delete it", async () => {
    const { destroy } = stubCloudinary(
      Object.assign(new Error("nf"), { error: { http_code: 404 } }),
    );
    expect(
      await verifyUploadedImage({
        target: "product",
        id: OWNER,
        publicId: own,
      }),
    ).toMatchObject({ ok: false, reason: "missing" });
    // A missing id may be destroyed harmlessly ("not found"); the point is it
    // does not throw and does not claim success.
    expect(destroy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------------ */
/* saveProductImages and setAreaImage with hostile ids                       */
/* ------------------------------------------------------------------------ */

describe("saveProductImages", () => {
  const okImage = { resource_type: "image", format: "jpg", bytes: 1000 };

  it("refuses another product's image and an area-folder id without calling Cloudinary", async () => {
    const victim = await makeProduct("Victim");
    const victimId = victim._id.toHexString();
    const stolen = testPublicId(1, victimId);
    await ProductModel.updateOne(
      { _id: victim._id },
      {
        $set: {
          images: [{ publicId: stolen, alt: "v", order: 0, kind: "gallery" }],
        },
      },
    );
    const mine = await makeProduct("Mine");
    const mineId = mine._id.toHexString();
    const lookup = vi
      .spyOn(cloudinary.api, "resource")
      .mockResolvedValue(okImage as never);
    const destroy = vi
      .spyOn(cloudinary.uploader, "destroy")
      .mockResolvedValue({ result: "ok" } as never);

    for (const publicId of [
      stolen,
      testPublicId(2, mineId, "area"),
      testPublicId(3, new ObjectId().toHexString()),
    ]) {
      const result = await saveProductImages(ADMIN, {
        productId: mineId,
        images: [{ publicId, alt: "x", kind: "gallery" }],
      });
      expect(result).toMatchObject({ ok: false, tags: [] });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect((await ProductModel.findById(mineId))?.images).toHaveLength(0);
    expect(await AuditLogModel.countDocuments()).toBe(0);
    expect((await ProductModel.findById(victimId))?.images).toHaveLength(1);
  });

  it("with one good and one oversize new upload: saves nothing, deletes only the bad one, audits nothing", async () => {
    const product = await makeProduct("Pair");
    const id = product._id.toHexString();
    const good = testPublicId(1, id);
    const bad = testPublicId(2, id);
    vi.spyOn(cloudinary.api, "resource").mockImplementation((async (
      publicId: string,
    ) =>
      publicId === bad
        ? { ...okImage, bytes: MAX_IMAGE_BYTES + 1 }
        : okImage) as never);
    const destroy = vi
      .spyOn(cloudinary.uploader, "destroy")
      .mockResolvedValue({ result: "ok" } as never);

    const result = await saveProductImages(ADMIN, {
      productId: id,
      images: [
        { publicId: good, alt: "ok", kind: "gallery" },
        { publicId: bad, alt: "big", kind: "gallery" },
      ],
    });
    expect(result).toMatchObject({ ok: false, tags: [] });
    expect(JSON.stringify(result)).toContain("images.1.publicId");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy.mock.calls[0]?.[0]).toBe(bad);
    expect((await ProductModel.findById(id))?.images).toHaveLength(0);
    expect(await AuditLogModel.countDocuments()).toBe(0);
  });

  it("on success audits counts only (no ids, no alt text) and returns the product tags", async () => {
    const product = await makeProduct("Audited");
    const id = product._id.toHexString();
    const added = testPublicId(1, id);
    vi.spyOn(cloudinary.api, "resource").mockResolvedValue(okImage as never);
    const result = await saveProductImages(ADMIN, {
      productId: id,
      images: [{ publicId: added, alt: "SECRET-ALT-TEXT", kind: "gallery" }],
    });
    expect(result.ok).toBe(true);
    expect(result.tags).toContain("products");
    const entries = await AuditLogModel.find({}).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "product.images.update" });
    const dump = JSON.stringify(entries);
    expect(dump).not.toContain("SECRET-ALT-TEXT");
    expect(dump).not.toContain(added);
  });

  it("does not leak a Cloudinary failure message to the admin", async () => {
    const product = await makeProduct("Outage");
    const id = product._id.toHexString();
    vi.spyOn(cloudinary.api, "resource").mockRejectedValue(
      Object.assign(new Error(`down ${SECRET}`), { http_code: 503 }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const destroy = vi.spyOn(cloudinary.uploader, "destroy");
    const result = await saveProductImages(ADMIN, {
      productId: id,
      images: [{ publicId: testPublicId(1, id), alt: "x", kind: "gallery" }],
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("refuses a duplicate id, more than 30 images and operator input before any Cloudinary call", async () => {
    const product = await makeProduct("Limits");
    const id = product._id.toHexString();
    const lookup = vi
      .spyOn(cloudinary.api, "resource")
      .mockResolvedValue(okImage as never);
    const one = { publicId: testPublicId(1, id), alt: "x", kind: "gallery" };
    const many = Array.from({ length: 31 }, (_, n) => ({
      publicId: testPublicId(n + 10, id),
      alt: "x",
      kind: "gallery",
    }));
    for (const images of [
      [one, one],
      many,
      [{ ...one, publicId: { $ne: null } }],
      [{ ...one, extra: true }],
    ]) {
      const result = await saveProductImages(ADMIN, { productId: id, images });
      expect(result.ok).toBe(false);
    }
    expect(
      (await saveProductImages(ADMIN, { productId: { $ne: null }, images: [] }))
        .ok,
    ).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("mass assignment through the product form", () => {
  it("updateProduct cannot set images, and refuses a datasheet that does not exist or an operator", async () => {
    const stored = testPublicId(0, new ObjectId().toHexString());
    const product = await makeProduct("Mass", [stored]);
    const id = product._id.toHexString();
    const loaded = await getProductForEdit(id);
    if (!loaded) throw new Error("fixture");
    const base = loaded.values as Record<string, unknown>;

    const forged = await updateProduct(ADMIN, id, {
      ...base,
      images: [
        { publicId: testPublicId(5), alt: "x", order: 0, kind: "gallery" },
      ],
    });
    expect(forged.ok).toBe(false);

    const ghost = await updateProduct(ADMIN, id, {
      ...base,
      datasheetId: new ObjectId().toHexString(),
    });
    expect(ghost).toMatchObject({ ok: false });
    expect(JSON.stringify(ghost)).toContain("datasheetId");

    const operator = await updateProduct(ADMIN, id, {
      ...base,
      datasheetId: { $ne: null },
    });
    expect(operator.ok).toBe(false);

    const after = await ProductModel.findById(id).lean();
    expect(after?.images.map((i) => i.publicId)).toEqual([stored]);
    expect(after?.datasheetId ?? null).toBeNull();
  });
});

describe("area image", () => {
  const okImage = { resource_type: "image", format: "png", bytes: 500 };

  it("createArea and updateArea cannot set an image; setAreaImage refuses foreign ids and never deletes them", async () => {
    const lookup = vi
      .spyOn(cloudinary.api, "resource")
      .mockResolvedValue(okImage as never);
    const destroy = vi
      .spyOn(cloudinary.uploader, "destroy")
      .mockResolvedValue({ result: "ok" } as never);
    const other = await AreaModel.create({
      name: "Other",
      slug: "other",
      order: 1,
    });
    const area = await AreaModel.create({
      name: "Mine",
      slug: "mine",
      order: 0,
    });
    const areaId = area._id.toHexString();

    const created = await createArea(ADMIN, {
      name: "Sneaky",
      slug: "",
      bwImage: testPublicId(1, areaId, "area"),
    });
    expect(created.ok).toBe(false);
    expect(await AreaModel.countDocuments()).toBe(2);

    const viaUpdate = await updateArea(ADMIN, areaId, {
      name: "Mine",
      slug: "mine",
      bwImage: testPublicId(2, areaId, "area"),
    });
    expect(viaUpdate.ok).toBe(false);

    for (const publicId of [
      testPublicId(3, other._id.toHexString(), "area"),
      testPublicId(4, areaId, "product"),
    ]) {
      const result = await setAreaImage(ADMIN, { areaId, publicId });
      expect(result).toMatchObject({ ok: false, tags: [] });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect((await AreaModel.findById(areaId).lean())?.bwImage).toBeUndefined();
  });

  it("sets a verified image, clears it, and leaves the replaced image in Cloudinary", async () => {
    vi.spyOn(cloudinary.api, "resource").mockResolvedValue(okImage as never);
    const destroy = vi
      .spyOn(cloudinary.uploader, "destroy")
      .mockResolvedValue({ result: "ok" } as never);
    const area = await AreaModel.create({
      name: "Mine",
      slug: "mine",
      order: 0,
    });
    const areaId = area._id.toHexString();
    const first = testPublicId(1, areaId, "area");
    const second = testPublicId(2, areaId, "area");

    expect((await setAreaImage(ADMIN, { areaId, publicId: first })).ok).toBe(
      true,
    );
    expect((await setAreaImage(ADMIN, { areaId, publicId: second })).ok).toBe(
      true,
    );
    expect((await AreaModel.findById(areaId).lean())?.bwImage).toBe(second);
    expect((await setAreaImage(ADMIN, { areaId, publicId: null })).ok).toBe(
      true,
    );
    expect((await AreaModel.findById(areaId).lean())?.bwImage).toBeUndefined();
    expect(destroy).not.toHaveBeenCalled();
    expect(await AuditLogModel.countDocuments({ action: "area.update" })).toBe(
      3,
    );
    const meta = JSON.stringify(
      (await AuditLogModel.find({}).lean()).map((e) => e.meta),
    );
    expect(meta).not.toContain(first);
    expect(meta).not.toContain(second);
  });
});

/* ------------------------------------------------------------------------ */
/* Datasheet pipeline                                                        */
/* ------------------------------------------------------------------------ */

function logged() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("presign", () => {
  it("only ever signs an incoming/ key, a fresh one per call, and refuses bad input without touching R2", async () => {
    const keys = new Set<string>();
    for (let n = 0; n < 5; n++) {
      const result = await presignDatasheetUpload(ADMIN, {
        fileName: "a.xlsx",
        size: 10,
      });
      if (!result.ok) throw new Error("expected ok");
      expect(INCOMING_KEY_PATTERN.test(result.data.incomingKey)).toBe(true);
      expect(result.tags).toEqual([]);
      keys.add(result.data.incomingKey);
    }
    expect(keys.size).toBe(5);
    bucket.calls.length = 0;
    const bad: unknown[] = [
      { fileName: "a.xlsx", size: MAX_DATASHEET_BYTES + 1 },
      { fileName: "a.xlsx", size: 0 },
      { fileName: "a.xlsx", size: -1 },
      { fileName: "a.xlsx", size: 1.5 },
      { fileName: "a.xlsx", size: "10" },
      { fileName: "a.xlsx", size: Number.NaN },
      { fileName: "a.xlsx", size: Infinity },
      { fileName: "a.xls", size: 10 },
      { fileName: ".xlsx", size: 10 },
      { fileName: "../a.xlsx", size: 10 },
      { fileName: "a\r\nSet-Cookie: x.xlsx", size: 10 },
      { fileName: "x".repeat(300) + ".xlsx", size: 10 },
      { fileName: "a.xlsx", size: 10, key: "datasheets/x.xlsx" },
      { fileName: { $ne: null }, size: 10 },
      {},
      null,
    ];
    for (const input of bad) {
      expect((await presignDatasheetUpload(ADMIN, input)).ok).toBe(false);
    }
    expect(bucket.calls).toEqual([]);
  });
});

describe("finalize: forged keys and size lies", () => {
  it("never reads, copies or deletes an object outside incoming/", async () => {
    bucket.objects.set(`datasheets/${UUID_C}.xlsx`, await workbook());
    const forged = [
      `datasheets/${UUID_C}.xlsx`,
      `incoming/../datasheets/${UUID_C}.xlsx`,
      `incoming/${UUID_A}.xlsx/../../datasheets/${UUID_C}.xlsx`,
      `/incoming/${UUID_A}.xlsx`,
      `${INCOMING_A}\n`,
    ];
    for (const incomingKey of forged) {
      const result = await finalizeDatasheet(ADMIN, {
        mode: "new",
        incomingKey,
        fileName: "a.xlsx",
      });
      expect(result.ok).toBe(false);
    }
    expect(bucket.calls).toEqual([]);
    expect(bucket.objects.has(`datasheets/${UUID_C}.xlsx`)).toBe(true);
    expect(await DatasheetModel.countDocuments()).toBe(0);
  });

  it("a replace aimed at a missing or malformed datasheet id deletes the upload and writes nothing", async () => {
    bucket.objects.set(INCOMING_A, await workbook());
    const ghost = await finalizeDatasheet(ADMIN, {
      mode: "replace",
      datasheetId: new ObjectId().toHexString(),
      incomingKey: INCOMING_A,
      fileName: "a.xlsx",
    });
    expect(ghost.ok).toBe(false);
    expect(bucket.objects.has(INCOMING_A)).toBe(false);
    expect(bucket.calls.some((c) => c.startsWith("copy:"))).toBe(false);

    bucket.objects.set(INCOMING_B, await workbook());
    const operator = await finalizeDatasheet(ADMIN, {
      mode: "replace",
      datasheetId: { $ne: null },
      incomingKey: INCOMING_B,
      fileName: "a.xlsx",
    });
    expect(operator.ok).toBe(false);
    // A well-formed key in an invalid body is still cleaned up.
    expect(bucket.objects.has(INCOMING_B)).toBe(false);
  });

  it("does not read the body when HEAD already shows more than 10 MB, and cleans up", async () => {
    bucket.objects.set(INCOMING_A, new Uint8Array(MAX_DATASHEET_BYTES + 1));
    const result = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_A,
      fileName: "big.xlsx",
    });
    expect(result.ok).toBe(false);
    expect(bucket.calls.some((c) => c.startsWith("get:"))).toBe(false);
    expect(bucket.objects.has(INCOMING_A)).toBe(false);
    expect(await DatasheetModel.countDocuments()).toBe(0);
  });

  it("refuses an object that grew after HEAD (a body larger than the limit) and cleans up", async () => {
    const real = await workbook();
    bucket.objects.set(INCOMING_A, real);
    const storage = await import("@/lib/storage");
    vi.mocked(storage.getObjectBytes).mockResolvedValueOnce(
      new Uint8Array(MAX_DATASHEET_BYTES + 1).fill(0x50),
    );
    const result = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_A,
      fileName: "grew.xlsx",
    });
    expect(result.ok).toBe(false);
    expect(bucket.calls.some((c) => c.startsWith("copy:"))).toBe(false);
    expect(bucket.objects.has(INCOMING_A)).toBe(false);
  });

  it.each([
    ["HTML renamed .xlsx", HTML_BYTES],
    [
      "a zip without workbook parts",
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
    ],
  ])(
    "%s is refused: nothing copied, nothing stored, upload removed",
    async (_n, bytes) => {
      bucket.objects.set(INCOMING_A, bytes);
      const result = await finalizeDatasheet(ADMIN, {
        mode: "new",
        incomingKey: INCOMING_A,
        fileName: "fake.xlsx",
      });
      expect(result.ok).toBe(false);
      expect(bucket.calls.some((c) => c.startsWith("copy:"))).toBe(false);
      expect(bucket.objects.has(INCOMING_A)).toBe(false);
      expect(
        [...bucket.objects.keys()].filter((k) => k.startsWith("datasheets/")),
      ).toEqual([]);
      expect(await DatasheetModel.countDocuments()).toBe(0);
      expect(await AuditLogModel.countDocuments()).toBe(0);
    },
  );

  it("a refused replace leaves the stored bytes and the row untouched", async () => {
    const key = `datasheets/${UUID_C}.xlsx`;
    const original = await workbook();
    bucket.objects.set(key, original);
    const row = await DatasheetModel.create({
      storageKey: key,
      fileName: "keep.xlsx",
      size: original.length,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      uploadedBy: new ObjectId(),
    });
    bucket.objects.set(INCOMING_A, HTML_BYTES);
    const result = await finalizeDatasheet(ADMIN, {
      mode: "replace",
      datasheetId: row._id.toHexString(),
      incomingKey: INCOMING_A,
      fileName: "evil.xlsx",
    });
    expect(result.ok).toBe(false);
    expect(bucket.objects.get(key)).toBe(original);
    expect((await DatasheetModel.findById(row._id))?.fileName).toBe(
      "keep.xlsx",
    );
    expect(bucket.objects.has(INCOMING_A)).toBe(false);
  });
});

describe("datasheet writes: audit, tags, no names, no leaks", () => {
  const NAME = "Confidential-Customer-Q4.xlsx";

  it("every write audits once, returns only the datasheets tag, and keeps names and keys out of the audit entry", async () => {
    bucket.objects.set(INCOMING_A, await workbook());
    const created = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_A,
      fileName: NAME,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.errors));
    const id = created.data.id;
    expect(created.tags).toEqual(["datasheets"]);

    bucket.objects.set(INCOMING_B, await workbook());
    const replaced = await finalizeDatasheet(ADMIN, {
      mode: "replace",
      datasheetId: id,
      incomingKey: INCOMING_B,
      fileName: "Replacement-Name.xlsx",
    });
    expect(replaced.ok).toBe(true);
    expect(replaced.tags).toEqual(["datasheets"]);

    const renamed = await renameDatasheet(ADMIN, {
      id,
      fileName: "Renamed-Name.xlsx",
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.tags).toEqual(["datasheets"]);

    const removed = await deleteDatasheet(ADMIN, id);
    expect(removed.ok).toBe(true);
    expect(removed.tags).toEqual(["datasheets"]);

    const entries = await AuditLogModel.find({}).sort({ _id: 1 }).lean();
    expect(entries.map((e) => e.action)).toEqual([
      "datasheet.upload",
      "datasheet.replace",
      "datasheet.rename",
      "datasheet.delete",
    ]);
    for (const entry of entries) {
      expect(String(entry.actor)).toBe(ADMIN);
      expect(entry.target).toEqual({ type: "datasheet", id });
    }
    const dump = JSON.stringify(entries);
    for (const forbidden of [
      NAME,
      "Replacement-Name",
      "Renamed-Name",
      "datasheets/",
      "incoming/",
      ".xlsx",
    ]) {
      expect(dump).not.toContain(forbidden);
    }
  });

  it("an R2 failure shows the admin a generic message and logs only the error class", async () => {
    const storage = await import("@/lib/storage");
    const secretError = new Error(
      "AccessDenied for key AKIAQAGATEC bucket yg-private-secret endpoint https://acct.r2.cloudflarestorage.com/yg-private-secret/datasheets/x",
    );
    const log = logged();

    bucket.objects.set(INCOMING_A, await workbook());
    vi.mocked(storage.copyObject).mockRejectedValueOnce(secretError);
    const finalized = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_A,
      fileName: "a.xlsx",
    });
    expect(finalized.ok).toBe(false);

    vi.mocked(storage.headObject).mockRejectedValueOnce(secretError);
    bucket.objects.set(INCOMING_B, await workbook());
    const headFail = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_B,
      fileName: "b.xlsx",
    });
    expect(headFail.ok).toBe(false);

    const row = await DatasheetModel.create({
      storageKey: `datasheets/${UUID_C}.xlsx`,
      fileName: "c.xlsx",
      size: 5,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      uploadedBy: new ObjectId(),
    });
    vi.mocked(storage.deleteObject).mockRejectedValueOnce(secretError);
    const delFail = await deleteDatasheet(ADMIN, row._id.toHexString());
    expect(delFail.ok).toBe(false);
    // R2 failed, so the row must still exist to retry.
    expect(await DatasheetModel.countDocuments({ _id: row._id })).toBe(1);

    for (const surface of [
      JSON.stringify([finalized, headFail, delFail]),
      JSON.stringify(log.mock.calls),
    ]) {
      for (const leak of [
        "AKIA",
        "yg-private-secret",
        "cloudflarestorage",
        "AccessDenied for key",
      ]) {
        expect(surface).not.toContain(leak);
      }
    }
  });

  it("refuses ids that are not plain ObjectIds in rename and delete (operator injection)", async () => {
    await DatasheetModel.create({
      storageKey: `datasheets/${UUID_C}.xlsx`,
      fileName: "c.xlsx",
      size: 5,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      uploadedBy: new ObjectId(),
    });
    bucket.objects.set(`datasheets/${UUID_C}.xlsx`, await workbook());
    for (const id of [
      { $ne: null },
      { $gt: "" },
      ["a"],
      null,
      undefined,
      "",
      "*",
    ]) {
      expect((await deleteDatasheet(ADMIN, id)).ok).toBe(false);
      expect(
        (await renameDatasheet(ADMIN, { id, fileName: "x.xlsx" })).ok,
      ).toBe(false);
    }
    expect(await DatasheetModel.countDocuments()).toBe(1);
    expect(bucket.objects.has(`datasheets/${UUID_C}.xlsx`)).toBe(true);
  });

  it("delete is refused while a product uses the file: file kept, row kept, count in the message", async () => {
    const key = `datasheets/${UUID_C}.xlsx`;
    bucket.objects.set(key, await workbook());
    const row = await DatasheetModel.create({
      storageKey: key,
      fileName: "used.xlsx",
      size: 5,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      uploadedBy: new ObjectId(),
    });
    for (const name of ["One", "Two"]) {
      const product = await makeProduct(name);
      await ProductModel.updateOne(
        { _id: product._id },
        { $set: { datasheetId: row._id } },
      );
    }
    const result = await deleteDatasheet(ADMIN, row._id.toHexString());
    expect(result).toMatchObject({ ok: false, tags: [] });
    expect(JSON.stringify(result)).toContain("2 products");
    expect(bucket.objects.has(key)).toBe(true);
    expect(await DatasheetModel.countDocuments()).toBe(1);
    expect(await AuditLogModel.countDocuments()).toBe(0);
  });
});

describe("datasheet races (gate C)", () => {
  async function seededSheet() {
    const key = `datasheets/${UUID_C}.xlsx`;
    bucket.objects.set(key, await workbook());
    const row = await DatasheetModel.create({
      storageKey: key,
      fileName: "race.xlsx",
      size: 5,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      uploadedBy: new ObjectId(),
    });
    return { key, id: row._id.toHexString() };
  }

  // Finding L-2: a replace that runs while a delete is between "delete the R2
  // object" and "delete the row" recreates the object (copy), matches the
  // still-present row, and succeeds; the delete then removes the row. The
  // private file is left in R2 with no row (an orphan that only the T17 report
  // finds). This `it.fails` becomes a plain `it` once the delete re-checks.
  it.fails(
    "delete racing a replace leaves no orphaned object in R2",
    async () => {
      const { key, id } = await seededSheet();
      bucket.onDelete = async (deletedKey) => {
        if (deletedKey !== key) return;
        bucket.onDelete = undefined;
        bucket.objects.set(INCOMING_A, await workbook());
        await finalizeDatasheet(ADMIN, {
          mode: "replace",
          datasheetId: id,
          incomingKey: INCOMING_A,
          fileName: "race2.xlsx",
        });
      };
      await deleteDatasheet(ADMIN, id);
      const rowGone = (await DatasheetModel.countDocuments({ _id: id })) === 0;
      const objectLeft = bucket.objects.has(key);
      expect(rowGone && objectLeft).toBe(false);
    },
  );

  // Finding L-3: a product that attaches the datasheet after the in-use count
  // but before the row delete keeps a dangling datasheetId. The service accepts
  // this window (ADR 0047 point 6); the publish re-check (gate B I-2) must
  // then still refuse to publish it.
  it("a product attached mid-delete dangles, and publish refuses it", async () => {
    const { key, id } = await seededSheet();
    const product = await makeProduct("Attach", [
      testPublicId(0, new ObjectId().toHexString()),
    ]);
    bucket.onDelete = async (deletedKey) => {
      if (deletedKey !== key) return;
      await ProductModel.updateOne(
        { _id: product._id },
        { $set: { datasheetId: new ObjectId(id) } },
      );
    };
    expect((await deleteDatasheet(ADMIN, id)).ok).toBe(true);
    const dangling = await ProductModel.findById(product._id).lean();
    expect(dangling?.datasheetId?.toHexString()).toBe(id);
    expect(await DatasheetModel.countDocuments()).toBe(0);

    const publish = await publishProduct(ADMIN, product._id.toHexString());
    expect(publish.ok).toBe(false);
    expect(JSON.stringify(publish)).toContain("datasheetId");
    expect((await ProductModel.findById(product._id))?.status).toBe("draft");
  });
});

/* ------------------------------------------------------------------------ */
/* The .xlsx checker under corruption                                        */
/* ------------------------------------------------------------------------ */

describe("checkXlsx robustness", () => {
  /* A tiny deterministic PRNG so a failure can be reproduced. */
  function prng(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  it("never throws and never accepts a damaged copy of a real workbook it cannot read", async () => {
    const real = await workbook();
    expect(await checkXlsx(real)).toEqual({ ok: true });
    const random = prng(20261007);
    for (let n = 0; n < 300; n++) {
      const copy = real.slice();
      const flips = 1 + Math.floor(random() * 6);
      for (let f = 0; f < flips; f++) {
        copy[Math.floor(random() * copy.length)] = Math.floor(random() * 256);
      }
      const cut =
        random() < 0.4
          ? copy.subarray(0, Math.floor(random() * copy.length))
          : copy;
      const verdict = await checkXlsx(cut);
      expect(typeof verdict.ok).toBe("boolean");
    }
  });

  it("a header that lies about the size of [Content_Types].xml is stopped by the inflate cap", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "A".repeat(20 * 1024 * 1024));
    zip.file("xl/workbook.xml", "<w/>");
    const bytes = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    });
    expect(bytes.length).toBeLessThan(MAX_DATASHEET_BYTES);
    // Patch every central header's uncompressed size down to 100.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < bytes.length - 46; i++) {
      if (view.getUint32(i, true) === 0x02014b50)
        view.setUint32(i + 24, 100, true);
    }
    const started = Date.now();
    const verdict = await checkXlsx(bytes);
    expect(verdict.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("an honest oversize [Content_Types].xml is refused without inflating", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "A".repeat(5 * 1024 * 1024));
    zip.file("xl/workbook.xml", "<w/>");
    const bytes = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    });
    expect((await checkXlsx(bytes)).ok).toBe(false);
  });

  it("a zip64 end record is refused, not followed", async () => {
    const real = await workbook();
    const copy = real.slice();
    const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    for (let i = copy.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        view.setUint16(i + 10, 0xffff, true);
        break;
      }
    }
    expect(await checkXlsx(copy)).toEqual({
      ok: false,
      reason: "too_many_entries",
    });
  });

  it("a macro workbook, an .xlsx-named docx and an encrypted Content_Types are refused", async () => {
    const macro = new JSZip();
    macro.file(
      "[Content_Types].xml",
      '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
    );
    macro.file("xl/workbook.xml", "<w/>");
    macro.file("xl/vbaProject.bin", "x");
    expect(
      (await checkXlsx(await macro.generateAsync({ type: "uint8array" }))).ok,
    ).toBe(false);

    const docx = new JSZip();
    docx.file(
      "[Content_Types].xml",
      '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    docx.file("word/document.xml", "<d/>");
    expect(
      (await checkXlsx(await docx.generateAsync({ type: "uint8array" }))).ok,
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Admin-only CSP                                                            */
/* ------------------------------------------------------------------------ */

describe("CSP from next.config", () => {
  const ACCOUNT = "0123456789abcdef0123456789abcdef";

  async function rules() {
    vi.stubEnv("R2_ACCOUNT_ID", ACCOUNT);
    const config = (await import("../next.config")).default;
    const list = await config.headers!();
    const csp = (source: string) =>
      list
        .find((rule) => rule.source === source)
        ?.headers.find((h) => h.key === "Content-Security-Policy")?.value;
    return { list, publicCsp: csp("/:path*"), adminCsp: csp("/admin/:path*") };
  }

  it("direct-upload hosts are in /admin's connect-src only", async () => {
    const { list, publicCsp, adminCsp } = await rules();
    expect(publicCsp).toBeDefined();
    expect(adminCsp).toBeDefined();
    for (const host of ["api.cloudinary.com", "r2.cloudflarestorage.com"]) {
      expect(publicCsp).not.toContain(host);
      expect(adminCsp).toContain(host);
    }
    expect(adminCsp).toContain(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
    // No other rule (whistleblower, etc.) carries those hosts.
    for (const rule of list) {
      if (rule.source === "/admin/:path*") continue;
      for (const header of rule.headers) {
        expect(header.value).not.toContain("cloudinary.com/v1_1");
        expect(header.value).not.toContain("r2.cloudflarestorage.com");
      }
    }
  });

  it("the admin CSP differs from the public one in connect-src only, and has no wildcard", async () => {
    const { publicCsp, adminCsp } = await rules();
    const strip = (csp: string) =>
      csp
        .split("; ")
        .filter((d) => !d.startsWith("connect-src"))
        .join("; ");
    expect(strip(adminCsp!)).toBe(strip(publicCsp!));
    const connect = adminCsp!
      .split("; ")
      .find((d) => d.startsWith("connect-src"))!;
    expect(connect).not.toMatch(/\*|https:\s|http:\s|data:|blob:/);
    expect(adminCsp).toContain("frame-ancestors 'none'");
    expect(adminCsp).toContain("object-src 'none'");
    expect(adminCsp).not.toContain("'unsafe-eval'");
  });

  it("a malformed R2_ACCOUNT_ID fails the build instead of emitting a host", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "evil.example.com/x");
    const config = (await import("../next.config")).default;
    const error = await Promise.resolve(config.headers!()).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/R2_ACCOUNT_ID is invalid/);
    expect(error?.message).not.toContain("evil.example");
  });
});

/* ------------------------------------------------------------------------ */
/* Static rules                                                              */
/* ------------------------------------------------------------------------ */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string, match: RegExp): string[] {
  return readdirSync(path.join(root, dir), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && match.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}
const notTest = (file: string) => !/\.test\.tsx?$/.test(file);

describe("static rules", () => {
  it("no page, action or component reads or names a storage key", () => {
    const offenders = [
      ...sourceFiles("src/app", /\.tsx?$/),
      ...sourceFiles("src/components", /\.tsx?$/),
    ]
      .filter(notTest)
      .filter((file) =>
        /storageKey|STORAGE_KEY/.test(readFileSync(file, "utf8")),
      )
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });

  it("no src file other than the datasheet service and model projects storageKey into a result", () => {
    const allowed = new Set([
      "src/lib/admin/datasheets.ts",
      "src/models/datasheet.ts",
      "src/models/whistleblower-case.ts",
    ]);
    const offenders = sourceFiles("src", /\.tsx?$/)
      .filter(notTest)
      .map((file) => path.relative(root, file).replaceAll("\\", "/"))
      .filter((file) => !allowed.has(file))
      .filter((file) =>
        /storageKey/.test(readFileSync(path.join(root, file), "utf8")),
      );
    expect(offenders).toEqual([]);
  });

  it("listDatasheets projects the key away (not selected, not returned)", () => {
    const source = readFileSync(
      path.join(root, "src/lib/admin/datasheets.ts"),
      "utf8",
    );
    const list = source.slice(
      source.indexOf("export async function listDatasheets"),
      source.indexOf("// Step 1: presign"),
    );
    expect(list).not.toContain("storageKey");
  });

  it("client components import no server-only module", () => {
    const forbidden = [
      /@\/lib\/env"/,
      /@\/lib\/storage"/,
      /@\/lib\/cloudinary"/,
      /@\/lib\/db"/,
      /@\/lib\/auth"/,
      /@\/lib\/permissions"/,
      /@\/lib\/admin\//,
      /@\/models/,
      /server-only/,
      /@aws-sdk\//,
      /from "cloudinary"/,
    ];
    const offenders: string[] = [];
    for (const file of [
      ...sourceFiles("src/components", /\.tsx?$/),
      ...sourceFiles("src/app", /\.tsx?$/),
    ].filter(notTest)) {
      const text = readFileSync(file, "utf8");
      if (
        !/^\s*["']use client["']/m.test(text.split("\n").slice(0, 5).join("\n"))
      )
        continue;
      for (const line of text.split("\n")) {
        if (
          !/^\s*(import|export)\b[^;]*from\s|^\s*import\s+["']/.test(line) &&
          !/^\s*from\s+["']/.test(line)
        )
          continue;
        if (/^\s*import\s+type\b/.test(line)) continue;
        if (forbidden.some((rule) => rule.test(line))) {
          offenders.push(`${path.relative(root, file)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no NEXT_PUBLIC_ variable is read anywhere in src or scripts", () => {
    const offenders = [
      ...sourceFiles("src", /\.tsx?$/),
      ...sourceFiles("scripts", /\.(ts|mjs)$/),
    ]
      .filter(notTest)
      .filter((file) =>
        /process\.env\.NEXT_PUBLIC_|NEXT_PUBLIC_[A-Z_]+\s*[=:]/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });

  it("the built client bundle holds no secret name or credential shape (skipped without a build)", () => {
    const dir = path.join(root, ".next", "static");
    if (!existsSync(dir)) return;
    const patterns = [
      /CLOUDINARY_URL/,
      /cloudinary:\/\/\d/,
      /CLOUDINARY_API_SECRET/,
      /R2_SECRET_ACCESS_KEY/,
      /R2_ACCESS_KEY_ID/,
      /secretAccessKey/,
      /AUTH_SECRET/,
      /WHISTLEBLOWER_ENC_KEY/,
      /IP_HASH_SECRET/,
      /X-Amz-Signature=[0-9a-f]{20}/,
      /\bapi_secret\b/,
      /storageKey/,
    ];
    const hits: string[] = [];
    const walk = (current: string) => {
      for (const name of readdirSync(current)) {
        const full = path.join(current, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(js|css|html|json|map)$/.test(name)) {
          const text = readFileSync(full, "utf8");
          for (const pattern of patterns) {
            if (pattern.test(text))
              hits.push(`${path.relative(root, full)}: ${pattern}`);
          }
        }
      }
    };
    walk(dir);
    expect(hits).toEqual([]);
  });
});
