// Phase 3 QA gate B (T6-T8, T10a/T10b): adversarial tests for the import
// commit's hash protocol, field ownership on update, restricted values in
// audit/logs/tags, the keep/destroy rule for uploads, the plan's caps and the
// controlled template. R2 and Cloudinary are mocked; MongoDB is in memory.
// `it.fails` = a finding of this gate (see the gate B report); it turns red
// once the code is fixed, so flip it to `it` then.

import { createHash, randomUUID } from "node:crypto";

import JSZip from "jszip";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as adminProducts from "@/lib/admin/products";
import { buildPublicId } from "@/lib/cloudinary-ids";
import * as cloudinary from "@/lib/cloudinary";
import {
  IMPORT_BATCH_SIZE,
  MAX_IMPORT_PLAN_ENTRIES,
  MAX_PRODUCT_IMAGES,
} from "@/lib/constants";
import { mongoose } from "@/lib/db";
import { cleanRow } from "@/lib/import/clean";
import { groupRows } from "@/lib/import/group";
import { checkImportFile } from "@/lib/import/safety";
import { buildImportTemplate } from "@/lib/import/template";
import { readWorkbook } from "@/lib/import/workbook";
import { selectStaleImports } from "@/lib/orphan-sweep";
import {
  commitImportInputSchema,
  importIdFromKey,
  importKeySchema,
} from "@/lib/schemas/import";
import * as storage from "@/lib/storage";
import { AreaModel, CategoryModel, ProductModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";

import { fixturePictures } from "./fixtures/import/build";
import {
  fillTemplate,
  goldenTemplateFile,
  goldenTemplateRows,
  TEMPLATE_INPUT,
  type TemplateRow,
} from "./fixtures/import/template-fixture";
import { setupMemoryDb } from "./helpers/memory-db";
import { testPublicId } from "./helpers/public-ids";
import {
  commitImportBatch,
  PREVIEW_AGAIN,
  previewImport,
  type ImportPreview,
} from "@/lib/import";

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

// Wrapped (not replaced) so the per-plan probe can be counted.
vi.mock("@/lib/admin/products", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin/products")>();
  return {
    ...actual,
    withoutRestrictedFilters: vi.fn(actual.withoutRestrictedFilters),
  };
});

setupMemoryDb("yg_import_gate_b_qa");

const { ObjectId } = mongoose.Types;
const IMPORT_ID = "00000000-0000-4000-8000-0000000000b1";
const KEY = `imports/${IMPORT_ID}.xlsx`;
const ETAG = '"etag-b"';
const ACTOR = new ObjectId().toHexString();

/* Restricted by default (CLAUDE.md): Chip Type and Driver. The golden fill
   uses these values for them. */
const RESTRICTED_VALUES = ["COB", "Lifud"];

/* Paths the commit may write on update (ADR 0057 §3, ADR 0061 §3). */
const SHEET_OWNED_PATHS = new Set([
  "family",
  "type",
  "productNo",
  "modelCode",
  "specs",
  "filters",
  "variants",
  "mainCategory",
  "extraCategories",
  "areas",
  "trackSize",
]);
const PLAN_TARGET_KEYS = [
  "areas",
  "extraCategories",
  "family",
  "filters",
  "mainCategory",
  "modelCode",
  "name",
  "productNo",
  "slug",
  "specs",
  "trackSize",
  "type",
  "variants",
];

let defaultCategory: string;
let otherCategory: string;
let templateBytes: Buffer;
let pictures: Buffer[];

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

function okUpload(productId: string, data: Uint8Array) {
  return {
    ok: true as const,
    image: {
      publicId: buildPublicId("product", productId, randomUUID()),
      sourceSha256: sha256(data),
      bytes: data.byteLength,
      format: "png" as const,
      width: 8,
      height: 8,
    },
  };
}

beforeAll(async () => {
  await ProductModel.createIndexes();
  templateBytes = await goldenTemplateFile();
  pictures = await fixturePictures();
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
  otherCategory = spot!._id.toHexString();
  await AreaModel.create([
    { name: "Residential", slug: "residential", order: 0 },
    { name: "Retail", slug: "retail", order: 1 },
    { name: "Hospitality", slug: "hospitality", order: 2 },
  ]);
  stageFile(templateBytes);
  vi.mocked(cloudinary.uploadImageBuffer).mockImplementation(
    async (productId, data) => okUpload(productId, data),
  );
  vi.mocked(cloudinary.destroyImage).mockResolvedValue(true);
});

function stageFile(bytes: Uint8Array): void {
  vi.mocked(storage.getImportBytes).mockResolvedValue({
    ok: true,
    bytes: new Uint8Array(bytes),
    etag: ETAG,
  });
}

type PlanPreview = Extract<ImportPreview, { kind: "plan" }>;

async function preview(defaultCategoryId = defaultCategory) {
  const result = await previewImport({ key: KEY, defaultCategoryId });
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

async function commitOk(p: PlanPreview, batch = 0) {
  const result = await commitImportBatch(ACTOR, commitInput(p, batch));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
}

const snapshot = () => ProductModel.find({}).sort({ _id: 1 }).lean();

async function templateWith(
  rows: readonly { row: TemplateRow; picture?: number }[],
): Promise<Buffer> {
  return fillTemplate(await buildImportTemplate(TEMPLATE_INPUT), rows);
}

const golden = () => goldenTemplateRows();
const withRow = (
  index: number,
  change: Partial<TemplateRow>,
  picture?: number,
) =>
  golden().map((r, i) =>
    i === index
      ? {
          row: { ...r.row, ...change } as TemplateRow,
          picture: picture ?? r.picture,
        }
      : r,
  );

/* ------------------------------------------------------------------------ */

describe("gate B: hash protocol (forged, replayed, stale)", () => {
  it("refuses the preview's own hashes sent in another order", async () => {
    const p = await preview();
    const input = commitInput(p);
    const hashes = [...(input.entryHashes as string[])].reverse();
    const result = await commitImportBatch(ACTOR, {
      ...input,
      entryHashes: hashes,
    });
    expect(result).toMatchObject({
      ok: false,
      errors: { formErrors: [PREVIEW_AGAIN] },
    });
    expect(cloudinary.uploadImageBuffer).not.toHaveBeenCalled();
    expect(await ProductModel.countDocuments()).toBe(0);
  });

  it("refuses the preview's hashes under another default category", async () => {
    const p = await preview();
    const result = await commitImportBatch(ACTOR, {
      ...commitInput(p),
      defaultCategoryId: otherCategory,
    });
    expect(result).toMatchObject({
      ok: false,
      errors: { formErrors: [PREVIEW_AGAIN] },
    });
    expect(cloudinary.uploadImageBuffer).not.toHaveBeenCalled();
    expect(await ProductModel.countDocuments()).toBe(0);
  });

  it("refuses an extra (repeated) entry hash", async () => {
    const p = await preview();
    const input = commitInput(p);
    const hashes = input.entryHashes as string[];
    const result = await commitImportBatch(ACTOR, {
      ...input,
      entryHashes: [...hashes, hashes[0]],
    });
    expect(result.ok).toBe(false);
    expect(await ProductModel.countDocuments()).toBe(0);
  });

  it("refuses a whole batch, before any upload or write, when one entry is stale", async () => {
    await commitOk(await preview());
    // 76 gets a new picture (an upload) and 77 a new lumen value.
    stageFile(
      await templateWith(
        golden().map((r, i) => {
          if (i === 0) return { ...r, picture: 2 };
          if (i === 2) {
            return { ...r, row: { ...r.row, "Lumen Output": "999 LM" } };
          }
          return r;
        }),
      ),
    );
    const p = await preview();
    const e76 = p.plan.entries.find((e) => e.productNo === 76)!;
    const e77 = p.plan.entries.find((e) => e.productNo === 77)!;
    expect(e76.imagesToAdd.length).toBeGreaterThan(0);
    expect(e77.status).toBe("update");
    // The admin saves 77 between preview and commit.
    await ProductModel.updateOne(
      { productNo: 77 },
      { $set: { description: "admin meanwhile" } },
    );
    vi.mocked(cloudinary.uploadImageBuffer).mockClear();
    const before = await snapshot();
    const auditsBefore = await AuditLogModel.countDocuments();

    const result = await commitImportBatch(ACTOR, commitInput(p));
    expect(result).toMatchObject({
      ok: false,
      errors: { formErrors: [PREVIEW_AGAIN] },
      tags: [],
    });
    expect(cloudinary.uploadImageBuffer).not.toHaveBeenCalled();
    expect(cloudinary.destroyImage).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(await AuditLogModel.countDocuments()).toBe(auditsBefore);
  });

  it("a replayed old batch never reverts an admin edit of a sheet-owned field", async () => {
    const p = await preview();
    await commitOk(p);
    await ProductModel.updateOne(
      { productNo: 77 },
      { $set: { family: "Beam (admin)" } },
    );
    const result = await commitImportBatch(ACTOR, commitInput(p));
    expect(result).toMatchObject({
      ok: false,
      errors: { formErrors: [PREVIEW_AGAIN] },
    });
    const beam = await ProductModel.findOne({ productNo: 77 }).lean();
    expect(beam!.family).toBe("Beam (admin)");
  });

  it("an entry previewed as blocked that now plans as an update is refused", async () => {
    // AR-013A1 and AR-013A2 belong to two saved products: 76 is blocked.
    const [a, b] = await ProductModel.create([
      {
        name: "A",
        slug: "a",
        mainCategory: new ObjectId(defaultCategory),
        variants: [{ modelNo: "AR-013A1" }],
      },
      {
        name: "B",
        slug: "b",
        mainCategory: new ObjectId(defaultCategory),
        variants: [{ modelNo: "AR-013A2" }],
      },
    ]);
    const p = await preview();
    expect(p.plan.entries.find((e) => e.productNo === 76)!.status).toBe(
      "blocked",
    );
    await ProductModel.deleteOne({ _id: b!._id });
    const result = await commitImportBatch(ACTOR, commitInput(p));
    expect(result).toMatchObject({
      ok: false,
      errors: { formErrors: [PREVIEW_AGAIN] },
    });
    const saved = await ProductModel.findById(a!._id).lean();
    expect(saved!.variants.map((v) => v.modelNo)).toEqual(["AR-013A1"]);
  });

  it("documents: a replayed create batch re-creates a product deleted after the commit", async () => {
    // A create's entry hash holds no database state, so the same preview can
    // re-create it while the staged file exists (finishImport deletes it).
    const p = await preview();
    await commitOk(p);
    await ProductModel.deleteOne({ productNo: 77 });
    const again = await commitOk(p);
    expect(again.data.summary.created).toBe(1);
    expect(await ProductModel.countDocuments({ productNo: 77 })).toBe(1);
  });

  it("documents: etag null skips the If-Match pin (the sheet hash still binds the content)", async () => {
    const p = await preview();
    vi.mocked(storage.getImportBytes).mockClear();
    await commitImportBatch(ACTOR, { ...commitInput(p), etag: null });
    expect(storage.getImportBytes).toHaveBeenCalledWith(KEY, {});
  });

  it("two concurrent commits of one batch create each product once", async () => {
    const p = await preview();
    const [first, second] = await Promise.all([
      commitImportBatch(ACTOR, commitInput(p)),
      commitImportBatch(ACTOR, commitInput(p)),
    ]);
    expect(first.ok && second.ok).toBe(true);
    expect(await ProductModel.countDocuments()).toBe(3);
    // Every upload is either referenced by a saved product or destroyed.
    const uploaded = (
      await Promise.all(
        vi
          .mocked(cloudinary.uploadImageBuffer)
          .mock.results.map((r) => r.value),
      )
    ).flatMap((r: { ok: boolean; image?: { publicId: string } }) =>
      r.ok && r.image ? [r.image.publicId] : [],
    );
    const referenced = new Set(
      (await snapshot()).flatMap((doc) => doc.images.map((i) => i.publicId)),
    );
    const destroyed = new Set(
      vi.mocked(cloudinary.destroyImage).mock.calls.map(([id]) => id),
    );
    for (const id of uploaded) {
      expect(referenced.has(id) || destroyed.has(id)).toBe(true);
    }
  });
});

describe("gate B: update writes only sheet-owned paths", () => {
  it("every PlanTarget has exactly the sheet + identity keys, never an admin field", async () => {
    const created = await preview();
    await commitOk(created);
    stageFile(await templateWith(withRow(1, { "Lumen Output": "1250 LM" })));
    const updated = await preview();
    for (const entry of [...created.plan.entries, ...updated.plan.entries]) {
      if (entry.target === null) continue;
      expect(Object.keys(entry.target).sort()).toEqual(PLAN_TARGET_KEYS);
      for (const v of entry.target.variants) {
        expect(Object.keys(v).sort()).toEqual([
          "imagePublicId",
          "imageSha256",
          "isNew",
          "label",
          "modelNo",
          "specs",
        ]);
      }
    }
  });

  it("$set / $unset touch only sheet-owned paths and $push only images", async () => {
    await commitOk(await preview());
    await ProductModel.updateOne(
      { productNo: 76 },
      {
        $set: {
          name: "Admin name",
          slug: "admin-slug",
          status: "published",
          description: "Admin",
          featured: true,
        },
      },
    );
    // Lumen changes, the family is cleared, a new picture is added.
    stageFile(
      await templateWith(
        golden().map((r, i) =>
          i === 0
            ? {
                row: { ...r.row, "Lumen Output": "1", "Model Name": "-" },
                picture: 2,
              }
            : i === 1
              ? { ...r, row: { ...r.row, "Model Name": "-" } }
              : r,
        ),
      ),
    );
    const p = await preview();
    expect(p.plan.entries.find((e) => e.productNo === 76)!.status).toBe(
      "update",
    );
    const spy = vi.spyOn(ProductModel, "updateOne");
    try {
      await commitOk(p);
      expect(spy).toHaveBeenCalled();
      for (const [filter, ops, options] of spy.mock.calls) {
        expect(Object.keys(filter as object).sort()).toEqual([
          "_id",
          "updatedAt",
        ]);
        expect(options).toEqual({ runValidators: true });
        const record = ops as Record<string, Record<string, unknown>>;
        for (const op of Object.keys(record)) {
          expect(["$set", "$unset", "$push"]).toContain(op);
        }
        for (const path of [
          ...Object.keys(record.$set ?? {}),
          ...Object.keys(record.$unset ?? {}),
        ]) {
          expect(SHEET_OWNED_PATHS.has(path)).toBe(true);
        }
        expect(Object.keys(record.$push ?? {})).toEqual(
          record.$push ? ["images"] : [],
        );
      }
    } finally {
      spy.mockRestore();
    }
    const arc = await ProductModel.findOne({ productNo: 76 }).lean();
    expect(arc).toMatchObject({
      name: "Admin name",
      slug: "admin-slug",
      status: "published",
      description: "Admin",
      featured: true,
    });
    expect(arc!.family).toBeUndefined();
  });

  it("creates only drafts, whatever the sheet says", async () => {
    stageFile(await templateWith(withRow(2, { "Model Type": "published" })));
    const spy = vi.spyOn(ProductModel, "create");
    try {
      await commitOk(await preview());
      for (const [doc] of spy.mock.calls) {
        const record = doc as Record<string, unknown>;
        expect(record.status).toBe("draft");
        for (const key of [
          "description",
          "extraSpecs",
          "publicFiles",
          "datasheetId",
          "featured",
        ]) {
          expect(record).not.toHaveProperty(key);
        }
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("gate B: restricted values and audit content", () => {
  it("restricted values never reach the audit log, server logs or tags, even on failures", async () => {
    const logs: string[] = [];
    const capture = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    };
    const spies = (["error", "warn", "log", "info", "debug"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(capture),
    );
    const realCreate = ProductModel.create.bind(ProductModel);
    const create = vi.spyOn(ProductModel, "create").mockImplementation(((
      doc: Record<string, unknown>,
    ) => {
      if (doc.productNo === 77) {
        // A driver error that quotes the document, like a real one can.
        return Promise.reject(
          Object.assign(new Error(`QA-LEAK ${JSON.stringify(doc)}`), {
            name: "MongoServerError",
          }),
        );
      }
      return realCreate(doc);
    }) as unknown as typeof ProductModel.create);
    try {
      const result = await commitOk(await preview());
      expect(result.data.summary).toMatchObject({ created: 2, failed: 1 });
      const audits = await AuditLogModel.find({}).lean();
      const haystack = [
        JSON.stringify(audits),
        JSON.stringify(result.tags),
        ...logs,
      ].join("\n");
      for (const value of RESTRICTED_VALUES) {
        expect(haystack).not.toContain(value);
      }
      expect(logs.join("\n")).not.toContain("QA-LEAK");
    } finally {
      create.mockRestore();
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("audit meta holds counts and product ids only", async () => {
    await commitOk(await preview());
    const audit = await AuditLogModel.findOne({}).lean();
    expect(audit).toMatchObject({
      action: "import.commit",
      target: { type: "import", id: importIdFromKey(KEY) },
    });
    const meta = audit!.meta as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(
      [
        "batch",
        "blocked",
        "created",
        "failed",
        "imagesAdded",
        "productIds",
        "unchanged",
        "updated",
        "variantsRemoved",
      ].sort(),
    );
    for (const [key, value] of Object.entries(meta)) {
      if (key === "productIds") {
        for (const id of value as string[]) {
          expect(id).toMatch(/^[0-9a-f]{24}$/);
        }
      } else {
        expect(typeof value).toBe("number");
      }
    }
  });

  it("tags are catalog tags and product ids only", async () => {
    const { tags } = await commitOk(await preview());
    for (const tag of tags) {
      expect(tag).toMatch(/^(products|categories|areas|product:[0-9a-f]{24})$/);
    }
  });

  it("reads the visibility setting once per plan, not once per product", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      row: {
        "NO.": i + 1,
        "Model Name": "Beam",
        "Model No.": `QB-${String(i + 1).padStart(3, "0")}A1`,
        Wattage: "12W",
        CCT: "3000K",
      } as TemplateRow,
    }));
    stageFile(await templateWith(rows));
    const probe = vi.mocked(adminProducts.withoutRestrictedFilters);
    probe.mockClear();
    const p = await preview();
    expect(p.plan.entries).toHaveLength(30);
    expect(probe).toHaveBeenCalledTimes(1);
    probe.mockClear();
    await commitOk(p, 0);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("gate B: uploads kept or destroyed", () => {
  it("a product whose second upload fails destroys its first and writes nothing", async () => {
    // Arc: two variants with different pictures (0 and 2), so two uploads.
    stageFile(
      await templateWith(
        golden().map((r, i) => (i === 1 ? { ...r, picture: 2 } : r)),
      ),
    );
    const failSha = sha256(pictures[2]!);
    const madeFor = new Map<string, string[]>();
    vi.mocked(cloudinary.uploadImageBuffer).mockImplementation(
      async (productId, data) => {
        if (sha256(data) === failSha) {
          return { ok: false, reason: "unavailable" };
        }
        const done = okUpload(productId, data);
        madeFor.set(productId, [
          ...(madeFor.get(productId) ?? []),
          done.image.publicId,
        ]);
        return done;
      },
    );
    const { data } = await commitOk(await preview());
    const arc = data.products.find((x) => x.productNo === 76)!;
    expect(arc.status).toBe("failed");
    expect(await ProductModel.countDocuments({ productNo: 76 })).toBe(0);
    // Every copy made for a product that was not written is destroyed.
    const saved = new Set(
      (await snapshot()).map((doc) => doc._id.toHexString()),
    );
    const destroyed = vi
      .mocked(cloudinary.destroyImage)
      .mock.calls.map(([id]) => id);
    for (const [productId, ids] of madeFor) {
      if (saved.has(productId)) continue;
      for (const id of ids) expect(destroyed).toContain(id);
    }
  });

  it("a copy whose stored hash is not the planned picture is destroyed", async () => {
    let wrong = "";
    vi.mocked(cloudinary.uploadImageBuffer).mockImplementation(
      async (productId, data) => {
        const done = okUpload(productId, data);
        if (wrong === "") {
          wrong = done.image.publicId;
          done.image.sourceSha256 = "0".repeat(64);
        }
        return done;
      },
    );
    const { data } = await commitOk(await preview());
    expect(data.summary.failed).toBe(1);
    expect(cloudinary.destroyImage).toHaveBeenCalledWith(wrong);
    const referenced = (await snapshot()).flatMap((d) =>
      d.images.map((i) => i.publicId),
    );
    expect(referenced).not.toContain(wrong);
  });

  it("a saved product at the 30-image cap gets no upload", async () => {
    await commitOk(await preview());
    const arc = await ProductModel.findOne({ productNo: 76 }).lean();
    const id = arc!._id.toHexString();
    await ProductModel.updateOne(
      { _id: arc!._id },
      {
        $set: {
          images: Array.from({ length: MAX_PRODUCT_IMAGES }, (_, n) => ({
            publicId: testPublicId(n + 1, id),
            order: n,
            kind: "gallery",
          })),
        },
      },
    );
    stageFile(await templateWith(withRow(0, {}, 2)));
    const p = await preview();
    expect(p.plan.entries.find((e) => e.productNo === 76)!.imagesToAdd).toEqual(
      [],
    );
    vi.mocked(cloudinary.uploadImageBuffer).mockClear();
    await commitOk(p);
    const calls = vi
      .mocked(cloudinary.uploadImageBuffer)
      .mock.calls.filter(([productId]) => productId === id);
    expect(calls).toEqual([]);
    const after = await ProductModel.findById(arc!._id).lean();
    expect(after!.images).toHaveLength(MAX_PRODUCT_IMAGES);
  });
});

describe("gate B: staged key and commit input", () => {
  it("refuses keys that are not exactly imports/<lowercase uuid v4>.xlsx", () => {
    const uuid = "00000000-0000-4000-8000-0000000000b1";
    const bad = [
      `imports/${uuid}.xlsx\n`,
      `imports/${uuid.toUpperCase()}.xlsx`,
      `imports/00000000-0000-1000-8000-0000000000b1.xlsx`,
      `imports/../datasheets/${uuid}.xlsx`,
      `imports//${uuid}.xlsx`,
      `imports/${uuid}.XLSX`,
      `imports/${uuid}.xlsx.xlsx`,
      `imports/${uuid}xlsx`,
      ` imports/${uuid}.xlsx`,
      `incoming/${uuid}.xlsx`,
    ];
    for (const key of bad) {
      expect(importKeySchema.safeParse(key).success, key).toBe(false);
      expect(importIdFromKey(key), key).toBeNull();
    }
    expect(importKeySchema.safeParse(`imports/${uuid}.xlsx`).success).toBe(
      true,
    );
  });

  it("refuses more entry hashes than MAX_IMPORT_PLAN_ENTRIES and non-hex hashes", () => {
    const base = {
      key: KEY,
      defaultCategoryId: new ObjectId().toHexString(),
      etag: ETAG,
      planHash: "a".repeat(64),
      batch: 0,
      acknowledgeRemovals: false,
    };
    expect(
      commitImportInputSchema.safeParse({
        ...base,
        entryHashes: Array(MAX_IMPORT_PLAN_ENTRIES + 1).fill("a".repeat(64)),
      }).success,
    ).toBe(false);
    expect(
      commitImportInputSchema.safeParse({
        ...base,
        entryHashes: ["A".repeat(64)],
      }).success,
    ).toBe(false);
    expect(
      commitImportInputSchema.safeParse({
        ...base,
        entryHashes: ["a".repeat(64)],
        batch: 1,
      }).success,
    ).toBe(false);
    expect(
      commitImportInputSchema.safeParse({
        ...base,
        entryHashes: ["a".repeat(64)],
        batch: { $gt: -1 },
      }).success,
    ).toBe(false);
  });

  it("the imports sweep never selects anything outside imports/", () => {
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    const selected = selectStaleImports(
      [
        { key: "imports/", lastModified: old },
        { key: "imports", lastModified: old },
        { key: "importsx/a.xlsx", lastModified: old },
        { key: "datasheets/imports/a.xlsx", lastModified: old },
        { key: `imports/${IMPORT_ID}.xlsx`, lastModified: old },
        { key: `imports/${IMPORT_ID}.xlsx`, lastModified: undefined },
        { key: `imports/${IMPORT_ID}.xlsx`, lastModified: new Date() },
      ],
      new Date(),
    );
    expect(selected).toEqual([`imports/${IMPORT_ID}.xlsx`]);
  });
});

describe("gate B: plan size caps (DoS)", () => {
  const COUNT = MAX_IMPORT_PLAN_ENTRIES + 1;
  let big: Buffer;

  beforeAll(async () => {
    big = await templateWith(
      Array.from({ length: COUNT }, (_, i) => ({
        row: {
          "NO.": i + 1,
          "Model Name": "Beam",
          "Model No.": `DX-${String(i + 1).padStart(5, "0")}A1`,
          Wattage: "12W",
        } as TemplateRow,
      })),
    );
  }, 120_000);

  it("M-1: the preview refuses a file with more products than a commit accepts", async () => {
    stageFile(big);
    const started = Date.now();
    const result = await previewImport({
      key: KEY,
      defaultCategoryId: defaultCategory,
    });
    console.info(
      `[gate B] preview of ${COUNT} products: ${Date.now() - started} ms, ${big.byteLength} bytes`,
    );
    // Either refused outright, or a plan the commit can take.
    if (result.ok && result.data.kind === "plan") {
      expect(result.data.plan.entries.length).toBeLessThanOrEqual(
        MAX_IMPORT_PLAN_ENTRIES,
      );
    } else {
      expect(result.ok).toBe(true);
    }
  }, 180_000);

  it("each commit batch re-parses the whole file (cost per batch, for the report)", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      row: {
        "NO.": i + 1,
        "Model Name": "Beam",
        "Model No.": `CX-${String(i + 1).padStart(4, "0")}A1`,
        Wattage: "12W",
      } as TemplateRow,
    }));
    stageFile(await templateWith(rows));
    const p = await preview();
    expect(p.plan.entries).toHaveLength(500);
    const started = Date.now();
    await commitOk(p, 24);
    console.info(
      `[gate B] last batch of a 500-product file: ${Date.now() - started} ms (${Math.ceil(500 / IMPORT_BATCH_SIZE)} batches)`,
    );
  }, 120_000);
});

describe("gate B: controlled template open items (ADR 0059)", () => {
  async function comments(): Promise<Map<string, string>> {
    const zip = await JSZip.loadAsync(
      await buildImportTemplate(TEMPLATE_INPUT),
    );
    const xml = await zip.file("xl/comments1.xml")!.async("string");
    const out = new Map<string, string>();
    for (const [, ref, body] of xml.matchAll(
      /<comment ref="([A-Z]+1)"[^>]*>([\s\S]*?)<\/comment>/g,
    )) {
      const text = [...body!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
        .map((m) => m[1])
        .join("");
      out.set(ref!, text);
    }
    return out;
  }

  it("L-1: the Image note does not suggest Place in Cell (stored as richData, not imported)", async () => {
    const notes = [...(await comments()).values()].join("\n");
    expect(notes).not.toMatch(/place in cell/i);
  });

  it("L-2: every header note fits its comment box (no clipped text on hover)", async () => {
    const zip = await JSZip.loadAsync(
      await buildImportTemplate(TEMPLATE_INPUT),
    );
    const vml = await zip.file(/vmlDrawing\d+\.vml$/)[0]!.async("string");
    const sizes = [...vml.matchAll(/width:([\d.]+)pt;height:([\d.]+)pt/g)].map(
      (m) => ({ width: Number(m[1]), height: Number(m[2]) }),
    );
    const longest = Math.max(
      ...[...(await comments()).values()].map((t) => t.length),
    );
    // Excel/WPS comment default: ~9pt Tahoma, ~5pt per character, ~12pt a line.
    for (const { width, height } of sizes) {
      const capacity = Math.floor(width / 5) * Math.floor(height / 12);
      expect(capacity).toBeGreaterThanOrEqual(longest);
    }
  });

  it("L-3: a renamed area column warns once (unknown_area), not once per row", async () => {
    const template = await buildImportTemplate({
      ...TEMPLATE_INPUT,
      areas: [...TEMPLATE_INPUT.areas, { name: "Gone Area" }],
    });
    const rows = Array.from({ length: 5 }, (_, i) => ({
      row: {
        "NO.": i + 1,
        "Model Name": "Beam",
        "Model No.": `UA-${i + 1}`,
        "Area: Gone Area": "Yes",
      } as TemplateRow,
    }));
    const file = await fillTemplate(template, rows);
    const check = await checkImportFile(new Uint8Array(file));
    if (!check.ok) throw new Error(check.reason);
    const read = await readWorkbook(check.file);
    if (!read.ok) throw new Error("not read");
    const grouped = groupRows(read.rows.map(cleanRow), {
      categories: TEMPLATE_INPUT.categories,
      areas: TEMPLATE_INPUT.areas,
      defaultCategoryId: "c-spot",
    });
    const all = [
      ...grouped.warnings,
      ...grouped.products.flatMap((p) => p.warnings),
    ].filter((w) => w.code === "unknown_area");
    expect(all).toHaveLength(1);
  });

  it("names that look like formulas stay plain text in the template", async () => {
    const zip = await JSZip.loadAsync(
      await buildImportTemplate({
        categories: [
          { id: "x", name: '=HYPERLINK("http://x","y")', parentId: null },
        ],
        areas: [{ name: "=1+1" }],
      }),
    );
    for (const name of Object.keys(zip.files)) {
      if (!name.startsWith("xl/worksheets/sheet")) continue;
      const xml = await zip.file(name)!.async("string");
      expect(xml, name).not.toMatch(/<f[ >]/);
    }
  });
});
