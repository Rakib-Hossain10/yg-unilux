// QA gate B (Phase 2, T7-T10b): attacks and races against the product service
// that the feature tests do not make. The write-vs-read race for save, publish
// and unpublish, a save that only unsets fields, hostile public-file links,
// mass assignment, operator injection in list input, the audit entry holding
// no values, and no raw-HTML rendering anywhere in src/.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { mongoose } from "@/lib/db";
import { CategoryModel, ProductModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";
import {
  getProductForEdit,
  listProducts,
  PRODUCT_CHANGED,
  publishProduct,
  unpublishProduct,
  updateProduct,
} from "@/lib/admin/products";
import { testActor } from "./helpers/admin-actor";
import { setupMemoryDb } from "./helpers/memory-db";
import { testPublicId } from "./helpers/public-ids";

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: (await import("./helpers/admin-actor")).fakeSessionFromDb,
}));

setupMemoryDb("yg_admin_products_qa_test");

const { ObjectId } = mongoose.Types;
const admin = testActor();

let spot: string;
let productId: string;

beforeAll(async () => {
  await ProductModel.createIndexes();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    ProductModel.deleteMany({}),
    CategoryModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  const category = await CategoryModel.create({
    name: "Spot Lights",
    slug: "spot-lights",
    parent: null,
    order: 0,
  });
  spot = category._id.toHexString();
  const product = await ProductModel.create({
    name: "Fixture Lamp",
    slug: "fixture-lamp",
    mainCategory: category._id,
    status: "draft",
    description: "Old description",
    variants: [{ modelNo: "AR-013A1" }],
    images: [
      { publicId: testPublicId(0), alt: "a", order: 0, kind: "gallery" },
    ],
  });
  productId = product._id.toHexString();
});

async function loadedValues(changes: Record<string, unknown> = {}) {
  const loaded = await getProductForEdit(admin, productId);
  if (!loaded) throw new Error("fixture missing");
  return {
    values: { ...loaded.values, ...changes } as Record<string, unknown>,
    version: loaded.updatedAt,
  };
}

/* Runs `rival` the first time `target` is called, then the real method. */
function rivalOnFirstCall<T extends object>(
  target: T,
  method: keyof T & string,
  rival: () => Promise<unknown>,
) {
  const original = (target[method] as (...a: unknown[]) => unknown).bind(
    target,
  );
  let done = false;
  vi.spyOn(target, method as never).mockImplementation(((
    ...args: unknown[]
  ) => {
    if (done) return original(...args);
    done = true;
    // Make the rival write finish before the real call proceeds.
    return rival().then(() => original(...args));
  }) as never);
}

describe("race between the read and the write (ADR 0043)", () => {
  it("save: a write landing after the read is not overwritten", async () => {
    const { values, version } = await loadedValues({ name: "Mine" });
    // After the service's read, before its conditional write.
    rivalOnFirstCall(ProductModel, "updateOne", () =>
      ProductModel.collection.updateOne(
        { _id: new ObjectId(productId) },
        { $set: { name: "Theirs", updatedAt: new Date(Date.now() + 5000) } },
      ),
    );
    const result = await updateProduct(admin, productId, values, {
      expectedUpdatedAt: version,
    });
    expect(result).toMatchObject({ ok: false, tags: [] });
    expect((await ProductModel.findById(productId))?.name).toBe("Theirs");
    expect(await AuditLogModel.countDocuments()).toBe(0);
    expect(JSON.stringify(result)).toContain(PRODUCT_CHANGED);
  });

  it("publish: a write after the read refuses and leaves the draft", async () => {
    const { version } = await loadedValues();
    rivalOnFirstCall(ProductModel, "updateOne", () =>
      ProductModel.collection.updateOne(
        { _id: new ObjectId(productId) },
        { $set: { updatedAt: new Date(Date.now() + 5000) } },
      ),
    );
    const result = await publishProduct(admin, productId, {
      expectedUpdatedAt: version,
    });
    expect(result.ok).toBe(false);
    expect((await ProductModel.findById(productId))?.status).toBe("draft");
    expect(await AuditLogModel.countDocuments()).toBe(0);
  });

  it("unpublish: a write after the read refuses and leaves it published", async () => {
    await ProductModel.updateOne({ _id: productId }, { status: "published" });
    const { version } = await loadedValues();
    rivalOnFirstCall(ProductModel, "updateOne", () =>
      ProductModel.collection.updateOne(
        { _id: new ObjectId(productId) },
        { $set: { updatedAt: new Date(Date.now() + 5000) } },
      ),
    );
    const result = await unpublishProduct(admin, productId, {
      expectedUpdatedAt: version,
    });
    expect(result.ok).toBe(false);
    expect((await ProductModel.findById(productId))?.status).toBe("published");
  });

  it("an explicit undefined expectedUpdatedAt is refused, not treated as 'no check'", async () => {
    const { values } = await loadedValues({ name: "Sneaky" });
    const result = await updateProduct(admin, productId, values, {
      expectedUpdatedAt: undefined,
    });
    expect(result.ok).toBe(false);
    expect((await ProductModel.findById(productId))?.name).toBe("Fixture Lamp");
  });

  it("a save that only unsets a field still bumps updatedAt", async () => {
    const first = await loadedValues({ description: "" });
    const saved = await updateProduct(admin, productId, first.values, {
      expectedUpdatedAt: first.version,
    });
    expect(saved.ok).toBe(true);
    const doc = await ProductModel.findById(productId).lean();
    expect(doc?.description).toBeUndefined();
    // The old version must now be stale, or a stale tab could overwrite.
    expect(doc?.updatedAt.toISOString()).not.toBe(first.version);
    const again = await updateProduct(
      admin,
      productId,
      { ...first.values, name: "Late" },
      { expectedUpdatedAt: first.version },
    );
    expect(again.ok).toBe(false);
  });
});

describe("public file links (rendered on public pages)", () => {
  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://example.com/a.ies",
    "//example.com/a.ies",
    "https:example.com",
    "https://user:pass@example.com/a",
    "https://user@example.com/a",
    "ftp://example.com/a",
    "https://example.com/a b",
    "https://example.com/a\nb",
    " javascript:alert(1)",
    "HTTPS://example.com/a",
    "/relative/a.ies",
    "https://",
    "https://exa mple.com",
  ])("refuses %j", async (url) => {
    const { values } = await loadedValues({
      publicFiles: [{ label: "IES", url }],
    });
    const result = await updateProduct(admin, productId, values);
    expect(result.ok).toBe(false);
    expect((await ProductModel.findById(productId))?.publicFiles).toHaveLength(
      0,
    );
  });

  it("accepts a plain https link", async () => {
    const { values } = await loadedValues({
      publicFiles: [{ label: "IES", url: "https://example.com/a.ies?x=1" }],
    });
    expect((await updateProduct(admin, productId, values)).ok).toBe(true);
  });
});

describe("mass assignment through the save payload", () => {
  it.each([
    ["images", [{ publicId: "evil", order: 0, kind: "gallery" }]],
    ["_id", new ObjectId().toHexString()],
    ["createdAt", "2000-01-01T00:00:00.000Z"],
    ["updatedAt", "2000-01-01T00:00:00.000Z"],
    ["featured", true],
    ["$set", { status: "published" }],
    ["__proto__", { status: "published" }],
    ["constructor", { prototype: {} }],
    ["spec", { cct: ["1"] }],
  ])("refuses the key %s and writes nothing", async (key, value) => {
    const { values } = await loadedValues();
    const payload = JSON.parse(JSON.stringify(values)) as Record<
      string,
      unknown
    >;
    Object.defineProperty(payload, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const before = JSON.stringify(await ProductModel.findById(productId));
    const result = await updateProduct(admin, productId, payload);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(await ProductModel.findById(productId))).toBe(before);
  });

  it("refuses unknown keys inside a variant, extra spec and spec object", async () => {
    for (const changes of [
      {
        variants: [{ modelNo: "X-1", imagePublicId: "", label: "", _id: "1" }],
      },
      { extraSpecs: [{ label: "a", value: "b", isPublic: false }] },
      { specs: { notASpecKey: ["1"] } },
      { filters: { cctK: [3000], evil: [1] } },
    ]) {
      const { values } = await loadedValues(changes);
      expect((await updateProduct(admin, productId, values)).ok).toBe(false);
    }
  });

  it("a status in the payload never changes the stored status", async () => {
    const { values } = await loadedValues({ status: "published", name: "N2" });
    await updateProduct(admin, productId, values);
    expect((await ProductModel.findById(productId))?.status).toBe("draft");
  });
});

describe("list input", () => {
  it.each([
    { q: { $ne: "" } },
    { q: ["a", "b"] },
    { status: { $ne: "draft" } },
    { status: "published\u0000" },
    { category: { $gt: "" } },
    { category: "not-an-id" },
    { page: { $gt: 0 } },
    { page: "-3" },
    { page: "1e309" },
  ])("%j falls back to defaults and returns the product", async (input) => {
    const page = await listProducts(admin, input);
    expect(page.total).toBe(1);
  });

  it("a search is literal: regex metacharacters match nothing extra", async () => {
    expect((await listProducts(admin, { q: ".*" })).total).toBe(0);
    expect((await listProducts(admin, { q: "(a+)+$" })).total).toBe(0);
    expect((await listProducts(admin, { q: "fixture" })).total).toBe(1);
  });
});

describe("audit entries hold ids and counts, never values", () => {
  it("a save records field names and a variant count only", async () => {
    const { values } = await loadedValues({
      name: "TOP-SECRET-NAME",
      specs: { driver: ["RESTRICTED-DRIVER-VALUE"] },
      extraSpecs: [{ group: "", label: "L", value: "EXTRA-VALUE" }],
    });
    expect((await updateProduct(admin, productId, values)).ok).toBe(true);
    const entries = await AuditLogModel.find({}).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe("product.update");
    const text = JSON.stringify(entries);
    for (const secret of [
      "TOP-SECRET-NAME",
      "RESTRICTED-DRIVER-VALUE",
      "EXTRA-VALUE",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("empty optional values round trip", () => {
  it("an empty extra-spec group and an empty variant label come back as '' and save as unchanged", async () => {
    const { values, version } = await loadedValues({
      extraSpecs: [{ group: "", label: "Weight", value: "1 kg" }],
      variants: [{ modelNo: "AR-013A1", label: "", imagePublicId: "" }],
    });
    expect(
      (
        await updateProduct(admin, productId, values, {
          expectedUpdatedAt: version,
        })
      ).ok,
    ).toBe(true);
    const doc = await ProductModel.findById(productId).lean();
    expect(doc?.variants[0]).not.toHaveProperty("label");
    // The stored extra spec carries no usable group (null or absent).
    expect(doc?.extraSpecs[0]?.group ?? null).toBeNull();

    const reloaded = await getProductForEdit(admin, productId);
    expect(reloaded?.values.extraSpecs?.[0]?.group).toBe("");
    expect(reloaded?.values.variants?.[0]?.label).toBe("");
    // Saving the reloaded form again is a no-op (no write, no audit).
    const again = await updateProduct(admin, productId, reloaded!.values, {
      expectedUpdatedAt: reloaded!.updatedAt,
    });
    expect(again).toMatchObject({ ok: true, tags: [] });
    expect(await AuditLogModel.countDocuments()).toBe(1);
  });
});

describe("duplicate model numbers across products", () => {
  async function other(modelNo: string) {
    await ProductModel.create({
      name: "Other",
      slug: "other",
      mainCategory: new ObjectId(spot),
      status: "draft",
      variants: [{ modelNo }],
    });
  }

  it("an exact clash is a row error on that variant", async () => {
    await other("ZZ-9");
    const { values } = await loadedValues({
      variants: [{ modelNo: "ZZ-9", label: "", imagePublicId: "" }],
    });
    const result = await updateProduct(admin, productId, values);
    expect(result).toMatchObject({
      ok: false,
      errors: { fieldErrors: { "variants.0.modelNo": expect.any(Array) } },
    });
  });

  // Gate B L-A, closed in Phase 3 T1 (ADR 0055): model nos. are compared
  // case-insensitively across products too (collation index + lookups).
  it("a clash that differs only by case is refused", async () => {
    await other("ZZ-9");
    const { values } = await loadedValues({
      variants: [{ modelNo: "zz-9", label: "", imagePublicId: "" }],
    });
    expect(await updateProduct(admin, productId, values)).toMatchObject({
      ok: false,
      errors: { fieldErrors: { "variants.0.modelNo": expect.any(Array) } },
    });
  });
});

describe("static: raw HTML is never rendered", () => {
  it("no dangerouslySetInnerHTML anywhere in src/", () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
    );
    const offenders = readdirSync(root, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((e) => e.isFile() && /\.(tsx?|jsx?)$/.test(e.name))
      .map((e) => path.join(e.parentPath, e.name))
      .filter(
        (file) =>
          !/\.test\.tsx?$/.test(file) &&
          readFileSync(file, "utf8").includes("dangerouslySetInnerHTML"),
      )
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});
