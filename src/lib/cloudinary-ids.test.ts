// Tests for src/lib/cloudinary-ids.ts: which public ids count as ours, which
// belong to one product or area, and building ids for new uploads.

import { describe, expect, it } from "vitest";

import { buildPublicId, isOwnPublicId, isPublicId } from "./cloudinary-ids";

const PRODUCT = "0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba98";
const UUID = "3f1c2a4e-9b7d-4c1e-8a2b-5d6e7f809a1b";

describe("isPublicId", () => {
  it.each([
    `yg/products/${PRODUCT}/${UUID}`,
    `yg/areas/${PRODUCT}/${UUID}`,
    `yg/leaders/${PRODUCT}/${UUID}`,
  ])("accepts %s", (id) => {
    expect(isPublicId(id)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["old free text", "areas/retail-bw"],
    ["outside yg/", `other/products/${PRODUCT}/${UUID}`],
    ["uppercase uuid", `yg/products/${PRODUCT}/${UUID.toUpperCase()}`],
    ["uppercase owner", `yg/products/${PRODUCT.toUpperCase()}/${UUID}`],
    ["uuid v1", `yg/products/${PRODUCT}/3f1c2a4e-9b7d-1c1e-8a2b-5d6e7f809a1b`],
    ["extra segment", `yg/products/${PRODUCT}/x/${UUID}`],
    ["trailing segment", `yg/products/${PRODUCT}/${UUID}/x`],
    ["path traversal", `yg/products/${PRODUCT}/../${UUID}`],
    ["leading slash", `/yg/products/${PRODUCT}/${UUID}`],
    ["file extension", `yg/products/${PRODUCT}/${UUID}.jpg`],
    ["newline", `yg/products/${PRODUCT}/${UUID}\n`],
  ])("refuses %s", (_label, id) => {
    expect(isPublicId(id)).toBe(false);
  });
});

describe("isOwnPublicId", () => {
  const own = `yg/products/${PRODUCT}/${UUID}`;

  it("accepts an id under the owner's own folder", () => {
    expect(isOwnPublicId("product", PRODUCT, own)).toBe(true);
    expect(isOwnPublicId("area", PRODUCT, `yg/areas/${PRODUCT}/${UUID}`)).toBe(
      true,
    );
  });

  it.each([
    ["another product's id", `yg/products/${OTHER}/${UUID}`],
    ["the area folder", `yg/areas/${PRODUCT}/${UUID}`],
    ["path traversal", `yg/products/${PRODUCT}/../${OTHER}/${UUID}`],
    ["uppercase", own.toUpperCase()],
    ["extra segment", `${own}/x`],
    ["prefix only", `yg/products/${PRODUCT}`],
  ])("refuses %s", (_label, id) => {
    expect(isOwnPublicId("product", PRODUCT, id)).toBe(false);
  });

  it("matches nothing for an owner id that is not lowercase hex", () => {
    expect(isOwnPublicId("product", ".*", own)).toBe(false);
    expect(isOwnPublicId("product", PRODUCT.toUpperCase(), own)).toBe(false);
  });
});

describe("buildPublicId", () => {
  it("builds the folder/owner/uuid id", () => {
    expect(buildPublicId("product", PRODUCT, UUID)).toBe(
      `yg/products/${PRODUCT}/${UUID}`,
    );
    expect(buildPublicId("area", PRODUCT, UUID)).toBe(
      `yg/areas/${PRODUCT}/${UUID}`,
    );
  });

  it("refuses a bad owner id or uuid", () => {
    expect(() => buildPublicId("product", "x", UUID)).toThrow(TypeError);
    expect(() => buildPublicId("product", PRODUCT, "../x")).toThrow(TypeError);
  });
});
