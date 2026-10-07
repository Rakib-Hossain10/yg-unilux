// Tests for the datasheet Zod schemas: file names, sizes, key shapes and the
// new/replace union.

import { describe, expect, it } from "vitest";

import { MAX_DATASHEET_BYTES } from "@/lib/constants";

import {
  DATASHEET_KEY_PATTERN,
  datasheetFileNameSchema,
  finalizeDatasheetInputSchema,
  INCOMING_KEY_PATTERN,
  presignDatasheetInputSchema,
  renameDatasheetInputSchema,
} from "./datasheet";

const UUID = "11111111-1111-4111-8111-111111111111";
const ID = "0123456789abcdef01234567";

describe("datasheetFileNameSchema", () => {
  it("trims and accepts .xlsx in any case", () => {
    expect(datasheetFileNameSchema.parse("  Arc Family.XLSX ")).toBe(
      "Arc Family.XLSX",
    );
  });
  it.each([
    "",
    ".xlsx",
    "sheet.xls",
    "sheet.xlsx.exe",
    "../sheet.xlsx",
    "a/b.xlsx",
    "a\b.xlsx",
    "bad\u0000.xlsx",
    `${"a".repeat(251)}.xlsx`,
  ])("rejects %j", (name) => {
    expect(datasheetFileNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("presignDatasheetInputSchema", () => {
  it("accepts 1 byte to 10 MB", () => {
    for (const size of [1, MAX_DATASHEET_BYTES]) {
      expect(
        presignDatasheetInputSchema.safeParse({ fileName: "a.xlsx", size })
          .success,
      ).toBe(true);
    }
  });
  it.each([0, -1, 1.5, MAX_DATASHEET_BYTES + 1, "10", Number.NaN])(
    "rejects size %j",
    (size) => {
      expect(
        presignDatasheetInputSchema.safeParse({ fileName: "a.xlsx", size })
          .success,
      ).toBe(false);
    },
  );
  it("rejects unknown keys", () => {
    expect(
      presignDatasheetInputSchema.safeParse({
        fileName: "a.xlsx",
        size: 5,
        key: "datasheets/x.xlsx",
      }).success,
    ).toBe(false);
  });
});

describe("key patterns", () => {
  it("accept only uuid v4 keys under their own prefix", () => {
    expect(INCOMING_KEY_PATTERN.test(`incoming/${UUID}.xlsx`)).toBe(true);
    expect(DATASHEET_KEY_PATTERN.test(`datasheets/${UUID}.xlsx`)).toBe(true);
    expect(INCOMING_KEY_PATTERN.test(`datasheets/${UUID}.xlsx`)).toBe(false);
    expect(
      INCOMING_KEY_PATTERN.test(`incoming/../datasheets/${UUID}.xlsx`),
    ).toBe(false);
    expect(INCOMING_KEY_PATTERN.test(`incoming/${UUID}.xlsx/x`)).toBe(false);
    expect(INCOMING_KEY_PATTERN.test(`incoming/not-a-uuid.xlsx`)).toBe(false);
  });
});

describe("finalizeDatasheetInputSchema", () => {
  const incomingKey = `incoming/${UUID}.xlsx`;
  it("parses new and replace", () => {
    expect(
      finalizeDatasheetInputSchema.parse({
        mode: "new",
        incomingKey,
        fileName: "a.xlsx",
      }).mode,
    ).toBe("new");
    expect(
      finalizeDatasheetInputSchema.parse({
        mode: "replace",
        datasheetId: ID.toUpperCase(),
        incomingKey,
        fileName: "a.xlsx",
      }),
    ).toMatchObject({ datasheetId: ID });
  });
  it("needs a datasheetId to replace, and refuses a stored key as the source", () => {
    expect(
      finalizeDatasheetInputSchema.safeParse({
        mode: "replace",
        incomingKey,
        fileName: "a.xlsx",
      }).success,
    ).toBe(false);
    expect(
      finalizeDatasheetInputSchema.safeParse({
        mode: "new",
        incomingKey: `datasheets/${UUID}.xlsx`,
        fileName: "a.xlsx",
      }).success,
    ).toBe(false);
  });
});

describe("renameDatasheetInputSchema", () => {
  it("needs a valid id and file name", () => {
    expect(
      renameDatasheetInputSchema.safeParse({ id: ID, fileName: "b.xlsx" })
        .success,
    ).toBe(true);
    expect(
      renameDatasheetInputSchema.safeParse({ id: "x", fileName: "b.xlsx" })
        .success,
    ).toBe(false);
  });
});
