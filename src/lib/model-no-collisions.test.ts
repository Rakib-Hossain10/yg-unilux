// Tests for findModelNoCollisions (src/lib/model-no-collisions.ts): which model
// nos. the case-insensitive unique index (ADR 0055) would refuse, within one
// product and across products. Pure; no database.

import { describe, expect, it } from "vitest";

import { findModelNoCollisions } from "./model-no-collisions";

const A = { id: "a".repeat(24), slug: "arc-a" };
const B = { id: "b".repeat(24), slug: "arc-b" };
const C = { id: "c".repeat(24), slug: "arc-c" };

describe("findModelNoCollisions", () => {
  it("finds nothing when every model no. is distinct ignoring case", () => {
    expect(
      findModelNoCollisions([
        { ...A, modelNos: ["AR-013A1", "AR-013A2"] },
        { ...B, modelNos: ["AR-013B1"] },
        { ...C, modelNos: [] },
      ]),
    ).toEqual([]);
  });

  it("finds a case-only clash across two products", () => {
    expect(
      findModelNoCollisions([
        { ...A, modelNos: ["ZZ-9", "X1"] },
        { ...B, modelNos: ["zz-9"] },
      ]),
    ).toEqual([
      {
        productCount: 2,
        owners: [
          { ...A, modelNo: "ZZ-9" },
          { ...B, modelNo: "zz-9" },
        ],
      },
    ]);
  });

  it("finds a case-only clash inside one product", () => {
    expect(
      findModelNoCollisions([{ ...A, modelNos: ["ZZ-9", "Zz-9"] }]),
    ).toEqual([
      {
        productCount: 1,
        owners: [
          { ...A, modelNo: "ZZ-9" },
          { ...A, modelNo: "Zz-9" },
        ],
      },
    ]);
  });

  it("also reports exact repeats, which the new index refuses too", () => {
    expect(
      findModelNoCollisions([
        { ...A, modelNos: ["Q1"] },
        { ...B, modelNos: ["Q1"] },
      ]),
    ).toHaveLength(1);
  });

  it("groups three owners of one model no. and sorts groups by model no.", () => {
    const found = findModelNoCollisions([
      { ...C, modelNos: ["m-2", "b-1"] },
      { ...A, modelNos: ["M-2"] },
      { ...B, modelNos: ["B-1", "M-2"] },
    ]);
    expect(found.map((group) => group.owners.map((o) => o.modelNo))).toEqual([
      ["b-1", "B-1"],
      ["m-2", "M-2", "M-2"],
    ]);
    expect(found.map((group) => group.productCount)).toEqual([2, 3]);
  });
});
