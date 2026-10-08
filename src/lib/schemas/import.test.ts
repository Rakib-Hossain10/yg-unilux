// Tests for the bulk import Zod schemas: the staged key shape (escaped dot,
// no lookalikes), the uuid taken from it, the presign request and the
// preview input with its default category id, and the commit / finish
// inputs (T8, ADR 0061).

import { describe, expect, it } from "vitest";

import {
  IMPORT_BATCH_SIZE,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_PLAN_ENTRIES,
  XLSX_MIME_TYPE,
} from "@/lib/constants";

import {
  commitImportInputSchema,
  finishImportInputSchema,
  IMPORT_KEY_PATTERN,
  importFileInputSchema,
  importIdFromKey,
  importKeySchema,
  presignImportInputSchema,
} from "./import";

const UUID = "11111111-1111-4111-8111-111111111111";
const KEY = `imports/${UUID}.xlsx`;
const ID = "0123456789abcdef01234567";

describe("IMPORT_KEY_PATTERN", () => {
  it("accepts a server-built key and a fresh crypto uuid", () => {
    expect(IMPORT_KEY_PATTERN.test(KEY)).toBe(true);
    expect(IMPORT_KEY_PATTERN.test(`imports/${crypto.randomUUID()}.xlsx`)).toBe(
      true,
    );
  });

  it.each([
    ["an unescaped-dot lookalike (X)", `imports/${UUID}Xxlsx`],
    ["an unescaped-dot lookalike (_)", `imports/${UUID}_xlsx`],
    ["a prefix lookalike", `importsX${UUID}.xlsx`],
    ["a longer prefix", `imports-old/${UUID}.xlsx`],
    ["traversal", `imports/../datasheets/${UUID}.xlsx`],
    ["traversal inside the name", `imports/..%2f${UUID}.xlsx`],
    ["the incoming prefix", `incoming/${UUID}.xlsx`],
    ["the datasheets prefix", `datasheets/${UUID}.xlsx`],
    ["a leading slash", `/${KEY}`],
    ["a trailing newline", `${KEY}\n`],
    ["an upper-case uuid", "imports/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.xlsx"],
    ["a uuid v1", "imports/aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa.xlsx"],
    ["a nested path", `imports/x/${UUID}.xlsx`],
    ["an .xlsm", `imports/${UUID}.xlsm`],
    ["an upper-case extension", `imports/${UUID}.XLSX`],
    ["a query string", `${KEY}?x=1`],
    ["an empty string", ""],
  ])("refuses %s", (_name, key) => {
    expect(IMPORT_KEY_PATTERN.test(key)).toBe(false);
    expect(importKeySchema.safeParse(key).success).toBe(false);
    expect(importIdFromKey(key)).toBeNull();
  });

  it("gives the uuid of a staged key", () => {
    expect(importIdFromKey(KEY)).toBe(UUID);
  });
});

describe("presignImportInputSchema", () => {
  const valid = {
    fileName: "Products.xlsx",
    size: 1234,
    contentType: XLSX_MIME_TYPE,
  };

  it("accepts an .xlsx up to exactly 30 MB", () => {
    expect(presignImportInputSchema.parse(valid)).toEqual(valid);
    expect(
      presignImportInputSchema.safeParse({ ...valid, size: MAX_IMPORT_BYTES })
        .success,
    ).toBe(true);
    expect(MAX_IMPORT_BYTES).toBe(30 * 1024 * 1024);
  });

  it.each(["", "application/octet-stream"])(
    "accepts the browser's fallback type %j",
    (contentType) => {
      expect(
        presignImportInputSchema.safeParse({ ...valid, contentType }).success,
      ).toBe(true);
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ["one byte over 30 MB", { size: MAX_IMPORT_BYTES + 1 }],
    ["an empty file", { size: 0 }],
    ["a fractional size", { size: 1.5 }],
    ["a size as a string", { size: "1234" }],
    [
      "a macro workbook type",
      { contentType: "application/vnd.ms-excel.sheet.macroEnabled.12" },
    ],
    ["a CSV type", { contentType: "text/csv" }],
    ["an old .xls type", { contentType: "application/vnd.ms-excel" }],
    ["a missing type", { contentType: undefined }],
    ["a file name that is not .xlsx", { fileName: "Products.xlsm" }],
    ["a file name with a path", { fileName: "../Products.xlsx" }],
    ["an unknown field", { key: `imports/${UUID}.xlsx` }],
  ])("refuses %s", (_name, override) => {
    expect(
      presignImportInputSchema.safeParse({ ...valid, ...override }).success,
    ).toBe(false);
  });
});

describe("importFileInputSchema", () => {
  it("accepts a staged key and a default category id (lowercased)", () => {
    expect(
      importFileInputSchema.parse({
        key: KEY,
        defaultCategoryId: ID.toUpperCase(),
      }),
    ).toEqual({ key: KEY, defaultCategoryId: ID });
  });

  it.each<[string, Record<string, unknown>]>([
    ["a foreign key", { key: `incoming/${UUID}.xlsx` }],
    ["a 12-character category id", { defaultCategoryId: "aaaaaaaaaaaa" }],
    ["a missing category id", { defaultCategoryId: undefined }],
    ["an operator object as the id", { defaultCategoryId: { $ne: null } }],
    ["an unknown field", { extra: 1 }],
  ])("refuses %s", (_name, override) => {
    expect(
      importFileInputSchema.safeParse({
        key: KEY,
        defaultCategoryId: ID,
        ...override,
      }).success,
    ).toBe(false);
  });
});

describe("commitImportInputSchema", () => {
  const HASH = "a".repeat(64);
  const valid = {
    key: KEY,
    defaultCategoryId: ID,
    etag: '"etag-1"',
    planHash: HASH,
    entryHashes: [HASH, HASH],
    batch: 0,
    acknowledgeRemovals: false,
  };
  const ok = (input: unknown) =>
    commitImportInputSchema.safeParse(input).success;

  it("accepts what the preview returned, also without an ETag", () => {
    expect(ok(valid)).toBe(true);
    expect(ok({ ...valid, etag: null })).toBe(true);
  });

  it("refuses unknown fields, an empty ETag and a foreign key", () => {
    expect(ok({ ...valid, extra: 1 })).toBe(false);
    expect(ok({ ...valid, etag: "" })).toBe(false);
    expect(ok({ ...valid, key: "datasheets/x.xlsx" })).toBe(false);
  });

  it("takes lowercase sha256 hex only", () => {
    expect(ok({ ...valid, planHash: "A".repeat(64) })).toBe(false);
    expect(ok({ ...valid, planHash: "a".repeat(63) })).toBe(false);
    expect(ok({ ...valid, entryHashes: [HASH, "g".repeat(64)] })).toBe(false);
  });

  it("bounds the entry hashes", () => {
    expect(ok({ ...valid, entryHashes: [] })).toBe(false);
    const many = Array.from(
      { length: MAX_IMPORT_PLAN_ENTRIES + 1 },
      () => HASH,
    );
    expect(ok({ ...valid, entryHashes: many })).toBe(false);
  });

  it("takes only a batch that exists in the plan", () => {
    expect(ok({ ...valid, batch: -1 })).toBe(false);
    expect(ok({ ...valid, batch: 0.5 })).toBe(false);
    expect(ok({ ...valid, batch: 1 })).toBe(false);
    const twoBatches = Array.from(
      { length: IMPORT_BATCH_SIZE + 1 },
      () => HASH,
    );
    expect(ok({ ...valid, entryHashes: twoBatches, batch: 1 })).toBe(true);
    expect(ok({ ...valid, entryHashes: twoBatches, batch: 2 })).toBe(false);
  });

  it("needs an explicit removal acknowledgement flag", () => {
    const without: Record<string, unknown> = { ...valid };
    delete without.acknowledgeRemovals;
    expect(ok(without)).toBe(false);
    expect(ok({ ...valid, acknowledgeRemovals: "yes" })).toBe(false);
  });
});

describe("finishImportInputSchema", () => {
  it("takes a staged key only, and nothing else", () => {
    expect(finishImportInputSchema.safeParse({ key: KEY }).success).toBe(true);
    expect(
      finishImportInputSchema.safeParse({ key: "imports/../x.xlsx" }).success,
    ).toBe(false);
    expect(
      finishImportInputSchema.safeParse({ key: KEY, extra: 1 }).success,
    ).toBe(false);
  });
});
