// Behavioural tests for the datasheet Server Actions (T13): a visitor, a
// customer, a banned admin and an admin on a temporary password reach no
// service and no storage call; the admin's calls pass the session's id and the
// input on, revalidate on both branches, and never return a key or a URL.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mongoose } from "@/lib/db";

import {
  deleteDatasheetAction,
  finalizeDatasheetAction,
  presignDatasheetUploadAction,
  renameDatasheetAction,
} from "./actions";

const getSession = vi.hoisted(() => vi.fn());
const nextCache = vi.hoisted(() => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));
const services = vi.hoisted(() => ({
  presignDatasheetUpload: vi.fn(),
  finalizeDatasheet: vi.fn(),
  renameDatasheet: vi.fn(),
  deleteDatasheet: vi.fn(),
}));
// The storage module must never be reached by a refused call.
const storage = vi.hoisted(() => ({
  presignPut: vi.fn(),
  headObject: vi.fn(),
  getRange: vi.fn(),
  getObjectBytes: vi.fn(),
  copyObject: vi.fn(),
  deleteObject: vi.fn(),
  listObjects: vi.fn(),
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
vi.mock("@/lib/admin/datasheets", () => services);

const { ObjectId } = mongoose.Types;
const ADMIN_ID = new ObjectId().toHexString();

/* The actor every service gets: the session's id and the request headers. */
const AS_ADMIN = { id: ADMIN_ID, headers: expect.any(Headers) };
const SHEET_ID = new ObjectId().toHexString();
const INCOMING = "incoming/0f8fad5b-d9cb-469f-a165-70867728950e.xlsx";

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

const PRESIGN = { fileName: "family.xlsx", size: 1234 };
const FINALIZE_NEW = {
  mode: "new",
  incomingKey: INCOMING,
  fileName: "family.xlsx",
};
const FINALIZE_REPLACE = {
  ...FINALIZE_NEW,
  mode: "replace",
  datasheetId: SHEET_ID,
};

/* One call of every action, with input an admin could send. */
const EVERY_ACTION: [string, () => Promise<unknown>][] = [
  ["presign", () => presignDatasheetUploadAction(PRESIGN)],
  ["finalize (new)", () => finalizeDatasheetAction(FINALIZE_NEW)],
  ["finalize (replace)", () => finalizeDatasheetAction(FINALIZE_REPLACE)],
  [
    "rename",
    () => renameDatasheetAction({ id: SHEET_ID, fileName: "new.xlsx" }),
  ],
  ["delete", () => deleteDatasheetAction(SHEET_ID)],
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
      expect(nextCache.refresh).not.toHaveBeenCalled();
    },
  );
});

describe("as the admin", () => {
  beforeEach(() => signedInAs({}));

  it("presign passes the session's id and returns the ticket without tags", async () => {
    const ticket = {
      uploadUrl: "https://r2.test/incoming/x.xlsx?sig=1",
      headers: { "Content-Type": "application/test" },
      incomingKey: INCOMING,
      expiresIn: 300,
    };
    services.presignDatasheetUpload.mockResolvedValue({
      ok: true,
      data: ticket,
      tags: [],
    });
    expect(await presignDatasheetUploadAction(PRESIGN)).toEqual({
      ok: true,
      data: ticket,
    });
    expect(services.presignDatasheetUpload).toHaveBeenCalledWith(
      AS_ADMIN,
      PRESIGN,
    );
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });

  it("a refused presign returns the size error, nothing saved", async () => {
    const errors = {
      formErrors: [],
      fieldErrors: { size: ["The file is larger than 10 MB"] },
    };
    services.presignDatasheetUpload.mockResolvedValue({
      ok: false,
      errors,
      tags: [],
    });
    expect(await presignDatasheetUploadAction(PRESIGN)).toEqual({
      ok: false,
      errors,
      saved: false,
    });
  });

  it("finalize passes the input on, revalidates the datasheets tag and refreshes", async () => {
    services.finalizeDatasheet.mockResolvedValue({
      ok: true,
      data: { id: SHEET_ID, fileName: "family.xlsx", size: 10 },
      tags: ["datasheets"],
    });
    expect(await finalizeDatasheetAction(FINALIZE_NEW)).toEqual({ ok: true });
    expect(services.finalizeDatasheet).toHaveBeenCalledWith(
      AS_ADMIN,
      FINALIZE_NEW,
    );
    expect(nextCache.updateTag).toHaveBeenCalledWith("datasheets");
    expect(nextCache.refresh).toHaveBeenCalledOnce();
  });

  it("a rejected file returns the reason and refreshes nothing", async () => {
    const errors = {
      formErrors: ["This file is not an Excel .xlsx workbook."],
      fieldErrors: {},
    };
    services.finalizeDatasheet.mockResolvedValue({
      ok: false,
      errors,
      tags: [],
    });
    expect(await finalizeDatasheetAction(FINALIZE_REPLACE)).toEqual({
      ok: false,
      errors,
      saved: false,
    });
    expect(nextCache.updateTag).not.toHaveBeenCalled();
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });

  it("a save whose audit failed reports saved: true, revalidates and refreshes", async () => {
    services.finalizeDatasheet.mockResolvedValue({
      ok: false,
      errors: { formErrors: ["audit"], fieldErrors: {} },
      tags: ["datasheets"],
    });
    const result = await finalizeDatasheetAction(FINALIZE_NEW);
    expect(result).toMatchObject({ ok: false, saved: true });
    expect(nextCache.updateTag).toHaveBeenCalledWith("datasheets");
    expect(nextCache.refresh).toHaveBeenCalledOnce();
  });

  it("rename passes the input on and refreshes", async () => {
    services.renameDatasheet.mockResolvedValue({
      ok: true,
      data: { id: SHEET_ID, fileName: "new.xlsx" },
      tags: ["datasheets"],
    });
    const input = { id: SHEET_ID, fileName: "new.xlsx" };
    expect(await renameDatasheetAction(input)).toEqual({ ok: true });
    expect(services.renameDatasheet).toHaveBeenCalledWith(AS_ADMIN, input);
    expect(nextCache.updateTag).toHaveBeenCalledWith("datasheets");
    expect(nextCache.refresh).toHaveBeenCalledOnce();
  });

  it("an unchanged rename refreshes nothing", async () => {
    services.renameDatasheet.mockResolvedValue({
      ok: true,
      data: { id: SHEET_ID, fileName: "same.xlsx" },
      tags: [],
    });
    await renameDatasheetAction({ id: SHEET_ID, fileName: "same.xlsx" });
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });

  it("delete refused while in use returns the count message first", async () => {
    const errors = {
      formErrors: [
        "3 products use this datasheet. Detach it from those products first.",
      ],
      fieldErrors: {},
    };
    services.deleteDatasheet.mockResolvedValue({ ok: false, errors, tags: [] });
    const result = await deleteDatasheetAction(SHEET_ID);
    expect(result).toEqual({ ok: false, errors, saved: false });
    expect(services.deleteDatasheet).toHaveBeenCalledWith(AS_ADMIN, SHEET_ID);
    expect(nextCache.updateTag).not.toHaveBeenCalled();
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });

  it("delete succeeds, revalidates and refreshes", async () => {
    services.deleteDatasheet.mockResolvedValue({
      ok: true,
      data: { id: SHEET_ID },
      tags: ["datasheets"],
    });
    expect(await deleteDatasheetAction(SHEET_ID)).toEqual({ ok: true });
    expect(nextCache.updateTag).toHaveBeenCalledWith("datasheets");
    expect(nextCache.refresh).toHaveBeenCalledOnce();
  });

  it("a malformed id reaches the service as given (it validates)", async () => {
    services.deleteDatasheet.mockResolvedValue({
      ok: false,
      errors: { formErrors: ["gone"], fieldErrors: {} },
      tags: [],
    });
    await deleteDatasheetAction({ $ne: null });
    expect(services.deleteDatasheet).toHaveBeenCalledWith(AS_ADMIN, {
      $ne: null,
    });
  });
});

/* What a service returns when its own actor check refuses (ADR 0073). */
const DENIED = {
  ok: false,
  errors: { formErrors: ["You are not allowed to do this."], fieldErrors: {} },
  tags: [],
  denied: "not_admin",
} as const;

describe("a service that refuses the actor answers 403 (ADR 0073)", () => {
  beforeEach(() => signedInAs({}));

  it.each([
    [
      "presign",
      "presignDatasheetUpload",
      () => presignDatasheetUploadAction({}),
    ],
    ["finalize", "finalizeDatasheet", () => finalizeDatasheetAction({})],
    ["rename", "renameDatasheet", () => renameDatasheetAction({})],
    ["delete", "deleteDatasheet", () => deleteDatasheetAction("x")],
  ] as const)("%s", async (_name, service, call) => {
    services[service].mockResolvedValue(DENIED);
    await expect(call()).rejects.toThrow("FORBIDDEN");
    expect(services[service]).toHaveBeenCalledTimes(1);
  });
});
