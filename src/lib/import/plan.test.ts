// Tests for the import plan / preview (Phase 3 T7, ADR 0057) on an in-memory
// MongoDB: create / update / unchanged / blocked, conflicts, field ownership,
// restricted filters, the plan hash, and that previewImport writes nothing.
// R2 is mocked (getImportBytes returns the fixture bytes).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { mongoose } from "@/lib/db";
import {
  DEFAULT_COLUMN_VISIBILITY,
  SETTINGS_KEYS,
} from "@/lib/schemas/settings";
import * as storage from "@/lib/storage";
import {
  AreaModel,
  CategoryModel,
  ProductModel,
  SiteContentModel,
} from "@/models";
import { AuditLogModel } from "@/models/audit-log";

import { buildFixture } from "../../../test/fixtures/import/build";
import { goldenTemplateFile } from "../../../test/fixtures/import/template-fixture";
import { setupMemoryDb } from "../../../test/helpers/memory-db";
import { testPublicId } from "../../../test/helpers/public-ids";
import { DEFAULT_CATEGORY_GONE, previewImport, type ImportPreview } from ".";
import { filtersFromSpecs } from "./numbers";
import { planHash } from "./plan";
import type { ImportProduct, PlanEntry, PlanTarget } from "./types";

vi.mock("@/lib/storage", () => ({
  getImportBytes: vi.fn(),
  deleteImportUpload: vi.fn(),
  presignImportUpload: vi.fn(),
}));

setupMemoryDb("yg_import_plan_test");

const { ObjectId } = mongoose.Types;
const KEY = "imports/00000000-0000-4000-8000-000000000001.xlsx";
const ETAG = '"etag-1"';

let defaultCategory: string; // "Default" main category
let spotRecessed: string; // Spot Lights > Recessed
let recessedSpot: string; // Recessed Lights > Spot
let residential: string;
let retail: string;

let templateBytes: Buffer;
let fixtureBytes: Buffer;

beforeAll(async () => {
  await ProductModel.createIndexes();
  templateBytes = await goldenTemplateFile();
  fixtureBytes = await buildFixture();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await Promise.all([
    ProductModel.deleteMany({}),
    CategoryModel.deleteMany({}),
    AreaModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
    SiteContentModel.deleteMany({}),
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
  const [a, b] = await CategoryModel.create([
    { name: "Recessed", slug: "recessed", parent: spot?._id, order: 0 },
    { name: "Spot", slug: "spot", parent: rec?._id, order: 0 },
  ]);
  defaultCategory = d!._id.toHexString();
  spotRecessed = a!._id.toHexString();
  recessedSpot = b!._id.toHexString();
  const [res, ret] = await AreaModel.create([
    { name: "Residential", slug: "residential", order: 0 },
    { name: "Retail", slug: "retail", order: 1 },
    { name: "Hospitality", slug: "hospitality", order: 2 },
  ]);
  residential = res!._id.toHexString();
  retail = ret!._id.toHexString();
  useFile(templateBytes);
});

function useFile(bytes: Uint8Array, etag: string | undefined = ETAG): void {
  vi.mocked(storage.getImportBytes).mockResolvedValue({
    ok: true,
    bytes: new Uint8Array(bytes),
    etag,
  });
}

async function preview(
  input: unknown = { key: KEY, defaultCategoryId: defaultCategory },
): Promise<Extract<ImportPreview, { kind: "plan" }>> {
  const result = await previewImport(input);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  expect(result.tags).toEqual([]);
  // the picture bytes stay on the server
  expect(result.data).not.toHaveProperty("files");
  if (result.data.kind !== "plan") {
    throw new Error(JSON.stringify(result.data.warnings));
  }
  return result.data;
}

function entryOf(
  data: Extract<ImportPreview, { kind: "plan" }>,
  productNo: number,
): PlanEntry {
  const entry = data.plan.entries.find((e) => e.productNo === productNo);
  if (!entry) throw new Error(`no entry for NO. ${productNo}`);
  return entry;
}

function targetOf(entry: PlanEntry): PlanTarget {
  if (entry.target === null) throw new Error("entry has no target");
  return entry.target;
}

/*
 * Saves a planned product the way the commit (T8) will: the target's
 * sheet-owned fields, new pictures with their sourceSha256, labels as
 * planned. Used to prove that the same file then plans as "unchanged".
 */
async function saveAsCommitWould(
  entry: PlanEntry,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const t = targetOf(entry);
  const id = new ObjectId();
  await ProductModel.create({
    _id: id,
    name: t.name,
    slug: t.slug,
    status: "draft",
    ...(t.family === null ? {} : { family: t.family }),
    ...(t.type === null ? {} : { type: t.type }),
    ...(t.productNo === null ? {} : { productNo: t.productNo }),
    modelCode: t.modelCode,
    specs: t.specs,
    filters: t.filters,
    variants: t.variants.map((v) => ({
      modelNo: v.modelNo,
      label: v.label,
      ...(Object.keys(v.specs).length === 0 ? {} : { specs: v.specs }),
    })),
    mainCategory: new ObjectId(t.mainCategory),
    extraCategories: t.extraCategories.map((c) => new ObjectId(c)),
    areas: t.areas.map((a) => new ObjectId(a)),
    ...(t.trackSize === null ? {} : { trackSize: t.trackSize }),
    images: entry.imagesToAdd.map((ref, order) => ({
      publicId: testPublicId(order, id.toHexString()),
      order,
      kind: "gallery",
      sourceSha256: ref.sha256,
    })),
    ...extra,
  });
  return id.toHexString();
}

describe("previewImport: input checks", () => {
  it("refuses a key that is not a staged import key", async () => {
    const result = await previewImport({
      key: "datasheets/x.xlsx",
      defaultCategoryId: defaultCategory,
    });
    expect(result.ok).toBe(false);
    expect(storage.getImportBytes).not.toHaveBeenCalled();
  });

  it("refuses unknown fields (strict input)", async () => {
    const result = await previewImport({
      key: KEY,
      defaultCategoryId: defaultCategory,
      extra: 1,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a default category that does not exist", async () => {
    const result = await previewImport({
      key: KEY,
      defaultCategoryId: new ObjectId().toHexString(),
    });
    expect(result).toMatchObject({
      ok: false,
      errors: { fieldErrors: { defaultCategoryId: [DEFAULT_CATEGORY_GONE] } },
    });
    expect(storage.getImportBytes).not.toHaveBeenCalled();
  });

  it("says when the staged file is gone", async () => {
    vi.mocked(storage.getImportBytes).mockResolvedValue({
      ok: false,
      reason: "not_found",
    });
    const result = await previewImport({
      key: KEY,
      defaultCategoryId: defaultCategory,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.formErrors[0]).toMatch(/Upload it again/);
  });

  it("returns the fatal warnings for a file that is not an .xlsx", async () => {
    useFile(new TextEncoder().encode("not a workbook at all"));
    const result = await previewImport({
      key: KEY,
      defaultCategoryId: defaultCategory,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.kind).toBe("refused");
      if (result.data.kind === "refused") {
        expect(result.data.warnings.map((w) => w.severity)).toEqual(["fatal"]);
      }
    }
  });
});

describe("previewImport: create", () => {
  it("plans the golden template as three new drafts with the ETag", async () => {
    const data = await preview();
    expect(data.etag).toBe(ETAG);
    expect(data.plan.summary).toMatchObject({
      create: 3,
      update: 0,
      unchanged: 0,
      blocked: 0,
      variantsRemoved: 0,
    });
    expect(data.plan.planHash).toMatch(/^[0-9a-f]{64}$/);

    const arc = entryOf(data, 76);
    expect(arc.status).toBe("create");
    expect(arc.existing).toBeNull();
    const t = targetOf(arc);
    expect([t.name, t.slug, t.family, t.modelCode]).toEqual([
      "Arc AR-013A",
      "arc-ar-013a",
      "Arc",
      "AR-013A",
    ]);
    expect(t.mainCategory).toBe(spotRecessed);
    expect(t.extraCategories).toEqual([recessedSpot]);
    expect(t.areas).toEqual([residential, retail]);
    expect(t.variants.map((v) => [v.modelNo, v.label, v.isNew])).toEqual([
      ["AR-013A1", "Regular Lens", true],
      ["AR-013A2", "High Efficiency Reflector", true],
    ]);
    expect(t.variants.map((v) => v.specs.lumenOutput)).toEqual([
      ["1140 LM"],
      ["1200 LM"],
    ]);
    expect(t.filters).toMatchObject({ cctK: [3000, 4000], wattage: [12] });
    expect(arc.imagesToAdd).toHaveLength(1);
    expect(arc.changes).toEqual([]);
  });

  it("makes a taken slug unique and never reuses one inside the plan", async () => {
    await ProductModel.create({
      name: "Someone else",
      slug: "arc-ar-013a",
      mainCategory: new ObjectId(defaultCategory),
      variants: [{ modelNo: "OTHER-1" }],
    });
    const t = targetOf(entryOf(await preview(), 76));
    expect(t.slug).toBe("arc-ar-013a-2");
  });

  it("uses the default category when the sheet has no Category column", async () => {
    useFile(fixtureBytes);
    const t = targetOf(entryOf(await preview(), 76));
    expect(t.mainCategory).toBe(defaultCategory);
    expect(t.extraCategories).toEqual([]);
    expect(t.areas).toEqual([]);
  });
});

describe("previewImport: unchanged and update", () => {
  it("plans the same file as unchanged once it is saved as planned", async () => {
    const first = await preview();
    for (const entry of first.plan.entries) await saveAsCommitWould(entry);

    const second = await preview();
    expect(second.plan.summary).toMatchObject({
      create: 0,
      update: 0,
      unchanged: 3,
      blocked: 0,
      imagesToAdd: 0,
    });
    for (const entry of second.plan.entries) {
      expect(entry.changes).toEqual([]);
      expect(entry.imagesToAdd).toEqual([]);
    }
  });

  it("matches model nos. case-insensitively and keeps the sheet's text", async () => {
    const entry = entryOf(await preview(), 76);
    await saveAsCommitWould(entry, {
      variants: [
        {
          modelNo: "ar-013a1",
          label: "Regular Lens",
          specs: {
            lumenOutput: ["1140 LM"],
            lumenEfficiency: ["95"],
            lens: ["Regular Lens"],
          },
        },
        {
          modelNo: "ar-013a2",
          label: "High Efficiency Reflector",
          specs: {
            lumenOutput: ["1200 LM"],
            lumenEfficiency: ["100"],
            reflector: ["High Efficiency Reflector"],
          },
        },
      ],
    });
    const again = entryOf(await preview(), 76);
    expect(again.status).toBe("update");
    expect(targetOf(again).variants.map((v) => [v.modelNo, v.isNew])).toEqual([
      ["AR-013A1", false],
      ["AR-013A2", false],
    ]);
    expect(again.changes.map((c) => c.field)).toEqual([
      "variants.AR-013A1.modelNo",
      "variants.AR-013A2.modelNo",
    ]);
  });

  it("updates sheet-owned fields and leaves admin-owned ones alone", async () => {
    const entry = entryOf(await preview(), 76);
    const datasheetId = new ObjectId();
    const id = await saveAsCommitWould(entry, {
      name: "Arc by the admin",
      slug: "arc-custom",
      status: "published",
      description: "Written by the admin",
      featured: true,
      datasheetId,
      extraSpecs: [{ label: "Note", value: "Admin" }],
      publicFiles: [{ label: "Guide", url: "https://example.com/g.pdf" }],
      family: "Old family",
      specs: { ...targetOf(entry).specs, wattage: ["10W"] },
      variants: [
        {
          modelNo: "AR-013A1",
          label: "Admin label",
          specs: {
            lumenOutput: ["1000 LM"],
            lumenEfficiency: ["95"],
            lens: ["Regular Lens"],
          },
          imagePublicId: undefined,
        },
        {
          modelNo: "AR-013A2",
          label: "High Efficiency Reflector",
          specs: {
            lumenOutput: ["1200 LM"],
            lumenEfficiency: ["100"],
            reflector: ["High Efficiency Reflector"],
          },
        },
      ],
    });
    const before = await ProductModel.findById(id).lean();

    const update = entryOf(await preview(), 76);
    expect(update.status).toBe("update");
    expect(update.existing).toMatchObject({
      id,
      slug: "arc-custom",
      name: "Arc by the admin",
      status: "published",
    });
    const t = targetOf(update);
    // create-only fields are the saved ones; labels set by the admin stay
    expect([t.name, t.slug]).toEqual(["Arc by the admin", "arc-custom"]);
    expect(t.variants[0]?.label).toBe("Admin label");
    // sheet-owned fields come from the sheet
    expect(t.family).toBe("Arc");
    expect(t.specs.wattage).toEqual(["12W"]);
    expect(t.variants[0]?.specs.lumenOutput).toEqual(["1140 LM"]);
    // the target carries no admin-owned field at all
    for (const field of [
      "description",
      "featured",
      "datasheetId",
      "extraSpecs",
      "publicFiles",
      "status",
      "images",
    ]) {
      expect(t).not.toHaveProperty(field);
    }
    expect(update.changes.map((c) => c.field)).toEqual([
      "family",
      "specs.wattage",
      "variants.AR-013A1.specs.lumenOutput",
    ]);
    expect(update.changes[0]).toMatchObject({
      label: "Model Name",
      before: "Old family",
      after: "Arc",
    });
    // and the preview wrote nothing
    expect(await ProductModel.findById(id).lean()).toEqual(before);
  });

  it("keeps saved categories and areas when the sheet has no such columns", async () => {
    useFile(fixtureBytes);
    const entry = entryOf(await preview(), 76);
    await saveAsCommitWould(entry, {
      mainCategory: new ObjectId(spotRecessed),
      extraCategories: [new ObjectId(recessedSpot)],
      areas: [new ObjectId(retail)],
    });
    const again = entryOf(await preview(), 76);
    expect(again.status).toBe("unchanged");
    const t = targetOf(again);
    expect(t.mainCategory).toBe(spotRecessed);
    expect(t.extraCategories).toEqual([recessedSpot]);
    expect(t.areas).toEqual([retail]);
  });

  it("overwrites saved categories and areas when the template sets them", async () => {
    const entry = entryOf(await preview(), 76);
    await saveAsCommitWould(entry, {
      mainCategory: new ObjectId(defaultCategory),
      extraCategories: [],
      areas: [new ObjectId(retail)],
    });
    const again = entryOf(await preview(), 76);
    expect(again.status).toBe("update");
    const t = targetOf(again);
    expect(t.mainCategory).toBe(spotRecessed);
    expect(t.extraCategories).toEqual([recessedSpot]);
    expect(t.areas).toEqual([residential, retail]);
    expect(again.changes.map((c) => c.field)).toEqual([
      "mainCategory",
      "extraCategories",
      "areas",
    ]);
  });

  it("drops a saved trackSize when the sheet moves the product out of Magnetic Track", async () => {
    const track = await CategoryModel.create({
      name: "Magnetic Track",
      slug: "magnetic-track",
      parent: null,
      order: 9,
    });
    const track10 = await CategoryModel.create({
      name: "10mm",
      slug: "10mm",
      parent: track._id,
      order: 0,
    });
    const entry = entryOf(await preview(), 76);
    await saveAsCommitWould(entry, {
      mainCategory: track10._id,
      extraCategories: [],
      trackSize: 10,
    });
    const again = entryOf(await preview(), 76);
    expect(again.status).toBe("update");
    expect(targetOf(again).mainCategory).toBe(spotRecessed);
    expect(targetOf(again).trackSize).toBeNull();
    expect(again.changes.map((c) => c.field)).toContain("trackSize");
  });

  it("keeps an admin trackSize while the product stays under Magnetic Track", async () => {
    const track = await CategoryModel.create({
      name: "Magnetic Track",
      slug: "magnetic-track",
      parent: null,
      order: 9,
    });
    useFile(fixtureBytes); // no Category column: the saved category stays
    const entry = entryOf(await preview(), 76);
    await saveAsCommitWould(entry, { mainCategory: track._id, trackSize: 20 });
    const again = entryOf(await preview(), 76);
    expect(again.status).toBe("unchanged");
    expect(targetOf(again).trackSize).toBe(20);
  });

  it("keeps the saved order of areas holding the same set", async () => {
    const entry = entryOf(await preview(), 76);
    await saveAsCommitWould(entry, {
      areas: [new ObjectId(retail), new ObjectId(residential)],
    });
    const again = entryOf(await preview(), 76);
    expect(again.status).toBe("unchanged");
    expect(targetOf(again).areas).toEqual([retail, residential]);
  });

  it("lists saved variants missing from the sheet as removals", async () => {
    const entry = entryOf(await preview(), 76);
    const t = targetOf(entry);
    await saveAsCommitWould(entry, {
      variants: [
        ...t.variants.map((v) => ({
          modelNo: v.modelNo,
          label: v.label,
          specs: v.specs,
        })),
        { modelNo: "AR-013A3", label: "Gone" },
      ],
    });
    const again = entryOf(await preview(), 76);
    expect(again.status).toBe("update");
    expect(again.variantsRemoved).toEqual(["AR-013A3"]);
    expect(again.warnings.map((w) => w.code)).toContain("variant_removed");
  });

  it("adds only pictures the product does not hold yet", async () => {
    const entry = entryOf(await preview(), 76);
    const id = new ObjectId().toHexString();
    await saveAsCommitWould(entry, {
      images: [{ publicId: testPublicId(9, id), order: 0, kind: "gallery" }],
    });
    const again = entryOf(await preview(), 76);
    expect(again.status).toBe("update");
    expect(again.imagesToAdd.map((i) => i.sha256)).toEqual(
      entry.imagesToAdd.map((i) => i.sha256),
    );
    expect(again.changes.map((c) => c.field)).toEqual(["images"]);
  });
});

describe("previewImport: blocked", () => {
  it("blocks sheet errors (Nos. 80/81 have no model no.)", async () => {
    useFile(fixtureBytes);
    const data = await preview();
    for (const no of [80, 81]) {
      const entry = entryOf(data, no);
      expect(entry.status).toBe("blocked");
      expect(entry.target).toBeNull();
      expect(entry.warnings.map((w) => w.code)).toContain("missing_model_no");
    }
  });

  it("blocks a product whose model nos. belong to two saved products", async () => {
    await ProductModel.create([
      {
        name: "One",
        slug: "one",
        mainCategory: new ObjectId(defaultCategory),
        variants: [{ modelNo: "AR-013A1" }],
      },
      {
        name: "Two",
        slug: "two",
        mainCategory: new ObjectId(defaultCategory),
        variants: [{ modelNo: "ar-013a2" }],
      },
    ]);
    const entry = entryOf(await preview(), 76);
    expect(entry.status).toBe("blocked");
    expect(entry.warnings.map((w) => w.code)).toContain("model_no_conflict");
  });

  it("blocks two sheet products that match the same saved product", async () => {
    await ProductModel.create({
      name: "Merged",
      slug: "merged",
      mainCategory: new ObjectId(defaultCategory),
      variants: [{ modelNo: "AR-013A1" }, { modelNo: "BM-001A1" }],
    });
    const data = await preview();
    for (const no of [76, 77]) {
      const entry = entryOf(data, no);
      expect(entry.status).toBe("blocked");
      expect(entry.warnings.map((w) => w.code)).toContain("model_no_conflict");
    }
    expect(entryOf(data, 78).status).toBe("create");
    expect(data.plan.summary).toMatchObject({ create: 1, blocked: 2 });
  });
});

describe("previewImport: restricted filters", () => {
  it("drops the filter numbers of restricted columns (I-2)", async () => {
    await SiteContentModel.create({
      key: SETTINGS_KEYS.columnVisibility,
      value: { ...DEFAULT_COLUMN_VISIBILITY, cct: "restricted" },
    });
    const t = targetOf(entryOf(await preview(), 76));
    expect(t.filters).not.toHaveProperty("cctK");
    expect(t.filters).toHaveProperty("wattage");
    // filtersFromSpecs alone ignores visibility: the plan's gate is what drops it
    expect(filtersFromSpecs([t.specs])).toHaveProperty("cctK");
  });
});

describe("plan hash", () => {
  it("is stable for the same file and database", async () => {
    expect((await preview()).plan.planHash).toBe(
      (await preview()).plan.planHash,
    );
  });

  it("changes when a matched product's updatedAt changes", async () => {
    const first = await preview();
    const id = await saveAsCommitWould(entryOf(first, 76));
    const before = await preview();
    expect(entryOf(before, 76).status).toBe("unchanged");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await ProductModel.updateOne(
      { _id: new ObjectId(id) },
      { $set: { description: "admin edit" } },
    );
    const after = await preview();
    expect(entryOf(after, 76).status).toBe("unchanged");
    expect(after.plan.planHash).not.toBe(before.plan.planHash);
  });

  it("changes when the restricted columns change", async () => {
    const before = (await preview()).plan.planHash;
    await SiteContentModel.create({
      key: SETTINGS_KEYS.columnVisibility,
      value: { ...DEFAULT_COLUMN_VISIBILITY, wattage: "restricted" },
    });
    expect((await preview()).plan.planHash).not.toBe(before);
  });

  it("covers images[].sha256 and variants[].imageSha256", async () => {
    const data = await preview();
    const products = data.plan.entries.map((e) => fakeProduct(e));
    const base = planHash(defaultCategory, products, data.plan.entries);
    const image = structuredClone(products);
    image[0]!.images = [{ sha256: "a".repeat(64), sheet: "Products", row: 2 }];
    const variant = structuredClone(products);
    variant[0]!.variants[0]!.imageSha256 = "b".repeat(64);
    expect(planHash(defaultCategory, image, data.plan.entries)).not.toBe(base);
    expect(planHash(defaultCategory, variant, data.plan.entries)).not.toBe(
      base,
    );
    expect(planHash(defaultCategory, products, data.plan.entries)).toBe(base);
  });
});

/* A minimal ImportProduct for the pure hash test. */
function fakeProduct(entry: PlanEntry): ImportProduct {
  return {
    sheet: entry.sheet,
    productNo: entry.productNo,
    rows: entry.rows,
    family: entry.family,
    type: null,
    baseModelCode: "",
    name: entry.name,
    slug: "",
    specs: {},
    variants: [
      {
        modelNo: "X-1",
        modelNoKey: "x-1",
        label: "X-1",
        specs: {},
        sheet: entry.sheet,
        row: entry.rows[0] ?? 2,
        imageSha256: null,
      },
    ],
    images: [],
    mainCategory: defaultCategory,
    mainCategoryFromSheet: false,
    extraCategories: [],
    extraCategoriesFromSheet: false,
    areas: [],
    areasFromSheet: false,
    trackSize: null,
    blocked: false,
    warnings: [],
  };
}

describe("previewImport writes nothing", () => {
  const WRITES =
    /^(insert|update|replace|delete|remove|bulkWrite|findOneAnd|findAndModify|create|drop|save)/i;

  it("issues only reads, writes no audit entry and touches no upload", async () => {
    // A saved product so the update path (and its diff) runs too.
    await saveAsCommitWould(entryOf(await preview(), 77), { family: "Old" });
    const products = await ProductModel.find({}).lean();
    const others = async () =>
      Promise.all([
        CategoryModel.find({}).lean(),
        AreaModel.find({}).lean(),
        SiteContentModel.find({}).lean(),
      ]);
    const othersBefore = await others();
    const methods: string[] = [];
    mongoose.set("debug", (_collection: string, method: string) => {
      methods.push(method);
    });
    try {
      const data = await preview();
      expect(data.plan.summary.update).toBe(1);
    } finally {
      mongoose.set("debug", false);
    }
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.filter((m) => WRITES.test(m))).toEqual([]);
    expect(await ProductModel.find({}).lean()).toEqual(products);
    expect(await others()).toEqual(othersBefore);
    expect(await AuditLogModel.countDocuments()).toBe(0);
    expect(storage.deleteImportUpload).not.toHaveBeenCalled();
    expect(storage.presignImportUpload).not.toHaveBeenCalled();
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
const realPresent = existsSync(realPath);

describe.skipIf(!realPresent)(
  "previewImport on the client's real sheet",
  () => {
    it("plans No. 76 as one product with two variants, then unchanged", async () => {
      useFile(readFileSync(realPath));
      const first = await preview();
      const arc = entryOf(first, 76);
      expect(arc.status).toBe("create");
      const t = targetOf(arc);
      expect([t.family, t.slug, t.modelCode]).toEqual([
        "Arc",
        "arc-ar-013a",
        "AR-013A",
      ]);
      expect(t.variants.map((v) => [v.modelNo, v.specs.lumenOutput])).toEqual([
        ["AR-013A1", ["1140 LM"]],
        ["AR-013A2", ["1200 LM"]],
      ]);
      expect(arc.imagesToAdd).toHaveLength(1);
      expect(first.plan.summary).toMatchObject({ create: 4, blocked: 2 });

      for (const entry of first.plan.entries) {
        if (entry.status === "create") await saveAsCommitWould(entry);
      }
      const second = await preview();
      expect(second.plan.summary).toMatchObject({
        create: 0,
        update: 0,
        unchanged: 4,
        blocked: 2,
      });
    });
  },
);
