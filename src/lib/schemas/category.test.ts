// Tests for the category form schemas (src/lib/schemas/category.ts): what the
// admin may type for a name, slug, parent and description, how blanks are
// normalised, and that unknown keys and malformed ids are refused.

import { describe, expect, it } from "vitest";

import { MAX_SLUG_LENGTH } from "@/lib/slug";

import {
  categoryIdSchema,
  categoryInputSchema,
  MAX_CATEGORY_DESCRIPTION_LENGTH,
  MAX_CATEGORY_NAME_LENGTH,
  moveCategorySchema,
  setCategoryImageSchema,
  signCategoryImageSchema,
} from "./category";

const PARENT = "64b7f0c2a1b2c3d4e5f60718";

describe("categoryInputSchema", () => {
  it("parses a full form and trims every field", () => {
    expect(
      categoryInputSchema.parse({
        name: "  Spot Lights ",
        slug: " Spot-Lights ",
        parent: PARENT.toUpperCase(),
        description: "  Recessed and surface spots.  ",
      }),
    ).toEqual({
      name: "Spot Lights",
      slug: "spot-lights",
      parent: PARENT,
      description: "Recessed and surface spots.",
    });
  });

  it("turns blank or missing slug, parent and description into defaults", () => {
    const blank = { name: "Spot", slug: "  ", parent: "", description: " " };
    const expected = {
      name: "Spot",
      slug: "",
      parent: null,
      description: null,
    };
    expect(categoryInputSchema.parse(blank)).toEqual(expected);
    expect(categoryInputSchema.parse({ name: "Spot" })).toEqual(expected);
    expect(categoryInputSchema.parse({ name: "Spot", parent: null })).toEqual(
      expected,
    );
  });

  it.each([
    ["an empty name", { name: "   " }, "name"],
    [
      "a too long name",
      { name: "n".repeat(MAX_CATEGORY_NAME_LENGTH + 1) },
      "name",
    ],
    ["a slug with spaces", { name: "A", slug: "spot lights" }, "slug"],
    [
      "a slug with a double hyphen",
      { name: "A", slug: "spot--lights" },
      "slug",
    ],
    ["a slug with an accent", { name: "A", slug: "crème" }, "slug"],
    [
      "a too long slug",
      { name: "A", slug: "a".repeat(MAX_SLUG_LENGTH + 1) },
      "slug",
    ],
    ["a malformed parent id", { name: "A", parent: "not-an-id" }, "parent"],
    [
      "a 12-character parent id",
      { name: "A", parent: "abcdefghijkl" },
      "parent",
    ],
    [
      "a too long description",
      {
        name: "A",
        description: "d".repeat(MAX_CATEGORY_DESCRIPTION_LENGTH + 1),
      },
      "description",
    ],
    ["a non-string name", { name: 42 }, "name"],
  ])("rejects %s", (_label, input, field) => {
    const result = categoryInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain(field);
  });

  it("rejects keys the form does not have (no mass assignment of order or _id)", () => {
    expect(categoryInputSchema.safeParse({ name: "A", order: 3 }).success).toBe(
      false,
    );
    expect(
      categoryInputSchema.safeParse({ name: "A", _id: PARENT }).success,
    ).toBe(false);
  });

  it("rejects a query-operator object as the parent", () => {
    expect(
      categoryInputSchema.safeParse({ name: "A", parent: { $ne: null } })
        .success,
    ).toBe(false);
  });
});

describe("categoryIdSchema", () => {
  it("accepts a hex ObjectId and lowercases it", () => {
    expect(categoryIdSchema.parse(` ${PARENT.toUpperCase()} `)).toBe(PARENT);
  });

  it.each([[""], ["123"], [`${PARENT}0`], [{ $gt: "" }], [null]])(
    "rejects %j",
    (value) => {
      expect(categoryIdSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("moveCategorySchema", () => {
  it("accepts up and down", () => {
    expect(moveCategorySchema.parse({ id: PARENT, direction: "up" })).toEqual({
      id: PARENT,
      direction: "up",
    });
    expect(
      moveCategorySchema.parse({ id: PARENT, direction: "down" }).direction,
    ).toBe("down");
  });

  it("rejects other directions and extra keys", () => {
    expect(
      moveCategorySchema.safeParse({ id: PARENT, direction: "left" }).success,
    ).toBe(false);
    expect(
      moveCategorySchema.safeParse({ id: PARENT, direction: "up", by: 2 })
        .success,
    ).toBe(false);
  });
});

describe("category image schemas", () => {
  const ICON = `yg/categories/${PARENT}/0f8fad5b-d9cb-469f-a165-70867728950e`;

  it("signs only for a known slot, with no extra keys", () => {
    expect(
      signCategoryImageSchema.parse({ categoryId: PARENT, slot: "icon" }),
    ).toEqual({ categoryId: PARENT, slot: "icon" });
    for (const input of [
      { categoryId: PARENT, slot: "banner" },
      { categoryId: PARENT },
      { categoryId: PARENT, slot: "cover", formats: "svg" },
      { categoryId: "x", slot: "icon" },
    ]) {
      expect(signCategoryImageSchema.safeParse(input).success).toBe(false);
    }
  });

  it("sets an id of ours, clears with null or blank", () => {
    expect(
      setCategoryImageSchema.parse({
        categoryId: PARENT,
        slot: "icon",
        publicId: ` ${ICON} `,
      }).publicId,
    ).toBe(ICON);
    for (const publicId of [null, "", undefined]) {
      expect(
        setCategoryImageSchema.parse({
          categoryId: PARENT,
          slot: "cover",
          publicId,
        }).publicId,
      ).toBeNull();
    }
  });

  it.each([
    ["inline SVG markup", "<svg><script>alert(1)</script></svg>"],
    ["a URL", "https://res.cloudinary.com/demo/image/upload/x.svg"],
    ["a data URI", "data:image/svg+xml;base64,PHN2Zz4="],
    ["an id outside our shape", "categories/spot-icon"],
  ])("refuses %s", (_label, publicId) => {
    expect(
      setCategoryImageSchema.safeParse({
        categoryId: PARENT,
        slot: "icon",
        publicId,
      }).success,
    ).toBe(false);
  });
});
