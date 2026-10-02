// Tests for src/models/spec-columns.ts: the spec column list must match the
// product schema's fixed spec keys exactly and restrict exactly the five
// default columns (CLAUDE.md, ADR 0002).

import { describe, expect, it } from "vitest";

import type { Schema } from "mongoose";

import { ProductModel } from "./product";
import {
  DEFAULT_RESTRICTED_SPEC_KEYS,
  SPEC_COLUMNS,
  SPEC_KEYS,
} from "./spec-columns";

// The 28 spec keys as written in the task specification (independent source).
const EXPECTED_SPEC_KEYS = [
  "housingMaterial",
  "housingFinish",
  "reflectorColor",
  "lens",
  "reflector",
  "diffuser",
  "cutOutSize",
  "dimensions",
  "rotatingAngle",
  "batchNo",
  "chipType",
  "holder",
  "chipEfficiency",
  "cct",
  "cri",
  "beamAngle",
  "ugr",
  "driver",
  "voltageInput",
  "wattage",
  "lumenOutput",
  "lumenEfficiency",
  "powerFactor",
  "sdcm",
  "dimmable",
  "lifespan",
  "ipRating",
  "warrantyPeriod",
];

/** The direct child paths of a single nested sub-schema, e.g. specs.*. */
function childPaths(
  path: string,
  schema: Schema = ProductModel.schema,
): string[] {
  const sub = (schema.path(path) as unknown as { schema?: Schema }).schema;
  if (!sub) throw new Error(`${path} is not a sub-schema`);
  return Object.keys(sub.paths);
}

describe("spec columns", () => {
  it("lists exactly the 28 spec keys, each once", () => {
    expect([...SPEC_KEYS].sort()).toEqual([...EXPECTED_SPEC_KEYS].sort());
    expect(new Set(SPEC_KEYS).size).toBe(SPEC_KEYS.length);
  });

  it("restricts exactly Batch No., Chip Type, Holder, Chip Efficiency and Driver by default", () => {
    expect([...DEFAULT_RESTRICTED_SPEC_KEYS].sort()).toEqual([
      "batchNo",
      "chipEfficiency",
      "chipType",
      "driver",
      "holder",
    ]);
  });

  it("gives every column a non-empty English header", () => {
    for (const column of SPEC_COLUMNS) {
      expect(column.header.trim()).not.toBe("");
      // English only: no Chinese characters from the bilingual sheet header.
      expect(column.header).not.toMatch(/\p{Script=Han}/u);
    }
  });

  it("matches the product's specs and variant specs keys exactly", () => {
    expect(childPaths("specs").sort()).toEqual([...EXPECTED_SPEC_KEYS].sort());

    const variantSchema = (
      ProductModel.schema.path("variants") as unknown as { schema: Schema }
    ).schema;
    expect(childPaths("specs", variantSchema).sort()).toEqual(
      [...EXPECTED_SPEC_KEYS].sort(),
    );
  });
});
