// Behavioural tests for the categories Server Actions on an in-memory MongoDB:
// a visitor, a customer, a banned admin and an admin on a temporary password
// change nothing (QA L2, task 6); the admin's calls write, audit, revalidate.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUDIT_FAILED_MESSAGE } from "@/lib/admin/write-result";
import { createCategory } from "@/lib/admin/categories";
import { mongoose } from "@/lib/db";
import { CategoryModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";
import { testActor } from "../../../../test/helpers/admin-actor";
import { setupMemoryDb } from "../../../../test/helpers/memory-db";
import { testPublicId } from "../../../../test/helpers/public-ids";

import {
  createCategoryAction,
  deleteCategoryAction,
  moveCategoryAction,
  setCategoryImageAction,
  signCategoryImageUploadAction,
  updateCategoryAction,
} from "./actions";

// Cloudinary is never reached: signing and verification are faked.
const cloudinaryMock = vi.hoisted(() => ({
  inspectImage: vi.fn(),
  destroyImage: vi.fn(),
  signImageUpload: vi.fn(),
}));
vi.mock("@/lib/cloudinary", () => cloudinaryMock);

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
  getSessionFromDb: (
    await import("../../../../test/helpers/admin-actor")
  ).sessionsWithTestActors(getSession),
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

setupMemoryDb("yg_admin_category_actions_test");

const { ObjectId } = mongoose.Types;
const ADMIN_ID = new ObjectId().toHexString();
const seeder = testActor();
const SEED_ACTOR = seeder.id;

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

let mainA: string;
let mainB: string;
let subA1: string;

beforeEach(async () => {
  getSession.mockReset();
  nextCache.updateTag.mockReset();
  nextCache.refresh.mockReset();
  auditFails.value = false;
  cloudinaryMock.inspectImage.mockReset().mockResolvedValue({
    ok: true,
    bytes: 1000,
    format: "svg",
    width: 64,
    height: 64,
  });
  cloudinaryMock.destroyImage.mockReset().mockResolvedValue(true);
  cloudinaryMock.signImageUpload
    .mockReset()
    .mockImplementation((publicId: string) => ({
      uploadUrl: "https://api.cloudinary.com/v1_1/demo/image/upload",
      cloudName: "demo",
      publicId,
      fields: {},
    }));
  await Promise.all([
    CategoryModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  // Seeded through the service, as another admin, then the log is cleared
  // so each test sees only its own audit entries.
  mainA = await seed("Spot Lights", null);
  mainB = await seed("Track Lights", null);
  subA1 = await seed("Recessed", mainA);
  await AuditLogModel.deleteMany({});
});

async function seed(name: string, parent: string | null): Promise<string> {
  const result = await createCategory(seeder, { name, parent });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.data.id;
}

/* Everything an action could change, in a comparable form. */
async function snapshot() {
  const [categories, audit] = await Promise.all([
    CategoryModel.find({}).sort({ _id: 1 }).lean(),
    AuditLogModel.countDocuments(),
  ]);
  return JSON.parse(JSON.stringify({ categories, audit })) as unknown;
}

/* One call of every action, each with valid input an admin could send. */
const EVERY_ACTION: [string, () => Promise<unknown>][] = [
  ["create", () => createCategoryAction({ name: "Pendants", parent: "" })],
  [
    "update",
    () => updateCategoryAction(mainA, { name: "Renamed", parent: "" }),
  ],
  ["move", () => moveCategoryAction(mainB, "up")],
  ["delete", () => deleteCategoryAction(mainB)],
  [
    "sign image upload",
    () => signCategoryImageUploadAction({ categoryId: mainA, slot: "icon" }),
  ],
  [
    "set image",
    () =>
      setCategoryImageAction({
        categoryId: mainA,
        slot: "icon",
        publicId: testPublicId(0, mainA, "category"),
      }),
  ],
  [
    "clear image",
    () =>
      setCategoryImageAction({
        categoryId: mainA,
        slot: "cover",
        publicId: null,
      }),
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
      expect(nextCache.refresh).not.toHaveBeenCalled();
      expect(cloudinaryMock.signImageUpload).not.toHaveBeenCalled();
      expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
    },
  );
});

describe("as the admin", () => {
  beforeEach(() => signedInAs({}));

  it("create saves, audits with the session's id, revalidates and redirects", async () => {
    await expect(
      createCategoryAction({ name: "Pendants", slug: "", parent: mainB }),
    ).rejects.toThrow("REDIRECT /admin/categories?notice=created");

    const row = await CategoryModel.findOne({ name: "Pendants" }).lean();
    expect(row?.parent?.toHexString()).toBe(mainB);
    const audit = await AuditLogModel.findOne({}).lean();
    expect(audit?.action).toBe("category.create");
    expect(String(audit?.actor)).toBe(ADMIN_ID);
    expect(nextCache.updateTag).toHaveBeenCalledWith("categories");
  });

  it("create returns field errors for invalid input and writes nothing", async () => {
    const before = await snapshot();
    const result = await createCategoryAction({ name: "  ", parent: "" });
    expect(result).toMatchObject({
      ok: false,
      saved: false,
      errors: { fieldErrors: { name: [expect.any(String)] } },
    });
    expect(await snapshot()).toEqual(before);
    expect(nextCache.updateTag).not.toHaveBeenCalled();
  });

  it("create refuses fields the form doesn't have (no mass assignment)", async () => {
    const before = await snapshot();
    const result = await createCategoryAction({
      name: "Pendants",
      order: -1,
      actor: SEED_ACTOR,
    });
    expect(result).toMatchObject({ ok: false, saved: false });
    expect(await snapshot()).toEqual(before);
  });

  it("create refuses a subcategory as parent (depth 2)", async () => {
    const result = await createCategoryAction({ name: "Deep", parent: subA1 });
    expect(result).toMatchObject({
      ok: false,
      errors: { fieldErrors: { parent: [expect.any(String)] } },
    });
  });

  it("update saves and expires categories and products", async () => {
    await expect(
      updateCategoryAction(mainA, { name: "Spots", slug: "", parent: "" }),
    ).rejects.toThrow("REDIRECT /admin/categories?notice=updated");
    expect((await CategoryModel.findById(mainA).lean())?.name).toBe("Spots");
    expect(nextCache.updateTag).toHaveBeenCalledWith("categories");
    expect(nextCache.updateTag).toHaveBeenCalledWith("products");
  });

  it("update with nothing changed says so and revalidates nothing", async () => {
    await expect(
      updateCategoryAction(mainA, {
        name: "Spot Lights",
        slug: "spot-lights",
        parent: "",
        description: "",
      }),
    ).rejects.toThrow("REDIRECT /admin/categories?notice=unchanged");
    expect(nextCache.updateTag).not.toHaveBeenCalled();
    expect(await AuditLogModel.countDocuments()).toBe(0);
  });

  it("update of an unknown id is a form error", async () => {
    const result = await updateCategoryAction(new ObjectId().toHexString(), {
      name: "Ghost",
    });
    expect(result).toMatchObject({
      ok: false,
      saved: false,
      errors: { formErrors: [expect.stringContaining("no longer exists")] },
    });
  });

  it("move swaps two siblings, refreshes the tree and returns ok", async () => {
    expect(await moveCategoryAction(mainB, "up")).toEqual({ ok: true });
    const order = await CategoryModel.find({ parent: null })
      .sort({ order: 1 })
      .lean();
    expect(order.map((row) => row.name)).toEqual([
      "Track Lights",
      "Spot Lights",
    ]);
    expect(nextCache.updateTag).toHaveBeenCalledWith("categories");
    expect(nextCache.refresh).toHaveBeenCalledOnce();
  });

  it("move at the edge changes nothing and refreshes nothing", async () => {
    expect(await moveCategoryAction(mainA, "up")).toEqual({ ok: true });
    expect(nextCache.refresh).not.toHaveBeenCalled();
    expect(await AuditLogModel.countDocuments()).toBe(0);
  });

  it("move with a bad direction is refused", async () => {
    const before = await snapshot();
    const result = await moveCategoryAction(mainA, "sideways");
    expect(result).toMatchObject({ ok: false, saved: false });
    expect(await snapshot()).toEqual(before);
  });

  it("delete of a category with subcategories returns the blocker", async () => {
    const before = await snapshot();
    const result = await deleteCategoryAction(mainA);
    expect(result).toMatchObject({
      ok: false,
      saved: false,
      errors: { formErrors: [expect.stringContaining("1 subcategory")] },
    });
    expect(await snapshot()).toEqual(before);
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });

  it("delete of a leaf deletes, audits and redirects", async () => {
    await expect(deleteCategoryAction(subA1)).rejects.toThrow(
      "REDIRECT /admin/categories?notice=deleted",
    );
    expect(await CategoryModel.findById(subA1).lean()).toBeNull();
    expect((await AuditLogModel.findOne({}).lean())?.action).toBe(
      "category.delete",
    );
  });

  it("delete refuses an id that is an operator object", async () => {
    const before = await snapshot();
    const result = await deleteCategoryAction({ $ne: null });
    expect(result).toMatchObject({ ok: false, saved: false });
    expect(await snapshot()).toEqual(before);
  });

  it("sign image upload returns a signed id in the category's own folder", async () => {
    const result = await signCategoryImageUploadAction({
      categoryId: mainA,
      slot: "icon",
    });
    expect(result).toMatchObject({ ok: true, data: { cloudName: "demo" } });
    const publicId = result.ok ? result.data.publicId : "";
    expect(publicId.startsWith(`yg/categories/${mainA}/`)).toBe(true);
    expect(nextCache.updateTag).not.toHaveBeenCalled();
  });

  it("sign image upload refuses a bad slot", async () => {
    expect(
      await signCategoryImageUploadAction({ categoryId: mainA, slot: "x" }),
    ).toMatchObject({ ok: false, saved: false });
    expect(cloudinaryMock.signImageUpload).not.toHaveBeenCalled();
  });

  it("set image verifies, saves, audits with the session's id, expires categories and refreshes", async () => {
    const publicId = testPublicId(1, mainA, "category");
    expect(
      await setCategoryImageAction({
        categoryId: mainA,
        slot: "icon",
        publicId,
      }),
    ).toEqual({ ok: true });
    expect((await CategoryModel.findById(mainA).lean())?.icon).toBe(publicId);
    const audit = await AuditLogModel.findOne({}).lean();
    expect(audit?.action).toBe("category.update");
    expect(String(audit?.actor)).toBe(ADMIN_ID);
    expect(nextCache.updateTag).toHaveBeenCalledWith("categories");
    expect(nextCache.updateTag).not.toHaveBeenCalledWith("products");
    expect(nextCache.refresh).toHaveBeenCalledOnce();
  });

  it("set image refuses a rejected upload and changes nothing", async () => {
    cloudinaryMock.inspectImage.mockResolvedValue({
      ok: false,
      reason: "too_large",
    });
    const before = await snapshot();
    const result = await setCategoryImageAction({
      categoryId: mainA,
      slot: "cover",
      publicId: testPublicId(2, mainA, "category"),
    });
    expect(result).toMatchObject({
      ok: false,
      saved: false,
      errors: { fieldErrors: { publicId: [expect.any(String)] } },
    });
    expect(await snapshot()).toEqual(before);
    expect(nextCache.updateTag).not.toHaveBeenCalled();
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });

  describe("when the audit write fails", () => {
    beforeEach(() => {
      auditFails.value = true;
    });

    it("create keeps the category, revalidates and reports saved", async () => {
      const result = await createCategoryAction({ name: "Pendants" });
      expect(result).toEqual({
        ok: false,
        saved: true,
        errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
      });
      expect(await CategoryModel.exists({ name: "Pendants" })).not.toBeNull();
      expect(nextCache.updateTag).toHaveBeenCalledWith("categories");
    });

    it("update keeps the edit and still expires its tags", async () => {
      const result = await updateCategoryAction(mainA, { name: "Spots" });
      expect(result).toMatchObject({ ok: false, saved: true });
      expect((await CategoryModel.findById(mainA).lean())?.name).toBe("Spots");
      expect(nextCache.updateTag).toHaveBeenCalledWith("categories");
      expect(nextCache.updateTag).toHaveBeenCalledWith("products");
    });

    it("move keeps the new order and still refreshes the tree", async () => {
      const result = await moveCategoryAction(mainB, "up");
      expect(result).toMatchObject({ ok: false, saved: true });
      expect(nextCache.updateTag).toHaveBeenCalledWith("categories");
      expect(nextCache.refresh).toHaveBeenCalledOnce();
    });

    it("set image keeps the image, expires categories and refreshes", async () => {
      const publicId = testPublicId(3, mainA, "category");
      const result = await setCategoryImageAction({
        categoryId: mainA,
        slot: "icon",
        publicId,
      });
      expect(result).toMatchObject({ ok: false, saved: true });
      expect((await CategoryModel.findById(mainA).lean())?.icon).toBe(publicId);
      expect(nextCache.updateTag).toHaveBeenCalledWith("categories");
      expect(nextCache.refresh).toHaveBeenCalledOnce();
    });

    it("delete removes the row and still refreshes the tree", async () => {
      const result = await deleteCategoryAction(subA1);
      expect(result).toMatchObject({ ok: false, saved: true });
      expect(await CategoryModel.findById(subA1).lean()).toBeNull();
      expect(nextCache.refresh).toHaveBeenCalledOnce();
    });
  });
});

const CALLS: [string, () => Promise<unknown>][] = [
  [
    "create",
    () => createCategoryAction({ name: "Pendants", slug: "", parent: null }),
  ],
  [
    "update",
    () =>
      updateCategoryAction(mainB, { name: "Spots", slug: "", parent: null }),
  ],
  ["move", () => moveCategoryAction(mainB, "down")],
  ["delete", () => deleteCategoryAction(mainB)],
  [
    "sign image",
    () => signCategoryImageUploadAction({ categoryId: mainB, slot: "icon" }),
  ],
  [
    "set image",
    () =>
      setCategoryImageAction({
        categoryId: mainB,
        slot: "icon",
        publicId: null,
      }),
  ],
];

describe("a service that refuses the actor answers 403 (ADR 0073)", () => {
  beforeEach(async () => {
    signedInAs({});
    const admin: unknown = await getSession();
    // The services' own re-check from the database sees a customer (e.g.
    // demoted between the two reads); requireAdmin() still saw the admin.
    signedInAs({ role: "customer" });
    getSession.mockResolvedValueOnce(admin);
  });

  it.each(CALLS)("%s", async (_name, call) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const audits = await AuditLogModel.countDocuments();
    await expect(call()).rejects.toThrow("FORBIDDEN");
    // Refused by the service's check, not by requireAdmin().
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/actor refused: not_admin$/),
    );
    expect(await AuditLogModel.countDocuments()).toBe(audits);
  });
});
