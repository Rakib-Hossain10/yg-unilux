// Tests for src/models/product.ts: schema validation (required fields, enums,
// trackSize, slugs, fixed spec keys, image sourceSha256) and, on an in-memory
// MongoDB, the case-insensitive unique model no. across products (ADR 0055)
// and projecting restricted specs away (ADR 0002).

import { beforeAll, describe, expect, it } from "vitest";

import { mongoose } from "@/lib/db";
import { setupMemoryDb } from "../../test/helpers/memory-db";
import { testPublicId } from "../../test/helpers/public-ids";

import { ProductModel } from "./product";
import { MODEL_NO_COLLATION } from "./product-constants";

const { Types } = mongoose;

/** The smallest valid product input, with optional overrides. */
function productInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Arc",
    slug: `arc-${new Types.ObjectId().toHexString()}`,
    mainCategory: new Types.ObjectId(),
    ...overrides,
  };
}

/** The validation error paths for an input, or [] if it is valid. */
async function invalidPaths(input: Record<string, unknown>): Promise<string[]> {
  try {
    await new ProductModel(input).validate();
    return [];
  } catch (error) {
    if (error instanceof mongoose.Error.ValidationError) {
      return Object.keys(error.errors).sort();
    }
    throw error;
  }
}

describe("product validation", () => {
  it("accepts a minimal product and applies the defaults", async () => {
    const product = new ProductModel(productInput());
    await expect(product.validate()).resolves.toBeUndefined();
    expect(product.status).toBe("draft");
    expect(product.featured).toBe(false);
    expect(product.datasheetId).toBeNull();
    expect(product.variants).toEqual([]);
    // Unused spec columns are not stored at all.
    expect(product.toObject().specs).toBeUndefined();
  });

  it("requires name, slug and mainCategory", async () => {
    expect(await invalidPaths({})).toEqual(["mainCategory", "name", "slug"]);
  });

  it("only allows the draft and published statuses", async () => {
    expect(await invalidPaths(productInput({ status: "archived" }))).toEqual([
      "status",
    ]);
  });

  it.each([5, 10, 20])("accepts trackSize %i", async (trackSize) => {
    expect(await invalidPaths(productInput({ trackSize }))).toEqual([]);
  });

  it.each([0, 15, 30])("rejects trackSize %i", async (trackSize) => {
    expect(await invalidPaths(productInput({ trackSize }))).toEqual([
      "trackSize",
    ]);
  });

  it("lowercases slugs and rejects ones that are not URL-safe", async () => {
    const product = new ProductModel(productInput({ slug: "  Arc-AR-013A " }));
    expect(product.slug).toBe("arc-ar-013a");
    expect(await invalidPaths(productInput({ slug: "arc ar/013a" }))).toEqual([
      "slug",
    ]);
  });

  it("only allows the gallery, dimension and installation image kinds", async () => {
    expect(
      await invalidPaths(
        productInput({ images: [{ publicId: testPublicId(0), kind: "hero" }] }),
      ),
    ).toEqual(["images.0.kind"]);
  });

  it("only stores Cloudinary ids in our server-chosen shape", async () => {
    expect(
      await invalidPaths(
        productInput({
          images: [{ publicId: "yg/arc-1", kind: "gallery" }],
          variants: [{ modelNo: "A-1", imagePublicId: "x/../y" }],
        }),
      ),
    ).toEqual(["images.0.publicId", "variants.0.imagePublicId"]);
  });

  it("requires a model no. on every variant", async () => {
    expect(
      await invalidPaths(productInput({ variants: [{ label: "Lens" }] })),
    ).toEqual(["variants.0.modelNo"]);
  });

  it("rejects two variants with the same model no. inside one product", async () => {
    expect(
      await invalidPaths(
        productInput({
          variants: [{ modelNo: "AR-013A1" }, { modelNo: "AR-013A1" }],
        }),
      ),
    ).toEqual(["variants"]);
  });

  it("treats model nos. that differ only by case as the same inside one product", async () => {
    expect(
      await invalidPaths(
        productInput({
          variants: [{ modelNo: "AR-013A1" }, { modelNo: "ar-013a1" }],
        }),
      ),
    ).toEqual(["variants"]);
  });

  it("accepts an image sourceSha256 of exactly 64 lowercase hex characters", async () => {
    const image = (sourceSha256: string) => ({
      images: [{ publicId: testPublicId(0), kind: "gallery", sourceSha256 }],
    });
    expect(await invalidPaths(productInput(image("a".repeat(64))))).toEqual([]);
    for (const bad of [
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
      ` ${"a".repeat(64)}`,
    ]) {
      expect(await invalidPaths(productInput(image(bad)))).toEqual([
        "images.0.sourceSha256",
      ]);
    }
  });

  it("leaves sourceSha256 out of images that don't set it", () => {
    const product = new ProductModel(
      productInput({
        images: [{ publicId: testPublicId(0), kind: "gallery" }],
      }),
    );
    expect(product.toObject().images[0]).not.toHaveProperty("sourceSha256");
  });

  it("refuses a spec key that is not one of the fixed sheet columns", async () => {
    // Inside a sub-schema, strict "throw" surfaces as a cast error at validation.
    const product = new ProductModel(
      productInput({ specs: { Driver: ["Lifud"] } }),
    );
    await expect(product.validate()).rejects.toThrow(/specs.*StrictModeError/);
  });

  it("refuses an unknown top-level field instead of silently dropping it", () => {
    expect(() => new ProductModel(productInput({ restricted: true }))).toThrow(
      mongoose.Error.StrictModeError,
    );
  });

  it("only allows https links for public files", async () => {
    expect(
      await invalidPaths(
        productInput({
          publicFiles: [{ label: "Guide", url: "javascript:alert(1)" }],
        }),
      ),
    ).toEqual(["publicFiles.0.url"]);
  });
});

describe("product storage", () => {
  setupMemoryDb("yg_product_test");

  beforeAll(async () => {
    await ProductModel.createIndexes();
  });

  it("rejects a model no. that already belongs to another product", async () => {
    await ProductModel.create(
      productInput({
        variants: [{ modelNo: "AR-013A1" }, { modelNo: "AR-013A2" }],
      }),
    );

    await expect(
      ProductModel.create(
        productInput({ variants: [{ modelNo: "AR-013A2" }] }),
      ),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("builds the model no. index with the case-insensitive collation and the partial filter", async () => {
    const indexes = await ProductModel.collection.indexes();
    const index = indexes.find((i) => i.name === "variants.modelNo_1");
    expect(index).toMatchObject({
      unique: true,
      partialFilterExpression: { "variants.modelNo": { $exists: true } },
      collation: { locale: "en", strength: 2 },
    });
  });

  it("rejects a model no. that differs only by case from another product's (ZZ-9 / zz-9)", async () => {
    await ProductModel.create(
      productInput({ variants: [{ modelNo: "ZZ-9" }] }),
    );
    await expect(
      ProductModel.create(productInput({ variants: [{ modelNo: "zz-9" }] })),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("stores the model no. exactly as typed", async () => {
    const { _id } = await ProductModel.create(
      productInput({ variants: [{ modelNo: "Mx-77b" }] }),
    );
    const stored = await ProductModel.findById(_id).lean();
    expect(stored?.variants[0]?.modelNo).toBe("Mx-77b");
  });

  it("still allows two model nos. that differ by more than case", async () => {
    await ProductModel.create(
      productInput({ variants: [{ modelNo: "QQ-1" }] }),
    );
    await expect(
      ProductModel.create(productInput({ variants: [{ modelNo: "QQ-2" }] })),
    ).resolves.toBeDefined();
  });

  it("finds a model no. case-insensitively with the shared collation", async () => {
    await ProductModel.create(
      productInput({ variants: [{ modelNo: "KC-5A" }] }),
    );
    const hits = await ProductModel.find(
      { "variants.modelNo": { $in: ["kc-5a"] } },
      { _id: 1 },
      { collation: MODEL_NO_COLLATION },
    ).lean();
    expect(hits).toHaveLength(1);
    // The query's collation matches the index's, so the index serves it.
    const plan = JSON.stringify(
      await ProductModel.find(
        { "variants.modelNo": { $in: ["kc-5a"] } },
        { _id: 1 },
        { collation: MODEL_NO_COLLATION },
      ).explain(),
    );
    expect(plan).toContain('"indexName":"variants.modelNo_1"');
  });

  it("allows several products that have no variants yet", async () => {
    await ProductModel.create(productInput());
    await expect(ProductModel.create(productInput())).resolves.toBeDefined();
  });

  it("rejects a second product with the same slug", async () => {
    await ProductModel.create(productInput({ slug: "arc-ar-013a" }));
    await expect(
      ProductModel.create(productInput({ slug: "arc-ar-013a" })),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("can leave restricted spec columns out of a read by projection", async () => {
    const { _id } = await ProductModel.create(
      productInput({
        specs: { driver: ["Lifud"], cct: ["3000K", "4000K"] },
        variants: [
          {
            modelNo: "PJ-001A1",
            specs: { driver: ["Tridonic"], lens: ["PMMA"] },
          },
        ],
      }),
    );

    const product = await ProductModel.findById(_id)
      .select("-specs.driver -variants.specs.driver")
      .lean();

    expect(product?.specs).toEqual({ cct: ["3000K", "4000K"] });
    expect(product?.variants[0]?.specs).toEqual({ lens: ["PMMA"] });
    expect(JSON.stringify(product)).not.toMatch(/Lifud|Tridonic/);
  });
});
