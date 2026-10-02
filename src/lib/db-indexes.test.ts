// Tests for src/lib/db-indexes.ts on an in-memory MongoDB: every model's
// indexes build, the loginAttempts TTL index exists, a re-run changes nothing,
// and a failure is reported without quoting document values.

import { describe, expect, it } from "vitest";

import { getDb, mongoose } from "@/lib/db";
import { indexedModels } from "@/models";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import { syncIndexes } from "./db-indexes";

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
});
