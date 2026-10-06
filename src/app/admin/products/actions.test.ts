// Behavioural tests for the products Server Actions on an in-memory MongoDB:
// a visitor, a customer, a banned admin and an admin on a temporary password
// change nothing; the admin's draft is saved, audited, revalidated, opened.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUDIT_FAILED_MESSAGE } from "@/lib/admin/write-result";
import { mongoose } from "@/lib/db";
import { CategoryModel, ProductModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";
import { setupMemoryDb } from "../../../../test/helpers/memory-db";

import { createDraftAction } from "./actions";

const getSession = vi.hoisted(() => vi.fn());
const nextCache = vi.hoisted(() => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));
// When set, the audit write throws (the "saved but not audited" branch).
const auditFails = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: getSession,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// redirect() and forbidden() throw in Next; these throw a readable error.
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  forbidden: () => {
    throw new Error("FORBIDDEN");
  },
}));
vi.mock("next/cache", () => nextCache);
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    recordAudit: async (input: Parameters<typeof actual.recordAudit>[0]) => {
      if (auditFails.value) throw new Error("audit store down");
      return actual.recordAudit(input);
    },
  };
});

setupMemoryDb("yg_admin_product_actions_test");

const { ObjectId } = mongoose.Types;
const ADMIN_ID = new ObjectId().toHexString();

/* A Better Auth session user with the fields the guard reads. */
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

let spotLights: string;

beforeEach(async () => {
  getSession.mockReset();
  nextCache.updateTag.mockReset();
  nextCache.refresh.mockReset();
  nextCache.revalidateTag.mockReset();
  auditFails.value = false;
  await Promise.all([
    CategoryModel.deleteMany({}),
    ProductModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  const category = await CategoryModel.create({
    name: "Spot Lights",
    slug: "spot-lights",
    parent: null,
  });
  spotLights = category._id.toHexString();
});

/* Everything the action could change, in a comparable form. */
async function snapshot() {
  const [products, audit] = await Promise.all([
    ProductModel.find({}).sort({ _id: 1 }).lean(),
    AuditLogModel.countDocuments(),
  ]);
  return JSON.parse(JSON.stringify({ products, audit })) as unknown;
}

/* One call of every action, each with valid input an admin could send. */
const EVERY_ACTION: [string, () => Promise<unknown>][] = [
  [
    "create draft",
    () => createDraftAction({ name: "Arc", mainCategory: spotLights }),
  ],
];

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
    "%s is refused and changes nothing",
    async (_name, call) => {
      const before = await snapshot();
      await expect(call()).rejects.toThrow(outcome);
      expect(await snapshot()).toEqual(before);
      expect(nextCache.updateTag).not.toHaveBeenCalled();
      expect(nextCache.revalidateTag).not.toHaveBeenCalled();
      expect(nextCache.refresh).not.toHaveBeenCalled();
    },
  );
});

describe("as the admin", () => {
  beforeEach(() => signedInAs({}));

  it("create saves a draft, audits with the session's id, revalidates and opens it", async () => {
    let redirectedTo = "";
    await createDraftAction({ name: "Arc", mainCategory: spotLights }).catch(
      (error: unknown) => {
        redirectedTo = String(error);
      },
    );

    const row = await ProductModel.findOne({ name: "Arc" }).lean();
    expect(row).not.toBeNull();
    expect(row?.status).toBe("draft");
    expect(row?.slug).toBe("arc");
    expect(String(row?.mainCategory)).toBe(spotLights);
    expect(redirectedTo).toBe(
      `Error: REDIRECT /admin/products/${String(row?._id)}?notice=created`,
    );

    const audit = await AuditLogModel.findOne({}).lean();
    expect(audit?.action).toBe("product.create");
    expect(String(audit?.actor)).toBe(ADMIN_ID);
    expect(nextCache.updateTag).toHaveBeenCalledWith("products");
    // A Server Action reads its own write: updateTag, never revalidateTag.
    expect(nextCache.revalidateTag).not.toHaveBeenCalled();
  });

  it("a second draft with the same name gets its own slug", async () => {
    await expect(
      createDraftAction({ name: "Arc", mainCategory: spotLights }),
    ).rejects.toThrow("REDIRECT");
    await expect(
      createDraftAction({ name: "Arc", mainCategory: spotLights }),
    ).rejects.toThrow("REDIRECT");
    const slugs = (await ProductModel.find({}).lean()).map((p) => p.slug);
    expect(slugs.sort()).toEqual(["arc", "arc-2"]);
  });

  it("returns field errors for invalid input and writes nothing", async () => {
    const before = await snapshot();
    const result = await createDraftAction({ name: "  ", mainCategory: "" });
    expect(result).toMatchObject({
      ok: false,
      saved: false,
      errors: {
        fieldErrors: {
          name: [expect.any(String)],
          mainCategory: [expect.any(String)],
        },
      },
    });
    expect(await snapshot()).toEqual(before);
    expect(nextCache.updateTag).not.toHaveBeenCalled();
  });

  it("refuses a main category that does not exist", async () => {
    const before = await snapshot();
    const result = await createDraftAction({
      name: "Arc",
      mainCategory: new ObjectId().toHexString(),
    });
    expect(result).toMatchObject({
      ok: false,
      saved: false,
      errors: { fieldErrors: { mainCategory: [expect.any(String)] } },
    });
    expect(await snapshot()).toEqual(before);
  });

  it("refuses fields the form doesn't have (no mass assignment)", async () => {
    const before = await snapshot();
    const result = await createDraftAction({
      name: "Arc",
      mainCategory: spotLights,
      status: "published",
    });
    expect(result).toMatchObject({ ok: false, saved: false });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["an operator object", { name: "Arc", mainCategory: { $ne: null } }],
    ["a string", "Arc"],
    ["null", null],
  ])("refuses %s as input", async (_name, input) => {
    const before = await snapshot();
    const result = await createDraftAction(input);
    expect(result).toMatchObject({ ok: false, saved: false });
    expect(await snapshot()).toEqual(before);
  });

  it("when the audit write fails it keeps the draft, revalidates and reports saved", async () => {
    auditFails.value = true;
    const result = await createDraftAction({
      name: "Arc",
      mainCategory: spotLights,
    });
    expect(result).toEqual({
      ok: false,
      saved: true,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
    });
    expect(await ProductModel.exists({ name: "Arc" })).not.toBeNull();
    expect(nextCache.updateTag).toHaveBeenCalledWith("products");
  });
});
