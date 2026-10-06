// Tests for the datasheet services on an in-memory MongoDB with a fake storage
// module: presign, finalize (new and replace), rename, list with in-use count
// and delete. Key properties: the incoming object is deleted on every path,
// replace keeps the storage key, delete is blocked while products use it.

import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_DATASHEET_BYTES, XLSX_MIME_TYPE } from "@/lib/constants";
import { mongoose } from "@/lib/db";
import { CategoryModel, DatasheetModel, ProductModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";
import { setupMemoryDb } from "../../../test/helpers/memory-db";

import {
  DATASHEET_NOT_FOUND,
  deleteDatasheet,
  finalizeDatasheet,
  listDatasheets,
  presignDatasheetUpload,
  renameDatasheet,
  UPLOAD_FAILED,
  UPLOAD_NOT_FOUND,
} from "./datasheets";
import { AUDIT_FAILED_MESSAGE, type ServiceResult } from "./write-result";

/* A Map-backed bucket. Keys not present behave like missing objects. */
const bucket = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array>(),
  deleted: [] as string[],
  failDelete: new Set<string>(),
  failCopy: false,
}));
vi.mock("@/lib/storage", () => ({
  presignPut: vi.fn(async (o: { key: string; contentType: string }) => ({
    url: `https://r2.test/${o.key}?sig=1`,
    headers: { "Content-Type": o.contentType },
    expiresIn: 300,
  })),
  headObject: vi.fn(async (key: string) => {
    const bytes = bucket.objects.get(key);
    return bytes ? { size: bytes.length, contentType: undefined } : null;
  }),
  getObjectBytes: vi.fn(async (key: string) => bucket.objects.get(key) ?? null),
  copyObject: vi.fn(async (from: string, to: string) => {
    if (bucket.failCopy) throw new Error("copy failed");
    const bytes = bucket.objects.get(from);
    if (!bytes) throw new Error("no source");
    bucket.objects.set(to, bytes);
  }),
  deleteObject: vi.fn(async (key: string) => {
    if (bucket.failDelete.has(key)) throw new Error("delete failed");
    bucket.deleted.push(key);
    bucket.objects.delete(key);
  }),
}));

setupMemoryDb("yg_admin_datasheets_test");

const { ObjectId } = mongoose.Types;
const ADMIN = new ObjectId().toHexString();
const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INCOMING_A = `incoming/${UUID_A}.xlsx`;
const INCOMING_B = `incoming/${UUID_B}.xlsx`;

async function workbook(sheetName = "Specs"): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  book.addWorksheet(sheetName).addRow(["NO.", "Model"]);
  return new Uint8Array(await book.xlsx.writeBuffer());
}

function expectOk<T>(result: ServiceResult<T>): T {
  if (!result.ok)
    throw new Error(`expected ok: ${JSON.stringify(result.errors)}`);
  return result.data;
}
function formErrorsOf<T>(result: ServiceResult<T>): string[] {
  if (result.ok) throw new Error("expected a failure");
  return result.errors.formErrors;
}

async function actions(): Promise<string[]> {
  const rows = await AuditLogModel.find({}).sort({ _id: 1 }).lean();
  return rows.map((row) => row.action);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  bucket.objects.clear();
  bucket.deleted.length = 0;
  bucket.failDelete.clear();
  bucket.failCopy = false;
  await Promise.all([
    DatasheetModel.deleteMany({}),
    ProductModel.deleteMany({}),
    CategoryModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
});

/* Uploads a valid workbook under `key` and finalizes it as a new datasheet. */
async function newDatasheet(key = INCOMING_A, fileName = "Arc.xlsx") {
  bucket.objects.set(key, await workbook());
  return expectOk(
    await finalizeDatasheet(ADMIN, { mode: "new", incomingKey: key, fileName }),
  );
}

describe("presignDatasheetUpload", () => {
  it("returns a presigned PUT to a server-chosen incoming key, no tags", async () => {
    const result = await presignDatasheetUpload(ADMIN, {
      fileName: "Arc.xlsx",
      size: 5000,
    });
    const ticket = expectOk(result);
    expect(ticket.incomingKey).toMatch(/^incoming\/[0-9a-f-]{36}\.xlsx$/);
    expect(ticket.uploadUrl).toContain(ticket.incomingKey);
    expect(ticket.headers["Content-Type"]).toBe(XLSX_MIME_TYPE);
    expect(ticket.expiresIn).toBe(300);
    expect(result.tags).toEqual([]);
    expect(await DatasheetModel.countDocuments()).toBe(0);
  });

  it("refuses a bad name, an empty file and an oversized file", async () => {
    for (const input of [
      { fileName: "a.txt", size: 10 },
      { fileName: "a.xlsx", size: 0 },
      { fileName: "a.xlsx", size: MAX_DATASHEET_BYTES + 1 },
      { fileName: "a.xlsx", size: 10, key: "x" },
    ]) {
      expect((await presignDatasheetUpload(ADMIN, input)).ok).toBe(false);
    }
  });

  it("rejects a non-ObjectId actor before doing anything", async () => {
    await expect(
      presignDatasheetUpload("nope", { fileName: "a.xlsx", size: 1 }),
    ).rejects.toThrow(TypeError);
  });
});

describe("finalizeDatasheet (new)", () => {
  it("copies to datasheets/, writes the document, audits, deletes incoming", async () => {
    bucket.objects.set(INCOMING_A, await workbook());
    const result = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_A,
      fileName: " Arc.xlsx ",
    });
    const saved = expectOk(result);
    expect(result.tags).toEqual(["datasheets"]);
    expect(saved.fileName).toBe("Arc.xlsx");

    const doc = await DatasheetModel.findById(saved.id).lean();
    expect(doc?.storageKey).toMatch(/^datasheets\/[0-9a-f-]{36}\.xlsx$/);
    expect(doc?.size).toBe(saved.size);
    expect(doc?.mimeType).toBe(XLSX_MIME_TYPE);
    expect(doc?.uploadedBy.toHexString()).toBe(ADMIN);
    expect(bucket.objects.has(doc!.storageKey)).toBe(true);
    expect(bucket.objects.has(INCOMING_A)).toBe(false);
    expect(await actions()).toEqual(["datasheet.upload"]);
  });

  it("audits ids and size only, never the file name", async () => {
    await newDatasheet(INCOMING_A, "Secret Customer Pricing.xlsx");
    const [entry] = await AuditLogModel.find({}).lean();
    expect(JSON.stringify(entry)).not.toContain("Secret");
    expect(entry?.meta).toEqual({ size: expect.any(Number) });
  });

  it.each([
    ["plain text", () => new TextEncoder().encode("not a workbook ".repeat(8))],
    ["empty", () => new Uint8Array(0)],
  ])("rejects %s, writes nothing and deletes incoming", async (_n, make) => {
    bucket.objects.set(INCOMING_A, make());
    const result = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_A,
      fileName: "a.xlsx",
    });
    expect(result.ok).toBe(false);
    expect(await DatasheetModel.countDocuments()).toBe(0);
    expect(await AuditLogModel.countDocuments()).toBe(0);
    expect([...bucket.objects.keys()]).toEqual([]);
    expect(result.tags).toEqual([]);
  });

  it("rejects a truncated workbook and deletes incoming", async () => {
    const whole = await workbook();
    bucket.objects.set(INCOMING_A, whole.subarray(0, whole.length - 40));
    const result = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_A,
      fileName: "a.xlsx",
    });
    expect(result.ok).toBe(false);
    expect(bucket.deleted).toContain(INCOMING_A);
  });

  it("rejects an object bigger than the limit without reading it", async () => {
    const big = new Uint8Array(MAX_DATASHEET_BYTES + 1);
    big.set([0x50, 0x4b, 0x03, 0x04]);
    bucket.objects.set(INCOMING_A, big);
    const storage = await import("@/lib/storage");
    const result = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_A,
      fileName: "a.xlsx",
    });
    expect(result.ok).toBe(false);
    expect(storage.getObjectBytes).not.toHaveBeenCalled();
    expect(bucket.deleted).toEqual([INCOMING_A]);
  });

  it("reports a missing upload", async () => {
    const result = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_A,
      fileName: "a.xlsx",
    });
    expect(formErrorsOf(result)).toEqual([UPLOAD_NOT_FOUND]);
  });

  it("refuses a key outside incoming/ and never touches a stored datasheet", async () => {
    const stored = `datasheets/${UUID_A}.xlsx`;
    bucket.objects.set(stored, await workbook());
    const result = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: stored,
      fileName: "a.xlsx",
    });
    expect(result.ok).toBe(false);
    expect(bucket.deleted).toEqual([]);
    expect(bucket.objects.has(stored)).toBe(true);
  });

  it("deletes incoming when the request is otherwise invalid", async () => {
    bucket.objects.set(INCOMING_A, await workbook());
    const result = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_A,
      fileName: "notes.txt",
    });
    expect(result.ok).toBe(false);
    expect(bucket.deleted).toEqual([INCOMING_A]);
  });

  it("deletes incoming and the new copy when the copy or the write fails", async () => {
    bucket.objects.set(INCOMING_A, await workbook());
    bucket.failCopy = true;
    const copyFail = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_A,
      fileName: "a.xlsx",
    });
    expect(formErrorsOf(copyFail)).toEqual([UPLOAD_FAILED]);
    expect([...bucket.objects.keys()]).toEqual([]);

    bucket.failCopy = false;
    bucket.objects.set(INCOMING_B, await workbook());
    vi.spyOn(DatasheetModel, "create").mockRejectedValueOnce(new Error("db"));
    const dbFail = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_B,
      fileName: "a.xlsx",
    });
    expect(formErrorsOf(dbFail)).toEqual([UPLOAD_FAILED]);
    expect([...bucket.objects.keys()]).toEqual([]);
    expect(await DatasheetModel.countDocuments()).toBe(0);
  });

  it("still succeeds when deleting incoming fails, and logs without detail", async () => {
    bucket.objects.set(INCOMING_A, await workbook());
    bucket.failDelete.add(INCOMING_A);
    const result = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_A,
      fileName: "a.xlsx",
    });
    expect(result.ok).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it("keeps the datasheet when only the audit write fails", async () => {
    bucket.objects.set(INCOMING_A, await workbook());
    vi.spyOn(AuditLogModel, "create").mockRejectedValueOnce(new Error("boom"));
    const result = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING_A,
      fileName: "a.xlsx",
    });
    expect(formErrorsOf(result)).toEqual([AUDIT_FAILED_MESSAGE]);
    expect(result.tags).toEqual(["datasheets"]);
    expect(await DatasheetModel.countDocuments()).toBe(1);
  });
});

describe("finalizeDatasheet (replace)", () => {
  it("keeps the storage key, replaces the bytes and fields, audits replace", async () => {
    const first = await newDatasheet(INCOMING_A, "Arc.xlsx");
    const before = await DatasheetModel.findById(first.id).lean();

    const bytes = await workbook("Second");
    bucket.objects.set(INCOMING_B, bytes);
    const result = await finalizeDatasheet(ADMIN, {
      mode: "replace",
      datasheetId: first.id,
      incomingKey: INCOMING_B,
      fileName: "Arc v2.xlsx",
    });
    expect(expectOk(result)).toEqual({
      id: first.id,
      fileName: "Arc v2.xlsx",
      size: bytes.length,
    });

    const after = await DatasheetModel.findById(first.id).lean();
    expect(after?.storageKey).toBe(before?.storageKey);
    expect(after?.fileName).toBe("Arc v2.xlsx");
    expect(after?.size).toBe(bytes.length);
    expect(bucket.objects.get(after!.storageKey)).toEqual(bytes);
    expect(bucket.objects.has(INCOMING_B)).toBe(false);
    expect(await DatasheetModel.countDocuments()).toBe(1);
    expect(await actions()).toEqual(["datasheet.upload", "datasheet.replace"]);
  });

  it("an invalid replacement leaves the stored file untouched", async () => {
    const first = await newDatasheet(INCOMING_A);
    const stored = (await DatasheetModel.findById(first.id).lean())!.storageKey;
    const original = bucket.objects.get(stored);

    bucket.objects.set(INCOMING_B, new TextEncoder().encode("x".repeat(100)));
    const result = await finalizeDatasheet(ADMIN, {
      mode: "replace",
      datasheetId: first.id,
      incomingKey: INCOMING_B,
      fileName: "bad.xlsx",
    });
    expect(result.ok).toBe(false);
    expect(bucket.objects.get(stored)).toBe(original);
    expect(bucket.objects.has(INCOMING_B)).toBe(false);
    expect((await DatasheetModel.findById(first.id).lean())?.fileName).toBe(
      "Arc.xlsx",
    );
  });

  it("refuses an unknown datasheet and still deletes incoming", async () => {
    bucket.objects.set(INCOMING_A, await workbook());
    const result = await finalizeDatasheet(ADMIN, {
      mode: "replace",
      datasheetId: new ObjectId().toHexString(),
      incomingKey: INCOMING_A,
      fileName: "a.xlsx",
    });
    expect(formErrorsOf(result)).toEqual([DATASHEET_NOT_FOUND]);
    expect(bucket.objects.has(INCOMING_A)).toBe(false);
  });

  it("removes the recreated object when the datasheet vanished mid-way", async () => {
    const first = await newDatasheet(INCOMING_A);
    const stored = (await DatasheetModel.findById(first.id).lean())!.storageKey;
    bucket.objects.set(INCOMING_B, await workbook());
    vi.spyOn(DatasheetModel, "updateOne").mockResolvedValueOnce({
      matchedCount: 0,
    } as never);
    const result = await finalizeDatasheet(ADMIN, {
      mode: "replace",
      datasheetId: first.id,
      incomingKey: INCOMING_B,
      fileName: "a.xlsx",
    });
    expect(formErrorsOf(result)).toEqual([DATASHEET_NOT_FOUND]);
    expect(bucket.objects.has(stored)).toBe(false);
    expect(bucket.objects.has(INCOMING_B)).toBe(false);
  });
});

describe("renameDatasheet", () => {
  it("renames, audits and returns the tag; the file is untouched", async () => {
    const saved = await newDatasheet();
    const result = await renameDatasheet(ADMIN, {
      id: saved.id,
      fileName: "Arc family.xlsx",
    });
    expect(expectOk(result).fileName).toBe("Arc family.xlsx");
    expect(result.tags).toEqual(["datasheets"]);
    expect((await DatasheetModel.findById(saved.id).lean())?.fileName).toBe(
      "Arc family.xlsx",
    );
    expect(await actions()).toEqual(["datasheet.upload", "datasheet.rename"]);
  });

  it("is a no-op for the same name, and fails for unknown ids / bad names", async () => {
    const saved = await newDatasheet();
    expect(
      await renameDatasheet(ADMIN, { id: saved.id, fileName: "Arc.xlsx" }),
    ).toEqual({
      ok: true,
      data: { id: saved.id, fileName: "Arc.xlsx" },
      tags: [],
    });
    expect(
      formErrorsOf(
        await renameDatasheet(ADMIN, {
          id: new ObjectId().toHexString(),
          fileName: "b.xlsx",
        }),
      ),
    ).toEqual([DATASHEET_NOT_FOUND]);
    expect(
      (await renameDatasheet(ADMIN, { id: saved.id, fileName: "b.txt" })).ok,
    ).toBe(false);
    expect(await actions()).toEqual(["datasheet.upload"]);
  });
});

describe("listDatasheets", () => {
  it("returns an empty list, then rows with in-use counts and no storage key", async () => {
    expect(await listDatasheets()).toEqual([]);

    const a = await newDatasheet(INCOMING_A, "A.xlsx");
    const b = await newDatasheet(INCOMING_B, "B.xlsx");
    const category = await CategoryModel.create({
      name: "Spot",
      slug: "spot",
      parent: null,
      order: 0,
    });
    // One datasheet attached to many products (ADR 0001).
    for (const slug of ["p1", "p2", "p3"]) {
      await ProductModel.create({
        name: slug,
        slug,
        mainCategory: category._id,
        datasheetId: new ObjectId(a.id),
      });
    }

    const rows = await listDatasheets();
    expect(rows.map((r) => [r.fileName, r.inUse])).toEqual(
      expect.arrayContaining([
        ["A.xlsx", 3],
        ["B.xlsx", 0],
      ]),
    );
    expect(rows.find((r) => r.id === b.id)?.inUse).toBe(0);
    for (const row of rows) expect(row).not.toHaveProperty("storageKey");
  });
});

describe("deleteDatasheet", () => {
  it("deletes the R2 object before the document, audits, returns the tag", async () => {
    const saved = await newDatasheet();
    const stored = (await DatasheetModel.findById(saved.id).lean())!.storageKey;
    const order: string[] = [];
    const storage = await import("@/lib/storage");
    vi.mocked(storage.deleteObject).mockImplementationOnce(async (key) => {
      order.push(
        `object:${(await DatasheetModel.countDocuments({ _id: saved.id })) === 1 ? "doc-still-there" : "doc-gone"}`,
      );
      bucket.objects.delete(key);
    });

    const result = await deleteDatasheet(ADMIN, saved.id);
    expect(result).toEqual({
      ok: true,
      data: { id: saved.id },
      tags: ["datasheets"],
    });
    expect(order).toEqual(["object:doc-still-there"]);
    expect(bucket.objects.has(stored)).toBe(false);
    expect(await DatasheetModel.countDocuments()).toBe(0);
    expect((await actions()).at(-1)).toBe("datasheet.delete");
  });

  it("is blocked while any product uses it, naming how many", async () => {
    const saved = await newDatasheet();
    const stored = (await DatasheetModel.findById(saved.id).lean())!.storageKey;
    const category = await CategoryModel.create({
      name: "Spot",
      slug: "spot",
      parent: null,
      order: 0,
    });
    await ProductModel.create([
      {
        name: "p1",
        slug: "p1",
        mainCategory: category._id,
        datasheetId: new ObjectId(saved.id),
      },
      {
        name: "p2",
        slug: "p2",
        mainCategory: category._id,
        datasheetId: new ObjectId(saved.id),
      },
    ]);

    const result = await deleteDatasheet(ADMIN, saved.id);
    expect(formErrorsOf(result)[0]).toContain("2 products use");
    expect(result.tags).toEqual([]);
    expect(bucket.objects.has(stored)).toBe(true);
    expect(await DatasheetModel.countDocuments()).toBe(1);
    expect(await actions()).toEqual(["datasheet.upload"]);

    // Once detached it can go.
    await ProductModel.updateMany({}, { $set: { datasheetId: null } });
    expect((await deleteDatasheet(ADMIN, saved.id)).ok).toBe(true);
  });

  it("keeps the document when the R2 delete fails, so it can be retried", async () => {
    const saved = await newDatasheet();
    const stored = (await DatasheetModel.findById(saved.id).lean())!.storageKey;
    bucket.failDelete.add(stored);
    const result = await deleteDatasheet(ADMIN, saved.id);
    expect(formErrorsOf(result)).toEqual([UPLOAD_FAILED]);
    expect(await DatasheetModel.countDocuments()).toBe(1);

    bucket.failDelete.clear();
    expect((await deleteDatasheet(ADMIN, saved.id)).ok).toBe(true);
  });

  it("handles bad and unknown ids", async () => {
    for (const id of ["x", { $ne: null }, new ObjectId().toHexString()]) {
      expect(formErrorsOf(await deleteDatasheet(ADMIN, id))).toEqual([
        DATASHEET_NOT_FOUND,
      ]);
    }
  });
});
