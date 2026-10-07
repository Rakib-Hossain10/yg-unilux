import { describe, expect, it } from "vitest";

import { SPEC_KEYS } from "@/models/spec-columns";

import {
  columnVisibilitySchema,
  companyEmailSchema,
  DEFAULT_COLUMN_VISIBILITY,
  parseStoredColumnVisibility,
  whatsappNumberSchema,
} from "./settings";

describe("DEFAULT_COLUMN_VISIBILITY", () => {
  it("covers all 28 keys with exactly the five default-restricted columns", () => {
    expect(Object.keys(DEFAULT_COLUMN_VISIBILITY)).toHaveLength(28);
    const restricted = Object.entries(DEFAULT_COLUMN_VISIBILITY)
      .filter(([, v]) => v === "restricted")
      .map(([k]) => k)
      .sort();
    expect(restricted).toEqual(
      ["batchNo", "chipEfficiency", "chipType", "driver", "holder"].sort(),
    );
  });

  it("passes its own schema", () => {
    expect(
      columnVisibilitySchema.safeParse(DEFAULT_COLUMN_VISIBILITY).success,
    ).toBe(true);
  });
});

describe("columnVisibilitySchema", () => {
  it("rejects a missing key, an unknown key and a bad value", () => {
    const missing: Record<string, string> = { ...DEFAULT_COLUMN_VISIBILITY };
    delete missing.driver;
    expect(columnVisibilitySchema.safeParse(missing).success).toBe(false);
    expect(
      columnVisibilitySchema.safeParse({
        ...DEFAULT_COLUMN_VISIBILITY,
        extra: "public",
      }).success,
    ).toBe(false);
    expect(
      columnVisibilitySchema.safeParse({
        ...DEFAULT_COLUMN_VISIBILITY,
        driver: "hidden",
      }).success,
    ).toBe(false);
  });
});

describe("parseStoredColumnVisibility", () => {
  it("fails closed: unknown, missing or junk entries are restricted", () => {
    const out = parseStoredColumnVisibility({ lens: "public", cct: "oops" });
    expect(out.lens).toBe("public");
    expect(out.cct).toBe("restricted");
    expect(out.driver).toBe("restricted");
    expect(Object.keys(out)).toEqual([...SPEC_KEYS]);
    expect(parseStoredColumnVisibility(null).lens).toBe("restricted");
  });
});

describe("whatsappNumberSchema", () => {
  it.each([
    ["+852 1234-5678", "85212345678"],
    ["(852) 1234 5678", "85212345678"],
    ["00852 12345678", "85212345678"],
    ["  8613800138000 ", "8613800138000"],
    ["", null],
  ])("normalises %j", (input, expected) => {
    expect(whatsappNumberSchema.parse(input)).toBe(expected);
  });

  it.each([
    "abc",
    "+852 1234 abcd",
    "1234567",
    "1234567890123456",
    "0123456789",
    "+",
    "12 34;56 78",
  ])("rejects %j", (input) => {
    expect(whatsappNumberSchema.safeParse(input).success).toBe(false);
  });
});

describe("companyEmailSchema", () => {
  it("trims, lowercases and accepts empty as null", () => {
    expect(companyEmailSchema.parse("  Info@YG-Unilux.com ")).toBe(
      "info@yg-unilux.com",
    );
    expect(companyEmailSchema.parse("")).toBeNull();
  });
  it.each(["nope", "a@b", "a b@c.com", "@c.com"])("rejects %j", (v) => {
    expect(companyEmailSchema.safeParse(v).success).toBe(false);
  });
});
