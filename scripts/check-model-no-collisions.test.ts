// Tests for scripts/check-model-no-collisions.ts on an in-memory MongoDB that
// looks like a pre-ADR 0055 database (no collation index, so case-only
// duplicates can exist): what it lists, what it never prints, the exit code.

import { beforeEach, describe, expect, it } from "vitest";

import packageJson from "../package.json";
import { mongoose } from "../src/lib/db";
import { ProductModel } from "../src/models";
import { setupMemoryDb } from "../test/helpers/memory-db";

import {
  loadModelNoOwners,
  runModelNoCheck,
} from "./check-model-no-collisions";

setupMemoryDb("yg_check_model_nos_test");

const { ObjectId } = mongoose.Types;
const ID_A = new ObjectId("a".repeat(24));
const ID_B = new ObjectId("b".repeat(24));
const ID_C = new ObjectId("c".repeat(24));

/* Inserted past Mongoose, as old data written under the old index would be. */
async function seed(docs: Record<string, unknown>[]) {
  await ProductModel.collection.insertMany(docs);
}

async function run() {
  const lines: string[] = [];
  const code = await runModelNoCheck((line) => lines.push(line));
  return { code, output: lines.join("\n") };
}

beforeEach(async () => {
  await ProductModel.collection.deleteMany({});
});

describe("check:model-nos", () => {
  it("is the documented command", () => {
    expect(packageJson.scripts["check:model-nos"]).toBe(
      "node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/check-model-no-collisions.ts",
    );
  });

  it("loads id, slug and model nos. of products with variants only", async () => {
    await seed([
      {
        _id: ID_A,
        slug: "a",
        variants: [{ modelNo: "A1" }, { modelNo: "A2" }],
      },
      { _id: ID_B, slug: "b", variants: [] },
    ]);
    expect(await loadModelNoOwners()).toEqual([
      { id: ID_A.toHexString(), slug: "a", modelNos: ["A1", "A2"] },
    ]);
  });

  it("exits 0 and says it is safe when nothing clashes", async () => {
    await seed([
      { _id: ID_A, slug: "a", variants: [{ modelNo: "A1" }] },
      { _id: ID_B, slug: "b", variants: [{ modelNo: "B1" }] },
    ]);
    const { code, output } = await run();
    expect(code).toBe(0);
    expect(output).toContain("Checked 2 product(s), 2 model no(s).");
    expect(output).toContain("No case-only duplicates");
  });

  it("exits 1 and lists clashes across and within products, never spec values", async () => {
    await seed([
      {
        _id: ID_A,
        slug: "arc-a",
        specs: { driver: ["SecretDriver"] },
        variants: [{ modelNo: "ZZ-9", specs: { batchNo: ["SecretBatch"] } }],
      },
      { _id: ID_B, slug: "arc-b", variants: [{ modelNo: "zz-9" }] },
      {
        _id: ID_C,
        slug: "arc-c",
        variants: [{ modelNo: "Q-1" }, { modelNo: "q-1" }],
      },
    ]);
    const { code, output } = await run();
    expect(code).toBe(1);
    expect(output).toContain("2 model no(s). used more than once");
    expect(output).toContain("1 across products: these BLOCK the new index");
    expect(output).toContain("1 inside one product: the index builds");
    expect(output).toContain("across 2 products (blocks the index)");
    expect(output).toContain("inside one product (fails on next save)");
    expect(output).toContain(
      `ZZ-9  (product ${ID_A.toHexString()}, /product/arc-a)`,
    );
    expect(output).toContain(
      `zz-9  (product ${ID_B.toHexString()}, /product/arc-b)`,
    );
    expect(output).toContain(
      `q-1  (product ${ID_C.toHexString()}, /product/arc-c)`,
    );
    expect(output).not.toMatch(/Secret/);
  });

  it("never writes to the database", async () => {
    await seed([
      { _id: ID_A, slug: "a", variants: [{ modelNo: "ZZ-9" }] },
      { _id: ID_B, slug: "b", variants: [{ modelNo: "zz-9" }] },
    ]);
    const before = await ProductModel.collection.find({}).toArray();
    await run();
    expect(await ProductModel.collection.find({}).toArray()).toEqual(before);
  });
});
