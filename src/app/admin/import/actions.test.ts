// Behavioural tests for the import Server Actions (T9): a visitor, a customer,
// a banned admin and an admin on a temporary password reach no service and
// no storage call; the admin's calls pass the session's id and the input on,
// revalidate on both branches, and answer with shaped data only.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mongoose } from "@/lib/db";
import { XLSX_MIME_TYPE } from "@/lib/constants";

import {
  commitImportBatchAction,
  finishImportAction,
  presignImportUploadAction,
  previewImportAction,
} from "./actions";

const getSession = vi.hoisted(() => vi.fn());
const nextCache = vi.hoisted(() => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));
const services = vi.hoisted(() => ({
  previewImport: vi.fn(),
  commitImportBatch: vi.fn(),
  finishImport: vi.fn(),
}));
// Every storage function the actions could reach; a refused call reaches none.
const storage = vi.hoisted(() => ({
  presignImportUpload: vi.fn(),
  presignPut: vi.fn(),
  getImportBytes: vi.fn(),
  deleteImportUpload: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: getSession,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  forbidden: () => {
    throw new Error("FORBIDDEN");
  },
}));
vi.mock("next/cache", () => nextCache);
vi.mock("@/lib/storage", () => storage);
vi.mock("@/lib/import", () => ({
  ...services,
  PREVIEW_AGAIN: "PREVIEW AGAIN",
  FILE_CHANGED: "FILE CHANGED",
}));

const { ObjectId } = mongoose.Types;
const ADMIN_ID = new ObjectId().toHexString();
const CATEGORY_ID = new ObjectId().toHexString();
const KEY = "imports/0f8fad5b-d9cb-469f-a165-70867728950e.xlsx";
const HASH = "a".repeat(64);
const PRODUCT_TAG = `product:${new ObjectId().toHexString()}`;

function signedInAs(fields: Record<string, unknown>) {
  getSession.mockResolvedValue({
    session: { id: "s1" },
    user: {
      id: ADMIN_ID,
      email: "someone@example.com",
      role: "admin",
      banned: false,
      banExpires: null,
      mustChangePassword: false,
      accessExpiresAt: null,
      ...fields,
    },
  });
}

const PRESIGN = {
  fileName: "products.xlsx",
  size: 4321,
  contentType: XLSX_MIME_TYPE,
};
const PREVIEW = { key: KEY, defaultCategoryId: CATEGORY_ID };
const COMMIT = {
  ...PREVIEW,
  etag: '"etag"',
  planHash: HASH,
  entryHashes: [HASH],
  batch: 0,
  acknowledgeRemovals: false,
};

const EVERY_ACTION: [string, () => Promise<unknown>][] = [
  ["presign", () => presignImportUploadAction(PRESIGN)],
  ["preview", () => previewImportAction(PREVIEW)],
  ["commit", () => commitImportBatchAction(COMMIT)],
  ["finish", () => finishImportAction({ key: KEY })],
];

beforeEach(() => {
  getSession.mockReset();
  for (const fn of [
    ...Object.values(nextCache),
    ...Object.values(services),
    ...Object.values(storage),
  ]) {
    fn.mockReset();
  }
});

describe.each([
  ["a visitor", null, "REDIRECT /login"],
  ["a customer", { role: "customer" }, "FORBIDDEN"],
  ["a banned admin", { banned: true }, "FORBIDDEN"],
  [
    "an admin on a temporary password",
    { mustChangePassword: true },
    "REDIRECT /change-password",
  ],
])("as %s", (_who, user, outcome) => {
  beforeEach(() => {
    if (user === null) getSession.mockResolvedValue(null);
    else signedInAs(user);
  });

  it.each(EVERY_ACTION)(
    "%s is refused before any service or storage call",
    async (_name, call) => {
      await expect(call()).rejects.toThrow(outcome);
      for (const fn of [
        ...Object.values(services),
        ...Object.values(storage),
      ]) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(nextCache.updateTag).not.toHaveBeenCalled();
      expect(nextCache.revalidateTag).not.toHaveBeenCalled();
    },
  );
});

describe("as the admin", () => {
  beforeEach(() => signedInAs({}));

  it("presign signs the .xlsx type and the exact size, whatever the browser reported", async () => {
    storage.presignImportUpload.mockResolvedValue({
      url: "https://r2.test/imports/x.xlsx?sig=1",
      headers: { "Content-Type": XLSX_MIME_TYPE },
      expiresIn: 300,
      key: KEY,
    });
    const result = await presignImportUploadAction({
      ...PRESIGN,
      contentType: "",
    });
    expect(storage.presignImportUpload).toHaveBeenCalledWith({
      contentType: XLSX_MIME_TYPE,
      contentLength: 4321,
    });
    expect(result).toEqual({
      ok: true,
      data: {
        uploadUrl: "https://r2.test/imports/x.xlsx?sig=1",
        headers: { "Content-Type": XLSX_MIME_TYPE },
        key: KEY,
        expiresIn: 300,
      },
    });
    expect(nextCache.updateTag).not.toHaveBeenCalled();
  });

  it.each([
    ["a too large file", { ...PRESIGN, size: 31 * 1024 * 1024 }],
    ["another file type", { ...PRESIGN, contentType: "text/csv" }],
    ["a non-.xlsx name", { ...PRESIGN, fileName: "products.xlsm" }],
    ["an unknown field", { ...PRESIGN, key: KEY }],
    ["no input", undefined],
  ])("presign refuses %s without signing anything", async (_name, input) => {
    const result = await presignImportUploadAction(input);
    expect(result).toMatchObject({ ok: false, saved: false });
    expect(storage.presignImportUpload).not.toHaveBeenCalled();
  });

  it("preview passes the input on and keeps only what the screen shows", async () => {
    services.previewImport.mockResolvedValue({
      ok: true,
      tags: [],
      data: {
        kind: "plan",
        etag: '"e"',
        plan: {
          planHash: HASH,
          warnings: [],
          summary: {
            create: 1,
            update: 0,
            unchanged: 0,
            blocked: 0,
            variantsRemoved: 0,
            imagesToAdd: 1,
          },
          entries: [
            {
              status: "create",
              sheet: "Products",
              rows: [2, 3],
              productNo: 76,
              family: "Arc",
              name: "Arc AR-013A",
              existing: null,
              target: {
                slug: "arc-ar-013a",
                specs: { driver: ["SECRET-DRIVER"] },
                variants: [
                  { modelNo: "AR-013A1", specs: { batchNo: ["SECRET-BATCH"] } },
                  { modelNo: "AR-013A2", specs: {} },
                ],
              },
              imagesToAdd: [
                { sha256: "b".repeat(64), sheet: "Products", row: 2 },
              ],
              variantsRemoved: [],
              changes: [],
              moreChanges: 0,
              warnings: [],
              hash: HASH,
            },
          ],
        },
      },
    });
    const result = await previewImportAction(PREVIEW);
    expect(services.previewImport).toHaveBeenCalledWith(PREVIEW);
    expect(result).toMatchObject({
      ok: true,
      data: {
        kind: "plan",
        etag: '"e"',
        planHash: HASH,
        entries: [
          {
            index: 0,
            slug: "arc-ar-013a",
            modelNos: ["AR-013A1", "AR-013A2"],
            variantCount: 2,
            newImageCount: 1,
            hash: HASH,
          },
        ],
      },
    });
    // Merged spec values (here restricted ones) never reach the browser.
    const text = JSON.stringify(result);
    expect(text).not.toContain("SECRET-DRIVER");
    expect(text).not.toContain("SECRET-BATCH");
    expect(text).not.toContain("b".repeat(64));
  });

  it("preview passes a refusal and a failure through", async () => {
    services.previewImport.mockResolvedValueOnce({
      ok: true,
      tags: [],
      data: { kind: "refused", warnings: [{ code: "not_xlsx" }] },
    });
    expect(await previewImportAction(PREVIEW)).toEqual({
      ok: true,
      data: { kind: "refused", warnings: [{ code: "not_xlsx" }] },
    });
    services.previewImport.mockResolvedValueOnce({
      ok: false,
      tags: [],
      errors: { formErrors: [], fieldErrors: { defaultCategoryId: ["Gone"] } },
    });
    expect(await previewImportAction(PREVIEW)).toEqual({
      ok: false,
      saved: false,
      errors: { formErrors: [], fieldErrors: { defaultCategoryId: ["Gone"] } },
    });
  });

  it("commit passes the session's id and revalidates the batch's tags", async () => {
    const data = { batch: 0, batches: 1, products: [], summary: {} };
    services.commitImportBatch.mockResolvedValue({
      ok: true,
      data,
      tags: ["products", PRODUCT_TAG],
    });
    const result = await commitImportBatchAction(COMMIT);
    expect(services.commitImportBatch).toHaveBeenCalledWith(ADMIN_ID, COMMIT);
    expect(nextCache.updateTag).toHaveBeenCalledWith("products");
    expect(nextCache.updateTag).toHaveBeenCalledWith(PRODUCT_TAG);
    expect(result).toEqual({ ok: true, data });
  });

  it("commit revalidates on the failure branch too (saved, audit failed)", async () => {
    services.commitImportBatch.mockResolvedValue({
      ok: false,
      tags: ["products"],
      errors: { formErrors: ["Audit failed"], fieldErrors: {} },
    });
    const result = await commitImportBatchAction(COMMIT);
    expect(nextCache.updateTag).toHaveBeenCalledWith("products");
    expect(result).toEqual({
      ok: false,
      saved: true,
      next: "retry",
      errors: { formErrors: ["Audit failed"], fieldErrors: {} },
    });
  });

  it.each([
    [{ formErrors: ["PREVIEW AGAIN"], fieldErrors: {} }, "preview"],
    [{ formErrors: ["FILE CHANGED"], fieldErrors: {} }, "preview"],
    [{ formErrors: [], fieldErrors: { batch: ["x"] } }, "preview"],
    [{ formErrors: [], fieldErrors: { entryHashes: ["x"] } }, "preview"],
    [{ formErrors: [], fieldErrors: { defaultCategoryId: ["x"] } }, "upload"],
    [
      { formErrors: [], fieldErrors: { acknowledgeRemovals: ["x"] } },
      "confirm",
    ],
    [
      {
        formErrors: ["The uploaded file is no longer available"],
        fieldErrors: {},
      },
      "retry",
    ],
  ])("commit failure %j → next %s", async (errors, next) => {
    services.commitImportBatch.mockResolvedValue({
      ok: false,
      tags: [],
      errors,
    });
    expect(await commitImportBatchAction(COMMIT)).toMatchObject({
      ok: false,
      saved: false,
      next,
    });
  });

  it("finish passes the input on", async () => {
    services.finishImport.mockResolvedValue({
      ok: true,
      tags: [],
      data: { deleted: true },
    });
    expect(await finishImportAction({ key: KEY })).toEqual({
      ok: true,
      data: { deleted: true },
    });
    expect(services.finishImport).toHaveBeenCalledWith({ key: KEY });
  });
});
