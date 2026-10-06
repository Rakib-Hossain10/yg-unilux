// Tests for the area form schemas (src/lib/schemas/area.ts): name, slug and
// bwImage rules, blank normalisation, and refusal of unknown keys and bad ids.

import { describe, expect, it } from "vitest";

import { MAX_SLUG_LENGTH } from "@/lib/slug";

import {
  areaIdSchema,
  areaInputSchema,
  MAX_AREA_BW_IMAGE_LENGTH,
  MAX_AREA_NAME_LENGTH,
  moveAreaSchema,
} from "./area";

const ID = "64b7f0c2a1b2c3d4e5f60718";

describe("areaInputSchema", () => {
  it("parses a full form and trims every field", () => {
    expect(
      areaInputSchema.parse({
        name: "  Retail ",
        slug: " Retail-Spaces ",
        bwImage: " areas/retail-bw ",
      }),
    ).toEqual({
      name: "Retail",
      slug: "retail-spaces",
      bwImage: "areas/retail-bw",
    });
  });

  it("turns blank or missing slug and bwImage into defaults", () => {
    const expected = { name: "Retail", slug: "", bwImage: null };
    expect(
      areaInputSchema.parse({ name: "Retail", slug: " ", bwImage: "" }),
    ).toEqual(expected);
    expect(areaInputSchema.parse({ name: "Retail" })).toEqual(expected);
  });

  it.each([
    ["an empty name", { name: "  " }, "name"],
    ["a too long name", { name: "n".repeat(MAX_AREA_NAME_LENGTH + 1) }, "name"],
    ["a slug with spaces", { name: "A", slug: "a b" }, "slug"],
    ["a slug with a double hyphen", { name: "A", slug: "a--b" }, "slug"],
    [
      "a too long slug",
      { name: "A", slug: "a".repeat(MAX_SLUG_LENGTH + 1) },
      "slug",
    ],
    [
      "a too long bwImage",
      { name: "A", bwImage: "i".repeat(MAX_AREA_BW_IMAGE_LENGTH + 1) },
      "bwImage",
    ],
    ["a non-string name", { name: 7 }, "name"],
  ])("rejects %s", (_label, input, field) => {
    const result = areaInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain(field);
  });

  it("rejects keys the form does not have (no mass assignment of order or _id)", () => {
    expect(areaInputSchema.safeParse({ name: "A", order: 3 }).success).toBe(
      false,
    );
    expect(areaInputSchema.safeParse({ name: "A", _id: ID }).success).toBe(
      false,
    );
  });
});

describe("areaIdSchema", () => {
  it("accepts a hex ObjectId and lowercases it", () => {
    expect(areaIdSchema.parse(` ${ID.toUpperCase()} `)).toBe(ID);
  });

  it.each([[""], ["123"], [`${ID}0`], [{ $gt: "" }], [null]])(
    "rejects %j",
    (value) => {
      expect(areaIdSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("moveAreaSchema", () => {
  it("accepts up and down", () => {
    expect(moveAreaSchema.parse({ id: ID, direction: "up" })).toEqual({
      id: ID,
      direction: "up",
    });
    expect(moveAreaSchema.parse({ id: ID, direction: "down" }).direction).toBe(
      "down",
    );
  });

  it("rejects other directions and extra keys", () => {
    expect(
      moveAreaSchema.safeParse({ id: ID, direction: "left" }).success,
    ).toBe(false);
    expect(
      moveAreaSchema.safeParse({ id: ID, direction: "up", by: 2 }).success,
    ).toBe(false);
  });
});
