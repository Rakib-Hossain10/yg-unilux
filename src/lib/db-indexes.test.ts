// Tests for src/lib/db-indexes.ts on an in-memory MongoDB: every model's
// indexes build, the loginAttempts TTL and products.datasheetId indexes exist,
// a re-run changes nothing, a failure is reported without quoting values, and
// the old case-sensitive model no. index is named with the fix (ADR 0055).

import { describe, expect, it } from "vitest";

import { getDb, mongoose } from "@/lib/db";
import { indexedModels, ProductModel } from "@/models";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import {
  BETTER_AUTH_INDEXES,
  syncBetterAuthIndexes,
  syncIndexes,
} from "./db-indexes";

setupMemoryDb("yg_indexes_test");

describe("syncIndexes", () => {
  it("builds every declared index for every indexed model", async () => {
    const results = await syncIndexes(indexedModels);

    expect(results.filter((result) => !result.ok)).toEqual([]);
    for (const model of indexedModels) {
      const result = results.find((r) => r.model === model.modelName);
      const declared = model.schema.indexes().length;
      // _id plus every declared index; models without indexes have no collection yet.
      expect(result).toMatchObject({
        ok: true,
        collection: model.collection.collectionName,
        collectionExists: declared > 0,
        indexes: declared > 0 ? expect.arrayContaining(["_id_"]) : [],
      });
      if (result?.ok && declared > 0) {
        expect(result.indexes).toHaveLength(declared + 1);
      }
    }
  });

  it("creates the loginAttempts TTL index that expires documents at expiresAt", async () => {
    await syncIndexes(indexedModels);
    const indexes = await getDb().collection("loginAttempts").indexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    );
    expect(indexes).toContainEqual(
      expect.objectContaining({ key: { key: 1 }, unique: true }),
    );
  });

  it("creates the products.datasheetId index used by the datasheet in-use checks", async () => {
    await syncIndexes(indexedModels);
    const indexes = await getDb().collection("products").indexes();
    const datasheetIndex = indexes.find(
      (index) => JSON.stringify(index.key) === '{"datasheetId":1}',
    );
    expect(datasheetIndex).toBeDefined();
    // A plain index: many products may share one datasheet or have none.
    expect(datasheetIndex?.unique).toBeUndefined();
  });

  it("is safe to run again (createIndexes only adds missing indexes)", async () => {
    const first = await syncIndexes(indexedModels);
    const second = await syncIndexes(indexedModels);
    expect(second).toEqual(first);
  });

  it("never drops an index it does not know about", async () => {
    await getDb()
      .collection("areas")
      .createIndex({ name: 1 }, { name: "manual_name" });
    const results = await syncIndexes(indexedModels);
    const areas = results.find((r) => r.collection === "areas");
    expect(areas).toMatchObject({
      ok: true,
      indexes: expect.arrayContaining(["manual_name"]),
    });
  });

  it("reports a failed build without quoting the duplicate value", async () => {
    // Two documents that break a unique index, written past Mongoose.
    const DupModel = mongoose.model(
      "DupProbe",
      new mongoose.Schema(
        { email: { type: String, unique: true } },
        { collection: "dupProbes" },
      ),
    );
    await DupModel.collection.insertMany([
      { email: "secret.person@example.com" },
      { email: "secret.person@example.com" },
    ]);

    const [result] = await syncIndexes([DupModel]);

    expect(result).toMatchObject({ ok: false, collection: "dupProbes" });
    const error = result && !result.ok ? result.error : "";
    expect(error).toMatch(/code 11000/);
    expect(error).not.toContain("secret.person");
  });

  describe("migrating to the case-insensitive model no. index (ADR 0055)", () => {
    const OLD_OPTIONS = {
      name: "variants.modelNo_1",
      unique: true,
      partialFilterExpression: { "variants.modelNo": { $exists: true } },
    } as const;

    /* The products collection as an old database has it. */
    async function withOldIndex(docs: Record<string, unknown>[] = []) {
      // Creates the collection first, so the block runs alone or in any order.
      await syncIndexes([ProductModel]);
      await ProductModel.collection.dropIndexes();
      await ProductModel.collection.deleteMany({});
      await ProductModel.collection.createIndex(
        { "variants.modelNo": 1 },
        OLD_OPTIONS,
      );
      if (docs.length > 0) await ProductModel.collection.insertMany(docs);
    }

    async function restore() {
      await ProductModel.collection.deleteMany({});
      await ProductModel.collection.dropIndexes();
      await syncIndexes([ProductModel]);
    }

    it("names the old index and says to drop it in Atlas, then re-run", async () => {
      await withOldIndex();
      try {
        const [result] = await syncIndexes([ProductModel]);
        expect(result).toMatchObject({ ok: false, collection: "products" });
        const error = result && !result.ok ? result.error : "";
        expect(error).toMatch(/IndexKeySpecsConflict|IndexOptionsConflict/);
        expect(error).toContain('"variants.modelNo_1"');
        expect(error).toContain("npm run check:model-nos");
        expect(error).toMatch(/drop .*in Atlas.*re-run/);
      } finally {
        await restore();
      }
    });

    it("points to check:model-nos when case-only duplicates block the new index, without quoting them", async () => {
      await withOldIndex([
        { name: "a", slug: "a", variants: [{ modelNo: "SECRET-77A" }] },
        { name: "b", slug: "b", variants: [{ modelNo: "secret-77a" }] },
      ]);
      await ProductModel.collection.dropIndex("variants.modelNo_1");
      try {
        const [result] = await syncIndexes([ProductModel]);
        const error = result && !result.ok ? result.error : "";
        expect(error).toMatch(/code 11000/);
        expect(error).toContain("npm run check:model-nos");
        expect(error.toLowerCase()).not.toContain("secret-77a");
      } finally {
        await restore();
      }
    });
  });
});

describe("syncBetterAuthIndexes", () => {
  it("builds Better Auth's indexes with the raw driver, idempotently", async () => {
    const first = await syncBetterAuthIndexes(getDb());
    const second = await syncBetterAuthIndexes(getDb());
    expect(first.filter((r) => !r.ok)).toEqual([]);
    expect(second).toEqual(first);
    for (const index of BETTER_AUTH_INDEXES) {
      const existing = await getDb().collection(index.collection).indexes();
      expect(existing).toContainEqual(
        expect.objectContaining({ name: index.options.name, key: index.key }),
      );
    }
  });

  it("enforces one account per email (case already lowered by Better Auth)", async () => {
    await syncBetterAuthIndexes(getDb());
    const users = getDb().collection("users");
    await users.deleteMany({});
    await users.insertOne({ email: "dup@example.com" });
    await expect(users.insertOne({ email: "dup@example.com" })).rejects.toThrow(
      /duplicate key/,
    );
  });

  it("expires sessions and verifications by TTL", async () => {
    await syncBetterAuthIndexes(getDb());
    for (const name of ["sessions", "verifications"]) {
      const indexes = await getDb().collection(name).indexes();
      expect(indexes).toContainEqual(
        expect.objectContaining({
          key: { expiresAt: 1 },
          expireAfterSeconds: 0,
        }),
      );
    }
  });
});
