// getPublishedProductLabel (P6): the public name, model code and slug of a
// PUBLISHED product only, for /request-access; never a spec value.

import { Types } from "mongoose";
import { beforeAll, describe, expect, it } from "vitest";

import { ProductModel } from "@/models";
import { setupMemoryDb } from "../../../test/helpers/memory-db";

import { getPublishedProductLabel } from "./product-ref";

setupMemoryDb("yg_product_ref_test");

const published = new Types.ObjectId();
const draft = new Types.ObjectId();

beforeAll(async () => {
  const base = {
    mainCategory: new Types.ObjectId(),
    variants: [{ modelNo: "AR-013A1", specs: { driver: ["SECRET-DRIVER"] } }],
    specs: { batchNo: ["SECRET-BATCH"] },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await ProductModel.collection.insertMany([
    {
      ...base,
      _id: published,
      name: "Arc",
      modelCode: "AR-013A",
      slug: "arc-ar-013a",
      status: "published",
    },
    { ...base, _id: draft, name: "Draft", slug: "draft", status: "draft" },
  ]);
});

describe("getPublishedProductLabel", () => {
  it("returns the public label of a published product, ids in any case", async () => {
    const label = await getPublishedProductLabel(
      published.toHexString().toUpperCase(),
    );
    expect(label).toEqual({
      productId: published.toHexString(),
      slug: "arc-ar-013a",
      name: "Arc",
      modelCode: "AR-013A",
    });
    expect(JSON.stringify(label)).not.toContain("SECRET");
  });

  it("is null for a draft, an unknown or a malformed id", async () => {
    expect(await getPublishedProductLabel(draft.toHexString())).toBeNull();
    expect(
      await getPublishedProductLabel(new Types.ObjectId().toHexString()),
    ).toBeNull();
    for (const bad of ["", "abc", { $ne: null }, null]) {
      expect(await getPublishedProductLabel(bad as string)).toBeNull();
    }
  });
});
