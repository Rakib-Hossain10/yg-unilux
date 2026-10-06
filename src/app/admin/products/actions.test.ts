// Behavioural tests for the products Server Actions on an in-memory MongoDB:
// a visitor, a customer, a banned admin and an admin on a temporary password
// change nothing; the admin's create/save/publish/delete work as designed.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUDIT_FAILED_MESSAGE } from "@/lib/admin/write-result";
import { mongoose } from "@/lib/db";
import { AreaModel, CategoryModel, ProductModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";
import { setupMemoryDb } from "../../../../test/helpers/memory-db";

import { getProductForEdit, PRODUCT_CHANGED } from "@/lib/admin/products";

import {
  createDraftAction,
  deleteProductAction,
  publishProductAction,
  unpublishProductAction,
  updateProductAction,
} from "./actions";

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
/* A stored draft with two variants, for the edit actions. */
let productId: string;

beforeEach(async () => {
  getSession.mockReset();
  nextCache.updateTag.mockReset();
  nextCache.refresh.mockReset();
  nextCache.revalidateTag.mockReset();
  auditFails.value = false;
  await Promise.all([
    CategoryModel.deleteMany({}),
    ProductModel.deleteMany({}),
    AreaModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  const category = await CategoryModel.create({
    name: "Spot Lights",
    slug: "spot-lights",
    parent: null,
  });
  spotLights = category._id.toHexString();
  const product = await ProductModel.create({
    name: "Fixture Lamp",
    slug: "fixture-lamp",
    mainCategory: category._id,
    status: "draft",
    variants: [
      { modelNo: "AR-013A1", label: "Lens", specs: { beamAngle: ["24°"] } },
      { modelNo: "AR-013A2" },
    ],
    specs: { cct: ["3000K", "4000K"] },
    extraSpecs: [{ label: "Weight", value: "0.4 kg" }],
  });
  productId = product._id.toHexString();
});

/* The fixture's stored updatedAt, as the edit page sends it. */
async function version(): Promise<string | undefined> {
  return (
    await ProductModel.findById(productId).lean()
  )?.updatedAt.toISOString();
}

/* The edit actions called the way the page calls them (current version). */
async function save(id: unknown, values: unknown) {
  return updateProductAction(id, values, await version());
}
async function publish() {
  return publishProductAction(productId, await version());
}
async function unpublish() {
  return unpublishProductAction(productId, await version());
}

/* The edit form's values for the stored product, with some fields changed. */
async function editValues(changes: Record<string, unknown> = {}) {
  const loaded = await getProductForEdit(productId);
  if (!loaded) throw new Error("fixture product missing");
  return { ...loaded.values, ...changes };
}

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
  [
    "save the edit form",
    async () => save(productId, await editValues({ name: "Renamed" })),
  ],
  ["publish", () => publish()],
  ["unpublish", () => unpublish()],
  ["delete", () => deleteProductAction(productId)],
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
    const slugs = (await ProductModel.find({ name: "Arc" }).lean()).map(
      (p) => p.slug,
    );
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

describe("edit actions as the admin", () => {
  beforeEach(() => signedInAs({}));

  /* The redirect target, or "" when the action returned instead. */
  async function redirectOf(call: Promise<unknown>): Promise<string> {
    try {
      await call;
      return "";
    } catch (error) {
      const match = /^REDIRECT (.+)$/.exec(
        error instanceof Error ? error.message : "",
      );
      if (!match) throw error;
      return match[1] ?? "";
    }
  }

  it("save writes section (a), keeps the fields it doesn't edit, audits and reloads the page", async () => {
    const office = await AreaModel.create({ name: "Office", slug: "office" });
    const to = await redirectOf(
      save(
        productId,
        await editValues({
          name: "Arc Pro",
          family: "Arc",
          productNo: 76,
          areas: [office._id.toHexString()],
          filters: { cctK: [3000, 4000] },
        }),
      ),
    );
    expect(to).toBe(`/admin/products/${productId}?notice=updated`);

    const row = await ProductModel.findById(productId).lean();
    expect(row?.name).toBe("Arc Pro");
    expect(row?.family).toBe("Arc");
    expect(row?.productNo).toBe(76);
    expect(row?.areas.map(String)).toEqual([office._id.toHexString()]);
    expect(row?.filters?.cctK).toEqual([3000, 4000]);
    // Round-tripped unchanged: variants, specs and extra specs survive.
    expect(row?.variants.map((v) => v.modelNo)).toEqual([
      "AR-013A1",
      "AR-013A2",
    ]);
    expect(row?.variants[0]?.specs?.beamAngle).toEqual(["24°"]);
    expect(row?.specs?.cct).toEqual(["3000K", "4000K"]);
    expect(row?.extraSpecs.map((e) => e.label)).toEqual(["Weight"]);

    const audit = await AuditLogModel.findOne({
      action: "product.update",
    }).lean();
    expect(String(audit?.actor)).toBe(ADMIN_ID);
    expect(nextCache.updateTag).toHaveBeenCalledWith("products");
    expect(nextCache.updateTag).toHaveBeenCalledWith(`product:${productId}`);
  });

  it("save with nothing changed says so and writes nothing", async () => {
    const before = await snapshot();
    const to = await redirectOf(save(productId, await editValues()));
    expect(to).toBe(`/admin/products/${productId}?notice=unchanged`);
    expect(await snapshot()).toEqual(before);
    expect(nextCache.updateTag).not.toHaveBeenCalled();
  });

  it("save returns field errors for bad input and writes nothing", async () => {
    const before = await snapshot();
    const result = await save(
      productId,
      await editValues({ name: "", slug: "Not A Slug" }),
    );
    expect(result).toMatchObject({
      ok: false,
      saved: false,
      errors: {
        fieldErrors: {
          name: [expect.any(String)],
          slug: [expect.any(String)],
        },
      },
    });
    expect(await snapshot()).toEqual(before);
  });

  it("save maps another product's model no. to variants.N.modelNo", async () => {
    await ProductModel.create({
      name: "Other",
      slug: "other",
      mainCategory: new ObjectId(spotLights),
      variants: [{ modelNo: "XX-1" }],
    });
    const values = await editValues();
    const before = await snapshot();
    const result = await save(productId, {
      ...values,
      variants: [...(values.variants ?? []), { modelNo: "XX-1" }],
    });
    expect(result).toMatchObject({
      ok: false,
      saved: false,
      errors: { fieldErrors: { "variants.2.modelNo": [expect.any(String)] } },
    });
    expect(await snapshot()).toEqual(before);
  });

  it("save refuses a track size outside Magnetic Track", async () => {
    const result = await save(productId, await editValues({ trackSize: 10 }));
    expect(result).toMatchObject({
      ok: false,
      errors: { fieldErrors: { trackSize: [expect.any(String)] } },
    });
  });

  it("save refuses keys the form doesn't have (no mass assignment)", async () => {
    const before = await snapshot();
    const result = await save(productId, {
      ...(await editValues()),
      images: [{ publicId: "x", order: 0, kind: "product" }],
    });
    expect(result).toMatchObject({ ok: false, saved: false });
    expect(await snapshot()).toEqual(before);
  });

  it("save of an unknown or malformed id is a form error", async () => {
    for (const id of [new ObjectId().toHexString(), "nope", { $ne: null }]) {
      const result = await save(id, await editValues());
      expect(result).toMatchObject({
        ok: false,
        saved: false,
        errors: { formErrors: [expect.any(String)] },
      });
    }
  });

  it("publish is refused with the missing items and changes nothing", async () => {
    const before = await snapshot();
    const result = await publish();
    expect(result).toMatchObject({
      ok: false,
      saved: false,
      errors: {
        fieldErrors: {
          status: [expect.any(String)],
          images: ["Add at least one image"],
        },
      },
    });
    expect(await snapshot()).toEqual(before);
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });

  it("publish and unpublish write, audit, revalidate and refresh", async () => {
    await ProductModel.updateOne(
      { _id: productId },
      { $set: { images: [{ publicId: "yg/p/1", order: 0, kind: "product" }] } },
    );
    expect(await publish()).toEqual({ ok: true });
    expect((await ProductModel.findById(productId).lean())?.status).toBe(
      "published",
    );
    expect(nextCache.refresh).toHaveBeenCalledOnce();
    expect(nextCache.updateTag).toHaveBeenCalledWith("categories");

    expect(await unpublish()).toEqual({ ok: true });
    expect((await ProductModel.findById(productId).lean())?.status).toBe(
      "draft",
    );
    const actions = (await AuditLogModel.find({}).lean()).map((a) => a.action);
    expect(actions).toEqual(["product.publish", "product.unpublish"]);
  });

  it("delete removes the product, audits and opens the list", async () => {
    const to = await redirectOf(deleteProductAction(productId));
    expect(to).toBe("/admin/products?notice=deleted");
    expect(await ProductModel.exists({ _id: productId })).toBeNull();
    expect(
      await AuditLogModel.countDocuments({ action: "product.delete" }),
    ).toBe(1);
  });

  it("save whose audit fails reports saved and refreshes the page", async () => {
    auditFails.value = true;
    const result = await save(productId, await editValues({ name: "Kept" }));
    expect(result).toEqual({
      ok: false,
      saved: true,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
    });
    expect((await ProductModel.findById(productId).lean())?.name).toBe("Kept");
    // The re-render brings the new updatedAt, so the next save isn't stale.
    expect(nextCache.refresh).toHaveBeenCalledOnce();
    auditFails.value = false;
    await expect(
      save(productId, await editValues({ name: "Next" })),
    ).rejects.toThrow("REDIRECT");
  });

  it("delete whose audit fails reports saved without a refresh", async () => {
    auditFails.value = true;
    const result = await deleteProductAction(productId);
    expect(result).toEqual({
      ok: false,
      saved: true,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
    });
    expect(await ProductModel.exists({ _id: productId })).toBeNull();
    expect(nextCache.refresh).not.toHaveBeenCalled();
    expect(nextCache.updateTag).toHaveBeenCalledWith("products");
  });
});

describe("stale edit page", () => {
  beforeEach(() => signedInAs({}));

  it("a save from a page loaded before another write changes nothing", async () => {
    const loadedAt = await version();
    const values = await editValues({ name: "From the old tab" });
    // Another tab writes in between (e.g. it publishes or renames).
    await ProductModel.updateOne(
      { _id: productId },
      {
        $set: {
          name: "From the new tab",
          updatedAt: new Date(Date.now() + 5000),
        },
      },
      { timestamps: false },
    );
    const before = await snapshot();
    const result = await updateProductAction(productId, values, loadedAt);
    expect(result).toEqual({
      ok: false,
      saved: false,
      errors: { formErrors: [PRODUCT_CHANGED], fieldErrors: {} },
    });
    expect(await snapshot()).toEqual(before);
    expect(nextCache.updateTag).not.toHaveBeenCalled();
  });

  it("publish and unpublish from a stale page change nothing", async () => {
    await ProductModel.updateOne(
      { _id: productId },
      { $set: { images: [{ publicId: "yg/p/1", order: 0, kind: "product" }] } },
    );
    const loadedAt = await version();
    await ProductModel.updateOne(
      { _id: productId },
      { $set: { updatedAt: new Date(Date.now() + 5000) } },
      { timestamps: false },
    );
    const before = await snapshot();
    expect(await publishProductAction(productId, loadedAt)).toMatchObject({
      ok: false,
      errors: { formErrors: [PRODUCT_CHANGED] },
    });
    expect(await snapshot()).toEqual(before);
  });

  it.each([undefined, "yesterday", { $gt: "" }, 5])(
    "refuses %s as the version",
    async (bad) => {
      const before = await snapshot();
      const result = await updateProductAction(
        productId,
        await editValues({ name: "X" }),
        bad,
      );
      expect(result).toMatchObject({ ok: false, saved: false });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("a save never changes the status, even when the payload asks", async () => {
    await ProductModel.updateOne(
      { _id: productId },
      {
        $set: {
          status: "published",
          images: [{ publicId: "yg/p/1", order: 0, kind: "product" }],
        },
      },
    );
    await expect(
      save(productId, await editValues({ name: "Renamed", status: "draft" })),
    ).rejects.toThrow("REDIRECT");
    const row = await ProductModel.findById(productId).lean();
    expect(row?.name).toBe("Renamed");
    expect(row?.status).toBe("published");
  });
});
