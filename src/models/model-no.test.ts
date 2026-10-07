// Tests for the shared model no. rule (ADR 0055): `modelNoKey` must agree with
// the MongoDB collation { locale: "en", strength: 2 } used by the unique index,
// so the admin form, the service and the Phase 3 importer all match the index.

import { beforeAll, describe, expect, it } from "vitest";

import { mongoose } from "@/lib/db";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import {
  MODEL_NO_COLLATION,
  modelNoKey,
  sameModelNo,
} from "./product-constants";

const SAME: [string, string][] = [
  ["AR-013A1", "ar-013a1"],
  ["Ar-013a1", "aR-013A1"],
  // Full-width letters and ligatures are tertiary differences in ICU.
  ["ＡＲ-013", "ar-013"],
  ["ﬁ-1", "FI-1"],
  // Default-ignorable code points (soft hyphen, zero-width space) are
  // ignored by ICU collation, so they must not make two keys differ.
  ["AR\u00AD013", "AR013"],
  ["AR\u200B-1", "ar-1"],
];

const DIFFERENT: [string, string][] = [
  ["AR-013A1", "AR-013A2"],
  ["AR-013A1", "AR013A1"],
  ["AR 013", "AR-013"],
  // ß vs ss is a secondary difference in ICU (checked against MongoDB below).
  ["STRAßE-1", "strasse-1"],
  // Accents are secondary differences: strength 2 keeps them apart.
  ["CAFÉ-1", "CAFE-1"],
];

describe("model no. key", () => {
  it("is the collation the unique index uses", () => {
    expect(MODEL_NO_COLLATION).toEqual({ locale: "en", strength: 2 });
  });

  it("trims, like the schema does", () => {
    expect(modelNoKey(" AR-013A1 ")).toBe(modelNoKey("ar-013a1"));
  });

  it.each(SAME)("%j and %j are the same model no.", (a, b) => {
    expect(modelNoKey(a)).toBe(modelNoKey(b));
    expect(sameModelNo(a, b)).toBe(true);
  });

  it.each(DIFFERENT)("%j and %j are different model nos.", (a, b) => {
    expect(modelNoKey(a)).not.toBe(modelNoKey(b));
    expect(sameModelNo(a, b)).toBe(false);
  });
});

/*
 * The real proof: MongoDB's own collation must agree with modelNoKey on every
 * pair above, otherwise the in-app checks and the unique index would disagree.
 */
describe("model no. key agrees with the MongoDB collation", () => {
  setupMemoryDb("yg_model_no_test");
  const probe = () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error("not connected");
    return db.collection<{ modelNo: string }>("modelNoProbe");
  };

  beforeAll(async () => {
    await probe().deleteMany({});
  });

  it.each([...SAME, ...DIFFERENT])("%j vs %j", async (a, b) => {
    await probe().deleteMany({});
    await probe().insertOne({ modelNo: a.trim() });
    const hits = await probe().countDocuments(
      { modelNo: b.trim() },
      { collation: MODEL_NO_COLLATION },
    );
    expect(hits === 1).toBe(modelNoKey(a) === modelNoKey(b));
  });
});
