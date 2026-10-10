// Tests for the import commit (Phase 3 T8, ADR 0061) on an in-memory MongoDB:
// golden create, idempotence (commit then preview = all unchanged, a second
// commit writes nothing), hash and staleness checks, the removal ack, picture
// dedupe / cap / variant pictures, the slug race, partial failure + resume,
// multi-batch commits and finishImport. R2 and Cloudinary are mocked.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORT_BATCH_SIZE, MAX_PRODUCT_IMAGES } from "@/lib/constants";
import { buildPublicId } from "@/lib/cloudinary-ids";
import * as cloudinary from "@/lib/cloudinary";
import { mongoose } from "@/lib/db";
import { buildImportTemplate } from "@/lib/import/template";
import * as storage from "@/lib/storage";
import { AreaModel, CategoryModel, ProductModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";

import { testActor } from "../../../test/helpers/admin-actor";
import {
  fillTemplate,
  goldenTemplateFile,
  goldenTemplateRows,
  TEMPLATE_INPUT,
  type TemplateRow,
} from "../../../test/fixtures/import/template-fixture";
import { setupMemoryDb } from "../../../test/helpers/memory-db";
import { testPublicId } from "../../../test/helpers/public-ids";
import {
  COMMIT_ERRORS,
  commitImportBatch,
  FILE_CHANGED,
  finishImport,
  PREVIEW_AGAIN,
  previewImport,
  REMOVALS_NOT_CONFIRMED,
  type CommitBatchResult,
  type ImportPreview,
} from ".";

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: (await import("../../../test/helpers/admin-actor"))
    .fakeSessionFromDb,
}));

vi.mock("@/lib/storage", () => {
  class StorageConditionError extends Error {
    override name = "StorageConditionError";
  }
  return {
    getImportBytes: vi.fn(),
    deleteImportUpload: vi.fn(),
    presignImportUpload: vi.fn(),
    StorageConditionError,
  };
});

vi.mock("@/lib/cloudinary", () => ({
  uploadImageBuffer: vi.fn(),
  destroyImage: vi.fn(),
}));

setupMemoryDb("yg_import_commit_test");

const { ObjectId } = mongoose.Types;
const IMPORT_ID = "00000000-0000-4000-8000-000000000001";
const KEY = `imports/${IMPORT_ID}.xlsx`;
const ETAG = '"etag-1"';
const admin = testActor();

let defaultCategory: string;
let templateBytes: Buffer;

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

beforeAll(async () => {
  await ProductModel.createIndexes();
  templateBytes = await goldenTemplateFile();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await Promise.all([
    ProductModel.deleteMany({}),
    CategoryModel.deleteMany({}),
    AreaModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  const [d, spot, rec] = await CategoryModel.create([
    { name: "Default", slug: "default", parent: null, order: 0 },
    { name: "Spot Lights", slug: "spot-lights", parent: null, order: 1 },
    {
      name: "Recessed Lights",
      slug: "recessed-lights",
      parent: null,
      order: 2,
    },
  ]);
  await CategoryModel.create([
    { name: "Recessed", slug: "recessed", parent: spot?._id, order: 0 },
    { name: "Spot", slug: "spot", parent: rec?._id, order: 0 },
  ]);
  defaultCategory = d!._id.toHexString();
  await AreaModel.create([
    { name: "Residential", slug: "residential", order: 0 },
    { name: "Retail", slug: "retail", order: 1 },
    { name: "Hospitality", slug: "hospitality", order: 2 },
  ]);
  stageFile(templateBytes);
  vi.mocked(cloudinary.uploadImageBuffer).mockImplementation(
    async (productId, data) => ({
      ok: true,
      image: {
        publicId: buildPublicId("product", productId, randomUUID()),
        sourceSha256: sha256(data),
        bytes: data.byteLength,
        format: "png",
        width: 8,
        height: 8,
      },
    }),
  );
  vi.mocked(cloudinary.destroyImage).mockResolvedValue(true);
  vi.mocked(storage.deleteImportUpload).mockResolvedValue(undefined);
});

function stageFile(bytes: Uint8Array): void {
  vi.mocked(storage.getImportBytes).mockResolvedValue({
    ok: true,
    bytes: new Uint8Array(bytes),
    etag: ETAG,
  });
}

type PlanPreview = Extract<ImportPreview, { kind: "plan" }>;

async function preview(): Promise<PlanPreview> {
  const result = await previewImport(admin, {
    key: KEY,
    defaultCategoryId: defaultCategory,
  });
  if (!result.ok || result.data.kind !== "plan") {
    throw new Error(JSON.stringify(result));
  }
  return result.data;
}

function commitInput(
  p: PlanPreview,
  batch = 0,
  acknowledgeRemovals = false,
): Record<string, unknown> {
  return {
    key: KEY,
    defaultCategoryId: defaultCategory,
    etag: p.etag,
    planHash: p.plan.planHash,
    entryHashes: p.plan.entries.map((e) => e.hash),
    batch,
    acknowledgeRemovals,
  };
}

async function commitOk(
  p: PlanPreview,
  batch = 0,
  ack = false,
): Promise<{ data: CommitBatchResult; tags: string[] }> {
  const result = await commitImportBatch(admin, commitInput(p, batch, ack));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return { data: result.data, tags: result.tags };
}

async function snapshot() {
  return ProductModel.find({}).sort({ _id: 1 }).lean();
}

const arcVariants = (pictures: [number, number]) =>
  goldenTemplateRows().map((row, i) =>
    i < 2 ? { ...row, picture: pictures[i as 0 | 1] } : row,
  );

async function templateWith(
  rows: readonly { row: TemplateRow; picture?: number }[],
): Promise<Buffer> {
  return fillTemplate(await buildImportTemplate(TEMPLATE_INPUT), rows);
}

describe("commitImportBatch: golden create", () => {
  it("creates every planned product as a draft with exactly its target", async () => {
    const p = await preview();
    const { data, tags } = await commitOk(p);

    expect(data).toMatchObject({ batch: 0, batches: 1 });
    expect(data.summary).toEqual({
      created: 3,
      updated: 0,
      unchanged: 0,
      blocked: 0,
      failed: 0,
      imagesAdded: 3,
      variantsRemoved: 0,
    });
    const arc = await ProductModel.findOne({ slug: "arc-ar-013a" }).lean();
    expect(arc).not.toBeNull();
    expect(arc!.status).toBe("draft");
    expect(arc!.name).toBe("Arc AR-013A");
    expect(arc!.family).toBe("Arc");
    expect(arc!.variants.map((v) => [v.modelNo, v.label])).toEqual([
      ["AR-013A1", "Regular Lens"],
      ["AR-013A2", "High Efficiency Reflector"],
    ]);
    expect(arc!.variants.map((v) => v.specs?.lumenOutput)).toEqual([
      ["1140 LM"],
      ["1200 LM"],
    ]);
    // Shared values live on the product, not on the variants.
    expect(arc!.specs?.cct).toEqual(["3000K", "4000K"]);
    expect(arc!.variants[0]?.specs?.cct).toBeUndefined();
    expect(arc!.filters).toMatchObject({ cctK: [3000, 4000], wattage: [12] });

    // One picture, one upload: the two Arc rows share it.
    expect(arc!.images).toHaveLength(1);
    expect(arc!.images[0]).toMatchObject({
      order: 0,
      kind: "gallery",
      alt: "Arc AR-013A",
    });
    expect(arc!.images[0]!.publicId).toMatch(
      new RegExp(`^yg/products/${arc!._id.toHexString()}/`),
    );
    const planned = p.plan.entries.find((e) => e.productNo === 76)!;
    expect(arc!.images[0]!.sourceSha256).toBe(planned.imagesToAdd[0]!.sha256);
    expect(cloudinary.uploadImageBuffer).toHaveBeenCalledTimes(3);
    // Variants share the gallery picture: no variant picture.
    expect(arc!.variants.every((v) => v.imagePublicId === undefined)).toBe(
      true,
    );

    expect(tags).toContain("products");
    expect(tags).toContain(`product:${arc!._id.toHexString()}`);
    expect(tags).not.toContain("categories"); // drafts are not public

    const audits = await AuditLogModel.find({}).lean();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "import.commit",
      target: { type: "import", id: IMPORT_ID },
      meta: {
        batch: 0,
        created: 3,
        updated: 0,
        failed: 0,
        imagesAdded: 3,
        variantsRemoved: 0,
      },
    });
    const ids = (audits[0]!.meta as { productIds: string[] }).productIds;
    expect(ids).toHaveLength(3);
    // Counts and ids only: no names, specs or warning text in the audit.
    expect(JSON.stringify(audits[0]!.meta)).not.toMatch(/Arc|LM|Lens/);
  });

  it("reads exactly the previewed file version (If-Match = the preview's ETag)", async () => {
    const p = await preview();
    await commitOk(p);
    expect(storage.getImportBytes).toHaveBeenLastCalledWith(KEY, {
      ifMatch: ETAG,
    });
  });

  it("returns per-product results with ids and slugs for links", async () => {
    const { data } = await commitOk(await preview());
    expect(data.products.map((p) => [p.productNo, p.status])).toEqual([
      [76, "created"],
      [77, "created"],
      [78, "created"],
    ]);
    for (const product of data.products) {
      expect(product.id).toMatch(/^[0-9a-f]{24}$/);
      expect(await ProductModel.exists({ slug: product.slug })).not.toBeNull();
    }
  });
});

describe("commitImportBatch: idempotence", () => {
  it("plans every product as unchanged after the commit", async () => {
    await commitOk(await preview());
    const again = await preview();
    expect(again.plan.summary).toMatchObject({
      create: 0,
      update: 0,
      unchanged: 3,
      blocked: 0,
      imagesToAdd: 0,
      variantsRemoved: 0,
    });
    for (const entry of again.plan.entries) expect(entry.changes).toEqual([]);
  });

  it("a second import of the same file writes, uploads and audits nothing", async () => {
    await commitOk(await preview());
    const before = await snapshot();
    vi.mocked(cloudinary.uploadImageBuffer).mockClear();

    const { data, tags } = await commitOk(await preview());
    expect(data.summary).toMatchObject({
      unchanged: 3,
      created: 0,
      updated: 0,
    });
    expect(tags).toEqual([]);
    expect(cloudinary.uploadImageBuffer).not.toHaveBeenCalled();
    expect(await AuditLogModel.countDocuments()).toBe(1);
    expect(await snapshot()).toEqual(before); // updatedAt identical too
  });

  it("re-sending the same commit after it succeeded is a no-op (resume)", async () => {
    const p = await preview();
    await commitOk(p);
    const before = await snapshot();
    const { data, tags } = await commitOk(p);
    expect(data.summary).toMatchObject({ unchanged: 3, created: 0, failed: 0 });
    expect(tags).toEqual([]);
    expect(await ProductModel.countDocuments()).toBe(3);
    expect(await snapshot()).toEqual(before);
    expect(await AuditLogModel.countDocuments()).toBe(1);
  });
});

describe("commitImportBatch: hash and staleness checks", () => {
  it("refuses a plan hash that is not the preview's", async () => {
    const p = await preview();
    const result = await commitImportBatch(admin, {
      ...commitInput(p),
      planHash: "0".repeat(64),
    });
    expect(result).toMatchObject({
      ok: false,
      errors: { formErrors: [PREVIEW_AGAIN] },
      tags: [],
    });
    expect(await ProductModel.countDocuments()).toBe(0);
    expect(cloudinary.uploadImageBuffer).not.toHaveBeenCalled();
  });

  it("refuses entry hashes that don't add up to the plan hash", async () => {
    const p = await preview();
    const input = commitInput(p);
    const hashes = [...(input.entryHashes as string[])];
    hashes[0] = "f".repeat(64);
    const result = await commitImportBatch(admin, {
      ...input,
      entryHashes: hashes,
    });
    expect(result).toMatchObject({
      ok: false,
      errors: { formErrors: [PREVIEW_AGAIN] },
    });
    expect(await ProductModel.countDocuments()).toBe(0);
    expect(cloudinary.uploadImageBuffer).not.toHaveBeenCalled();
  });

  it("refuses a different file under the same key (sheet hash differs)", async () => {
    const p = await preview();
    stageFile(await templateWith(goldenTemplateRows().slice(0, 3)));
    const result = await commitImportBatch(admin, commitInput(p));
    expect(result).toMatchObject({
      ok: false,
      errors: { formErrors: [PREVIEW_AGAIN] },
    });
    expect(cloudinary.uploadImageBuffer).not.toHaveBeenCalled();
    expect(await ProductModel.countDocuments()).toBe(0);
  });

  it("refuses with 'preview again' when a matched product changed after the preview", async () => {
    await commitOk(await preview());
    // The sheet now changes a lumen value, so 76 plans as an update.
    stageFile(
      await templateWith(
        goldenTemplateRows().map((r, i) =>
          i === 0 ? { ...r, row: { ...r.row, "Lumen Output": "1150 LM" } } : r,
        ),
      ),
    );
    const p = await preview();
    expect(p.plan.summary.update).toBe(1);
    await ProductModel.updateOne(
      { slug: "arc-ar-013a" },
      { $set: { description: "Edited by the admin meanwhile" } },
    );
    const before = await snapshot();
    const result = await commitImportBatch(admin, commitInput(p));
    expect(result).toMatchObject({
      ok: false,
      errors: { formErrors: [PREVIEW_AGAIN] },
    });
    expect(await snapshot()).toEqual(before);
  });

  it("maps a replaced staged file (If-Match failed) to 'file changed'", async () => {
    const p = await preview();
    vi.mocked(storage.getImportBytes).mockRejectedValueOnce(
      new storage.StorageConditionError(),
    );
    const result = await commitImportBatch(admin, commitInput(p));
    expect(result).toMatchObject({
      ok: false,
      errors: { formErrors: [FILE_CHANGED] },
    });
  });

  it("refuses a batch past the last one", async () => {
    const result = await commitImportBatch(
      admin,
      commitInput(await preview(), 1),
    );
    expect(result).toMatchObject({
      ok: false,
      errors: { fieldErrors: { batch: [expect.any(String)] } },
    });
  });

  it("refuses unknown fields and a bad key before reading anything", async () => {
    const p = await preview();
    vi.mocked(storage.getImportBytes).mockClear();
    expect(
      (await commitImportBatch(admin, { ...commitInput(p), extra: 1 })).ok,
    ).toBe(false);
    expect(
      (
        await commitImportBatch(admin, {
          ...commitInput(p),
          key: "datasheets/x.xlsx",
        })
      ).ok,
    ).toBe(false);
    expect(storage.getImportBytes).not.toHaveBeenCalled();
  });

  it("throws without a signed-in admin's id", async () => {
    await expect(
      commitImportBatch(
        { id: "not-an-id", headers: new Headers() },
        commitInput(await preview()),
      ),
    ).rejects.toThrow(TypeError);
  });
});

describe("commitImportBatch: updates", () => {
  async function updatedArc(): Promise<PlanPreview> {
    stageFile(
      await templateWith(
        goldenTemplateRows().map((r, i) =>
          i === 1 ? { ...r, row: { ...r.row, "Lumen Output": "1250 LM" } } : r,
        ),
      ),
    );
    return preview();
  }

  it("writes sheet-owned fields only; admin fields and status stay", async () => {
    await commitOk(await preview());
    const datasheetId = new ObjectId();
    await ProductModel.updateOne(
      { slug: "arc-ar-013a" },
      {
        $set: {
          name: "Arc by the admin",
          slug: "arc-custom",
          status: "published",
          description: "Admin text",
          featured: true,
          datasheetId,
          extraSpecs: [{ label: "Note", value: "Admin" }],
          "variants.0.label": "Lens (admin)",
        },
      },
    );
    const p = await updatedArc();
    const arcEntry = p.plan.entries.find((e) => e.productNo === 76)!;
    expect(arcEntry.status).toBe("update");

    const { data, tags } = await commitOk(p);
    expect(data.summary).toMatchObject({ updated: 1, unchanged: 2 });
    const arc = await ProductModel.findOne({ slug: "arc-custom" }).lean();
    expect(arc).toMatchObject({
      name: "Arc by the admin",
      status: "published",
      description: "Admin text",
      featured: true,
      datasheetId,
      extraSpecs: [{ label: "Note", value: "Admin" }],
    });
    expect(arc!.variants.map((v) => [v.label, v.specs?.lumenOutput])).toEqual([
      ["Lens (admin)", ["1140 LM"]],
      ["High Efficiency Reflector", ["1250 LM"]],
    ]);
    // Published: listings are expired too.
    expect(tags).toEqual(
      expect.arrayContaining(["products", "categories", "areas"]),
    );
    const audit = await AuditLogModel.findOne({}).sort({ _id: -1 }).lean();
    expect(audit!.meta).toMatchObject({ updated: 1, created: 0 });
    // And the next preview is all unchanged.
    expect((await preview()).plan.summary.unchanged).toBe(3);
  });

  it("removes variants only with the acknowledgement", async () => {
    await commitOk(await preview());
    // The sheet drops AR-013A2.
    stageFile(
      await templateWith(goldenTemplateRows().filter((_, i) => i !== 1)),
    );
    const p = await preview();
    const arcEntry = p.plan.entries.find((e) => e.productNo === 76)!;
    expect(arcEntry.variantsRemoved).toEqual(["AR-013A2"]);
    const before = await snapshot();

    const refused = await commitImportBatch(admin, commitInput(p, 0, false));
    expect(refused).toMatchObject({
      ok: false,
      errors: {
        fieldErrors: { acknowledgeRemovals: [REMOVALS_NOT_CONFIRMED] },
      },
      tags: [],
    });
    expect(await snapshot()).toEqual(before);

    const { data } = await commitOk(p, 0, true);
    expect(data.summary).toMatchObject({ updated: 1, variantsRemoved: 1 });
    const arc = await ProductModel.findOne({ slug: "arc-ar-013a" }).lean();
    expect(arc!.variants.map((v) => v.modelNo)).toEqual(["AR-013A1"]);
    expect((await preview()).plan.summary.unchanged).toBe(3);
  });

  it("never uploads a picture the product already holds (by sourceSha256)", async () => {
    await commitOk(await preview());
    vi.mocked(cloudinary.uploadImageBuffer).mockClear();
    await commitOk(await updatedArc());
    expect(cloudinary.uploadImageBuffer).not.toHaveBeenCalled();
    const arc = await ProductModel.findOne({ slug: "arc-ar-013a" }).lean();
    expect(arc!.images).toHaveLength(1);
  });

  it("appends a new picture after the saved ones and stays within the cap", async () => {
    await commitOk(await preview());
    const arc = await ProductModel.findOne({ slug: "arc-ar-013a" }).lean();
    const id = arc!._id.toHexString();
    // The admin filled the gallery up to one below the cap.
    const extra = Array.from({ length: MAX_PRODUCT_IMAGES - 2 }, (_, n) => ({
      publicId: testPublicId(n + 1, id),
      order: n + 1,
      kind: "gallery",
    }));
    await ProductModel.updateOne(
      { _id: arc!._id },
      { $push: { images: { $each: extra } } },
    );
    // The sheet now gives Arc two new pictures (one per variant).
    stageFile(await templateWith(arcVariants([3, 4])));
    const p = await preview();
    const arcEntry = p.plan.entries.find((e) => e.productNo === 76)!;
    expect(arcEntry.imagesToAdd).toHaveLength(1);
    vi.mocked(cloudinary.uploadImageBuffer).mockClear();

    await commitOk(p);
    // Only one of Arc's two new pictures fits (exceljs also anchors one
    // fixture picture on No. 78, so count Arc's uploads only).
    const arcUploads = vi
      .mocked(cloudinary.uploadImageBuffer)
      .mock.calls.filter(([productId]) => productId === id);
    expect(arcUploads).toHaveLength(1);
    const after = await ProductModel.findById(arc!._id).lean();
    expect(after!.images).toHaveLength(MAX_PRODUCT_IMAGES);
    expect(after!.images.at(-1)).toMatchObject({
      order: MAX_PRODUCT_IMAGES - 1,
      kind: "gallery",
      alt: "Arc AR-013A",
      sourceSha256: arcEntry.imagesToAdd[0]!.sha256,
    });
    // Saved variants keep their (unset) picture: it is admin-owned.
    expect(after!.variants.every((v) => v.imagePublicId === undefined)).toBe(
      true,
    );
  });
});

describe("commitImportBatch: variant pictures", () => {
  it("gives each new variant its own uploaded copy, one per picture", async () => {
    stageFile(await templateWith(arcVariants([0, 3])));
    const p = await preview();
    const planned = p.plan.entries.find((e) => e.productNo === 76)!;
    const shas = planned.target!.variants.map((v) => v.imageSha256);
    expect(new Set(shas).size).toBe(2);

    await commitOk(p);
    const arc = await ProductModel.findOne({ slug: "arc-ar-013a" }).lean();
    expect(arc!.images).toHaveLength(2);
    const bySha = new Map(arc!.images.map((i) => [i.sourceSha256, i.publicId]));
    expect(arc!.variants.map((v) => v.imagePublicId)).toEqual(
      shas.map((sha) => bySha.get(sha!)),
    );
    expect((await preview()).plan.summary.unchanged).toBe(3);
  });

  it("uploads a picture shared by two products once per product", async () => {
    // 77 and 78 both use picture 1.
    stageFile(
      await templateWith(
        goldenTemplateRows().map((r, i) => (i >= 2 ? { ...r, picture: 1 } : r)),
      ),
    );
    await commitOk(await preview());
    const calls = vi.mocked(cloudinary.uploadImageBuffer).mock.calls;
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(([productId]) => productId)).size).toBe(3);
  });
});

describe("commitImportBatch: failures", () => {
  it("a slug taken during the commit fails that product only (no crash)", async () => {
    const p = await preview();
    let raced = false;
    vi.mocked(cloudinary.uploadImageBuffer).mockImplementation(
      async (productId, data) => {
        if (!raced) {
          raced = true;
          await ProductModel.create({
            name: "Racer",
            slug: "arc-ar-013a",
            mainCategory: new ObjectId(defaultCategory),
            variants: [{ modelNo: "RACE-1" }],
          });
        }
        return {
          ok: true,
          image: {
            publicId: buildPublicId("product", productId, randomUUID()),
            sourceSha256: sha256(data),
            bytes: data.byteLength,
            format: "png",
            width: 8,
            height: 8,
          },
        };
      },
    );
    const { data, tags } = await commitOk(p);
    const arc = data.products.find((x) => x.productNo === 76)!;
    expect(arc).toMatchObject({
      status: "failed",
      error: COMMIT_ERRORS.taken,
      id: null,
    });
    expect(data.summary).toMatchObject({ created: 2, failed: 1 });
    // Its uploaded copy is destroyed; the other products' are kept.
    expect(cloudinary.destroyImage).toHaveBeenCalledTimes(1);
    expect(tags.filter((t) => t.startsWith("product:"))).toHaveLength(2);
    const audit = await AuditLogModel.findOne({}).lean();
    expect(audit!.meta).toMatchObject({ created: 2, failed: 1 });
    expect(await ProductModel.countDocuments({ name: "Racer" })).toBe(1);
  });

  it("a failed upload fails that product; re-running finishes it with no duplicates", async () => {
    const p = await preview();
    const arcSha = p.plan.entries.find((e) => e.productNo === 76)!
      .imagesToAdd[0]!.sha256;
    const ok = vi.mocked(cloudinary.uploadImageBuffer).getMockImplementation()!;
    vi.mocked(cloudinary.uploadImageBuffer).mockImplementation(
      async (productId, data) =>
        sha256(data) === arcSha
          ? { ok: false, reason: "unavailable" }
          : ok(productId, data),
    );
    const first = await commitOk(p);
    expect(first.data.summary).toMatchObject({ created: 2, failed: 1 });
    expect(first.data.products[0]).toMatchObject({
      productNo: 76,
      status: "failed",
      error: COMMIT_ERRORS.upload,
    });
    expect(await ProductModel.countDocuments()).toBe(2);

    // Cloudinary is back; the admin retries the same batch.
    vi.mocked(cloudinary.uploadImageBuffer).mockImplementation(ok);
    vi.mocked(cloudinary.uploadImageBuffer).mockClear();
    const second = await commitOk(p);
    expect(second.data.summary).toMatchObject({
      created: 1,
      unchanged: 2,
      failed: 0,
    });
    expect(cloudinary.uploadImageBuffer).toHaveBeenCalledTimes(1);
    expect(await ProductModel.countDocuments()).toBe(3);
    expect(await AuditLogModel.countDocuments()).toBe(2);
    expect((await preview()).plan.summary.unchanged).toBe(3);
  });

  async function arcLumenUpdate(): Promise<PlanPreview> {
    await commitOk(await preview());
    stageFile(
      await templateWith(
        goldenTemplateRows().map((r, i) =>
          i === 0 ? { ...r, row: { ...r.row, "Lumen Output": "1150 LM" } } : r,
        ),
      ),
    );
    return preview();
  }

  const saveMeanwhile = () =>
    ProductModel.updateOne(
      { slug: "arc-ar-013a" },
      { $set: { description: "Saved meanwhile" } },
    );

  async function expectArcKeptAdminSave(): Promise<void> {
    const arc = await ProductModel.findOne({ slug: "arc-ar-013a" }).lean();
    expect(arc!.description).toBe("Saved meanwhile");
    expect(arc!.variants[0]!.specs?.lumenOutput).toEqual(["1140 LM"]);
  }

  it("pre-check: a product saved after the re-plan, before the batch read, fails alone", async () => {
    const p = await arcLumenUpdate();
    // The admin's save lands just before the commit reads the saved state.
    const original = ProductModel.find.bind(ProductModel);
    const spy = vi.spyOn(ProductModel, "find").mockImplementation(((
      ...args: Parameters<typeof original>
    ) => {
      const filter = args[0] as Record<string, unknown> | undefined;
      if (filter && "_id" in filter) {
        return {
          lean: async () => {
            await saveMeanwhile();
            return original(...args).lean();
          },
        };
      }
      return original(...args);
    }) as unknown as typeof ProductModel.find);
    try {
      const { data } = await commitOk(p);
      expect(data.products[0]).toMatchObject({
        status: "failed",
        error: COMMIT_ERRORS.changed,
      });
    } finally {
      spy.mockRestore();
    }
    await expectArcKeptAdminSave();
  });

  it("conditional write: a save landing right before the update is never overwritten", async () => {
    const p = await arcLumenUpdate();
    const realUpdate = ProductModel.updateOne.bind(ProductModel);
    let raced = false;
    const spy = vi.spyOn(ProductModel, "updateOne").mockImplementation(((
      ...args: Parameters<typeof realUpdate>
    ) => {
      const filter = args[0] as unknown as Record<string, unknown> | undefined;
      if (!raced && filter && "updatedAt" in filter) {
        raced = true;
        return saveMeanwhile().then(() => realUpdate(...args));
      }
      return realUpdate(...args);
    }) as unknown as typeof ProductModel.updateOne);
    try {
      const { data } = await commitOk(p);
      expect(raced).toBe(true);
      expect(data.products[0]).toMatchObject({
        status: "failed",
        error: COMMIT_ERRORS.changed,
      });
      expect(data.summary).toMatchObject({ failed: 1, unchanged: 2 });
    } finally {
      spy.mockRestore();
    }
    await expectArcKeptAdminSave();
  });

  it("keeps the uploads when a write's outcome is unknown, destroys them when it surely failed", async () => {
    const realCreate = ProductModel.create.bind(ProductModel);
    const failArcWith = (error: Error) =>
      vi
        .spyOn(ProductModel, "create")
        .mockImplementation(((doc: Record<string, unknown>) =>
          doc.slug === "arc-ar-013a"
            ? Promise.reject(error)
            : realCreate(doc)) as unknown as typeof ProductModel.create);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let spy: ReturnType<typeof failArcWith> | undefined;
    try {
      // A network error after the server may have applied the insert.
      const network = Object.assign(new Error("socket closed"), {
        name: "MongoNetworkError",
      });
      spy = failArcWith(network);
      const first = await commitOk(await preview());
      spy.mockRestore();
      expect(first.data.products[0]).toMatchObject({
        status: "failed",
        error: COMMIT_ERRORS.save,
      });
      expect(cloudinary.destroyImage).not.toHaveBeenCalled();
      // Logged by class name only, never the message or values.
      expect(log.mock.calls.flat().join(" ")).not.toContain("socket closed");

      // A validation error: certainly not written, so the copy is destroyed.
      spy = failArcWith(new mongoose.Error.ValidationError());
      const second = await commitOk(await preview());
      spy.mockRestore();
      expect(second.data.products[0]).toMatchObject({ status: "failed" });
      expect(cloudinary.destroyImage).toHaveBeenCalledTimes(1);
    } finally {
      spy?.mockRestore();
      log.mockRestore();
    }
  });
});

describe("commitImportBatch: batches", () => {
  function manyRows(count: number): { row: TemplateRow }[] {
    return Array.from({ length: count }, (_, i) => ({
      row: {
        "NO.": i + 1,
        "Model Name": "Beam",
        "Model Type": "Track Spot",
        "Model No.": `BX-${String(i + 1).padStart(3, "0")}A1`,
        Wattage: "12W",
        Category: "Recessed Lights",
      },
    }));
  }

  it("commits batch after batch from one preview, then everything is unchanged", async () => {
    const total = IMPORT_BATCH_SIZE + 5;
    stageFile(await templateWith(manyRows(total)));
    const p = await preview();
    expect(p.plan.summary.create).toBe(total);

    const first = await commitOk(p, 0);
    expect(first.data).toMatchObject({ batch: 0, batches: 2 });
    expect(first.data.summary.created).toBe(IMPORT_BATCH_SIZE);
    // Batch 1 still commits although batch 0 changed the database.
    const second = await commitOk(p, 1);
    expect(second.data.summary.created).toBe(5);
    expect(second.data.products[0]!.index).toBe(IMPORT_BATCH_SIZE);
    expect(await ProductModel.countDocuments()).toBe(total);
    expect(await AuditLogModel.countDocuments()).toBe(2);

    // Re-running either batch is a no-op.
    expect((await commitOk(p, 0)).data.summary.unchanged).toBe(
      IMPORT_BATCH_SIZE,
    );
    expect((await commitOk(p, 1)).data.summary.unchanged).toBe(5);
    expect(await AuditLogModel.countDocuments()).toBe(2);
    expect((await preview()).plan.summary.unchanged).toBe(total);
  });
});

describe("finishImport", () => {
  it("deletes the staged file", async () => {
    const result = await finishImport(admin, { key: KEY });
    expect(result).toEqual({ ok: true, data: { deleted: true }, tags: [] });
    expect(storage.deleteImportUpload).toHaveBeenCalledWith(KEY);
  });

  it("refuses a key that is not a staged import", async () => {
    const result = await finishImport(admin, { key: "datasheets/a.xlsx" });
    expect(result.ok).toBe(false);
    expect(storage.deleteImportUpload).not.toHaveBeenCalled();
  });

  it("reports a failed delete without failing (the sweep is the backstop)", async () => {
    vi.mocked(storage.deleteImportUpload).mockRejectedValueOnce(
      new Error("boom"),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await finishImport(admin, { key: KEY });
      expect(result).toEqual({ ok: true, data: { deleted: false }, tags: [] });
      expect(error.mock.calls.flat().join(" ")).not.toContain(KEY);
    } finally {
      error.mockRestore();
    }
  });
});

// The client's REAL sheet (local only, gitignored; skipped when absent).
// eslint-disable-next-line no-restricted-properties
const realOverride = process.env.IMPORT_FIXTURE;
const realPath = resolve(
  realOverride && realOverride.trim() !== ""
    ? realOverride
    : "doc/reference/client-sample-sheet.xlsx",
);

describe.skipIf(!existsSync(realPath))(
  "commitImportBatch on the client's real sheet",
  () => {
    it("saves No. 76 as Arc with two variants, then plans all unchanged", async () => {
      stageFile(readFileSync(realPath));
      const { data } = await commitOk(await preview());
      expect(data.summary).toMatchObject({ created: 4, blocked: 2, failed: 0 });

      const arc = await ProductModel.findOne({ slug: "arc-ar-013a" }).lean();
      expect(arc!.family).toBe("Arc");
      expect(
        arc!.variants.map((v) => [v.modelNo, v.specs?.lumenOutput]),
      ).toEqual([
        ["AR-013A1", ["1140 LM"]],
        ["AR-013A2", ["1200 LM"]],
      ]);
      expect(arc!.images).toHaveLength(1);

      const before = await snapshot();
      const again = await preview();
      expect(again.plan.summary).toMatchObject({ unchanged: 4, blocked: 2 });
      const second = await commitOk(again);
      expect(second.tags).toEqual([]);
      expect(await snapshot()).toEqual(before);
    });
  },
);
