// Tests for the category services (src/lib/admin/categories.ts) on an
// in-memory MongoDB: tree depth and parent rules, per-parent slugs, move
// up/down, the in-use delete block, audit entries and the returned tags.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_CATEGORY_DEPTH } from "@/lib/constants";
import { mongoose } from "@/lib/db";
import { CategoryModel, ProductModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";
import { setupMemoryDb } from "../../../test/helpers/memory-db";

import {
  createCategory,
  deleteCategory,
  getCategoryForEdit,
  listCategoryTree,
  moveCategory,
  updateCategory,
} from "./categories";
import { AUDIT_FAILED_MESSAGE, type ServiceResult } from "./write-result";

setupMemoryDb("yg_admin_categories_test");

const { ObjectId } = mongoose.Types;
const ADMIN = new ObjectId().toHexString();

beforeAll(async () => {
  // Indexes are built by `npm run db:indexes`, never on startup; build the
  // unique { parent, slug } index here so the duplicate-key path is real.
  await CategoryModel.createIndexes();
});

beforeEach(async () => {
  await Promise.all([
    CategoryModel.deleteMany({}),
    ProductModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
});

/* The data of a successful result; fails the test with its errors otherwise. */
function expectOk<T>(result: ServiceResult<T>): T {
  if (!result.ok)
    throw new Error(`expected ok: ${JSON.stringify(result.errors)}`);
  return result.data;
}

/* Creates a category through the service and returns its id. */
async function create(name: string, parent: string | null = null, slug = "") {
  return expectOk(await createCategory(ADMIN, { name, parent, slug })).id;
}

/* Sibling names under `parent` in display order. */
async function namesUnder(parent: string | null): Promise<string[]> {
  const rows = await CategoryModel.find({
    parent: parent === null ? null : new ObjectId(parent),
  })
    .sort({ order: 1, _id: 1 })
    .lean();
  return rows.map((row) => row.name);
}

async function auditActions(): Promise<string[]> {
  const rows = await AuditLogModel.find({}).sort({ _id: 1 }).lean();
  return rows.map((row) => row.action);
}

describe("createCategory", () => {
  it("creates a main category with a slug from the name, audits it and returns the tree tag", async () => {
    const result = await createCategory(ADMIN, { name: "Spot Lights" });

    expect(result).toEqual({
      ok: true,
      data: { id: expect.any(String) },
      tags: ["categories"],
    });
    const id = expectOk(result).id;
    const row = await CategoryModel.findById(id).lean();
    expect(row).toMatchObject({
      name: "Spot Lights",
      slug: "spot-lights",
      parent: null,
      order: 0,
    });

    const [entry, ...rest] = await AuditLogModel.find({}).lean();
    expect(rest).toHaveLength(0);
    expect(entry?.actor?.toHexString()).toBe(ADMIN);
    expect(entry).toMatchObject({
      action: "category.create",
      target: { type: "category", id },
      meta: { parentId: null },
    });
  });

  it("puts each new category last among its siblings", async () => {
    const spot = await create("Spot Lights");
    await create("Track Lights");
    await create("Recessed", spot);
    await create("Surface", spot);

    expect(await namesUnder(null)).toEqual(["Spot Lights", "Track Lights"]);
    expect(await namesUnder(spot)).toEqual(["Recessed", "Surface"]);
    const surface = await CategoryModel.findOne({ name: "Surface" }).lean();
    expect(surface?.order).toBe(1);
  });

  it("keeps slugs unique per parent: a free slug elsewhere is reused, a taken one gets -2", async () => {
    const spot = await create("Spot Lights");
    const recessed = await create("Recessed Lights");
    await create("Trimless", spot);
    await create("Trimless", recessed);
    await create("Trimless", spot);

    const slugs = await CategoryModel.find({ name: "Trimless" })
      .sort({ _id: 1 })
      .lean();
    expect(slugs.map((row) => row.slug)).toEqual([
      "trimless",
      "trimless",
      "trimless-2",
    ]);
  });

  it("refuses a typed slug already used under the same parent, writing nothing", async () => {
    await create("Spot Lights");
    const result = await createCategory(ADMIN, {
      name: "Spots",
      slug: "spot-lights",
    });

    expect(result).toEqual({
      ok: false,
      errors: {
        formErrors: [],
        fieldErrors: { slug: [expect.stringMatching(/already uses/)] },
      },
      tags: [],
    });
    expect(await CategoryModel.countDocuments()).toBe(1);
    expect(await auditActions()).toEqual(["category.create"]);
  });

  it("maps a duplicate-key race on insert to the slug field error", async () => {
    await create("Spot Lights");
    // Simulate another write winning between the check and the insert.
    vi.spyOn(CategoryModel, "exists").mockResolvedValue(null);

    const result = await createCategory(ADMIN, {
      name: "Spot",
      slug: "spot-lights",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.fieldErrors.slug).toEqual([
      expect.stringMatching(/already uses/),
    ]);
    expect(await CategoryModel.countDocuments()).toBe(1);
  });

  it("asks for a slug when the name has no letters or digits for one", async () => {
    const result = await createCategory(ADMIN, { name: "射灯" });
    expect(!result.ok && result.errors.fieldErrors.slug).toEqual([
      expect.stringMatching(/Enter a slug/),
    ]);
    expect(await CategoryModel.countDocuments()).toBe(0);
  });

  it(`allows ${MAX_CATEGORY_DEPTH} levels: a subcategory cannot be a parent`, async () => {
    expect(MAX_CATEGORY_DEPTH).toBe(2);
    const spot = await create("Spot Lights");
    const recessed = await create("Recessed", spot);

    const result = await createCategory(ADMIN, {
      name: "Deep",
      parent: recessed,
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        formErrors: [],
        fieldErrors: { parent: [expect.stringMatching(/main category/)] },
      },
      tags: [],
    });
    expect(await CategoryModel.countDocuments()).toBe(2);
  });

  it("refuses a parent that does not exist", async () => {
    const result = await createCategory(ADMIN, {
      name: "Orphan",
      parent: new ObjectId().toHexString(),
    });
    expect(!result.ok && result.errors.fieldErrors.parent).toEqual([
      expect.stringMatching(/no longer exists/),
    ]);
    expect(await CategoryModel.countDocuments()).toBe(0);
  });

  it("returns Zod field errors for bad input and writes nothing", async () => {
    const result = await createCategory(ADMIN, { name: "", order: 5 });
    expect(result.ok).toBe(false);
    expect(result.tags).toEqual([]);
    expect(!result.ok && result.errors.fieldErrors.name).toBeDefined();
    expect(await CategoryModel.countDocuments()).toBe(0);
    expect(await auditActions()).toEqual([]);
  });

  it("throws before writing when the actor id is not an ObjectId", async () => {
    await expect(createCategory("admin", { name: "Spot" })).rejects.toThrow(
      TypeError,
    );
    expect(await CategoryModel.countDocuments()).toBe(0);
  });

  it("keeps the category and still returns the tags when the audit write fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(AuditLogModel, "create").mockRejectedValueOnce(
      new Error("E11000 secret value Spot Lights"),
    );

    const result = await createCategory(ADMIN, { name: "Spot Lights" });

    expect(result).toEqual({
      ok: false,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
      tags: ["categories"],
    });
    expect(await CategoryModel.countDocuments({ slug: "spot-lights" })).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    // The log names the action, never values or the database message.
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("category.create");
    expect(line).not.toContain("Spot Lights");
    expect(line).not.toContain("secret");
  });
});

describe("updateCategory", () => {
  it("saves changed fields, audits their names only and returns categories + products", async () => {
    const id = await create("Spot Lights");
    const result = await updateCategory(ADMIN, id, {
      name: "Spot Lighting",
      slug: "spot-lighting",
      description: "All spots.",
    });

    expect(result).toEqual({
      ok: true,
      data: { id },
      tags: ["categories", "products"],
    });
    expect(await CategoryModel.findById(id).lean()).toMatchObject({
      name: "Spot Lighting",
      slug: "spot-lighting",
      description: "All spots.",
    });
    const entry = await AuditLogModel.findOne({
      action: "category.update",
    }).lean();
    expect(entry?.meta).toEqual({ fields: ["name", "slug", "description"] });
    expect(JSON.stringify(entry)).not.toContain("Spot Lighting");
  });

  it("keeps the current slug when the slug is left empty", async () => {
    const id = await create("Spot Lights");
    expectOk(await updateCategory(ADMIN, id, { name: "Spots", slug: "" }));
    expect((await CategoryModel.findById(id).lean())?.slug).toBe("spot-lights");
  });

  it("removes the description when it is cleared", async () => {
    const id = await create("Spot Lights");
    expectOk(
      await updateCategory(ADMIN, id, {
        name: "Spot Lights",
        description: "Text",
      }),
    );
    expectOk(
      await updateCategory(ADMIN, id, { name: "Spot Lights", description: "" }),
    );

    const row = await CategoryModel.findById(id).lean();
    expect(row && "description" in row).toBe(false);
    const last = await AuditLogModel.findOne({}).sort({ _id: -1 }).lean();
    expect(last?.meta).toEqual({ fields: ["description"] });
  });

  it("writes, audits and revalidates nothing when nothing changed", async () => {
    const id = await create("Spot Lights");
    const result = await updateCategory(ADMIN, id, {
      name: "Spot Lights",
      slug: "spot-lights",
    });
    expect(result).toEqual({ ok: true, data: { id }, tags: [] });
    expect(await auditActions()).toEqual(["category.create"]);
  });

  it("moves a leaf under a main category, last among its new siblings", async () => {
    const spot = await create("Spot Lights");
    await create("Recessed", spot);
    const loose = await create("Trimless");

    expectOk(
      await updateCategory(ADMIN, loose, { name: "Trimless", parent: spot }),
    );
    expect(await namesUnder(spot)).toEqual(["Recessed", "Trimless"]);
    const entry = await AuditLogModel.findOne({
      action: "category.update",
    }).lean();
    expect(entry?.meta).toEqual({ fields: ["parent"] });
  });

  it("refuses to move a category under a subcategory", async () => {
    const spot = await create("Spot Lights");
    const recessed = await create("Recessed", spot);
    const loose = await create("Trimless");

    const result = await updateCategory(ADMIN, loose, {
      name: "Trimless",
      parent: recessed,
    });
    expect(!result.ok && result.errors.fieldErrors.parent).toBeDefined();
    expect((await CategoryModel.findById(loose).lean())?.parent).toBeNull();
  });

  it("refuses to move a category that has subcategories under another one", async () => {
    const spot = await create("Spot Lights");
    await create("Recessed", spot);
    const track = await create("Track Lights");

    const result = await updateCategory(ADMIN, spot, {
      name: "Spot Lights",
      parent: track,
    });
    expect(!result.ok && result.errors.fieldErrors.parent).toEqual([
      expect.stringMatching(/has subcategories/),
    ]);
    expect((await CategoryModel.findById(spot).lean())?.parent).toBeNull();
  });

  it("refuses itself or its own subcategory as the parent", async () => {
    const spot = await create("Spot Lights");
    const recessed = await create("Recessed", spot);

    const self = await updateCategory(ADMIN, spot, {
      name: "Spot Lights",
      parent: spot,
    });
    expect(!self.ok && self.errors.fieldErrors.parent).toEqual([
      expect.stringMatching(/its own parent/),
    ]);
    const cycle = await updateCategory(ADMIN, spot, {
      name: "Spot Lights",
      parent: recessed,
    });
    expect(!cycle.ok && cycle.errors.fieldErrors.parent).toEqual([
      expect.stringMatching(/own subcategories/),
    ]);
  });

  it("refuses a move whose slug is already used under the new parent", async () => {
    const spot = await create("Spot Lights");
    await create("Trimless", spot);
    const loose = await create("Trimless");

    const result = await updateCategory(ADMIN, loose, {
      name: "Trimless",
      parent: spot,
    });
    expect(!result.ok && result.errors.fieldErrors.slug).toBeDefined();
    expect((await CategoryModel.findById(loose).lean())?.parent).toBeNull();
  });

  it("returns not found for an unknown or malformed id", async () => {
    for (const id of [new ObjectId().toHexString(), "nope", { $ne: null }]) {
      const result = await updateCategory(ADMIN, id, { name: "X" });
      expect(result).toEqual({
        ok: false,
        errors: {
          formErrors: [expect.stringMatching(/no longer exists/)],
          fieldErrors: {},
        },
        tags: [],
      });
    }
  });
});

describe("moveCategory", () => {
  it("swaps a category with its neighbour, audits it and returns the tree tag", async () => {
    await create("A");
    const b = await create("B");
    const c = await create("C");

    const result = await moveCategory(ADMIN, { id: b, direction: "up" });
    expect(result).toEqual({
      ok: true,
      data: { moved: true },
      tags: ["categories"],
    });
    expect(await namesUnder(null)).toEqual(["B", "A", "C"]);

    expectOk(await moveCategory(ADMIN, { id: b, direction: "down" }));
    expectOk(await moveCategory(ADMIN, { id: b, direction: "down" }));
    expect(await namesUnder(null)).toEqual(["A", "C", "B"]);

    const entry = await AuditLogModel.findOne({
      action: "category.reorder",
    }).lean();
    expect(entry).toMatchObject({ target: { type: "category", id: b } });
    expect(entry?.meta).toMatchObject({ direction: "up" });
    expect(c).toBeTruthy();
  });

  it("does nothing when the first moves up or the last moves down", async () => {
    const a = await create("A");
    const b = await create("B");

    expect(await moveCategory(ADMIN, { id: a, direction: "up" })).toEqual({
      ok: true,
      data: { moved: false },
      tags: [],
    });
    expect(
      (await moveCategory(ADMIN, { id: b, direction: "down" })).tags,
    ).toEqual([]);
    expect(await namesUnder(null)).toEqual(["A", "B"]);
    expect(await auditActions()).toEqual([
      "category.create",
      "category.create",
    ]);
  });

  it("only moves among siblings, not across parents", async () => {
    const spot = await create("Spot Lights");
    await create("Track Lights");
    const recessed = await create("Recessed", spot);

    expect(
      (await moveCategory(ADMIN, { id: recessed, direction: "up" })).ok,
    ).toBe(true);
    expect(await namesUnder(spot)).toEqual(["Recessed"]);
    expect(await namesUnder(null)).toEqual(["Spot Lights", "Track Lights"]);
  });

  it("still moves one place when siblings share the same order", async () => {
    await CategoryModel.create([
      { name: "A", slug: "a", parent: null, order: 0 },
      { name: "B", slug: "b", parent: null, order: 0 },
      { name: "C", slug: "c", parent: null, order: 0 },
    ]);
    const c = await CategoryModel.findOne({ slug: "c" }).lean();

    expectOk(
      await moveCategory(ADMIN, { id: c?._id.toHexString(), direction: "up" }),
    );
    expect(await namesUnder(null)).toEqual(["A", "C", "B"]);
  });

  it("rejects a bad direction and an unknown id", async () => {
    const a = await create("A");
    expect((await moveCategory(ADMIN, { id: a, direction: "left" })).ok).toBe(
      false,
    );
    const missing = await moveCategory(ADMIN, {
      id: new ObjectId().toHexString(),
      direction: "up",
    });
    expect(!missing.ok && missing.errors.formErrors).toEqual([
      expect.stringMatching(/no longer exists/),
    ]);
  });
});

describe("deleteCategory", () => {
  /* A draft product in `main`, optionally also listed under `extra`. */
  async function product(main: string, extra: string[] = []) {
    await ProductModel.create({
      name: "Arc",
      slug: `arc-${new ObjectId().toHexString()}`,
      mainCategory: new ObjectId(main),
      extraCategories: extra.map((id) => new ObjectId(id)),
    });
  }

  it("deletes an unused category, audits it and returns the tree tag", async () => {
    const spot = await create("Spot Lights");
    const recessed = await create("Recessed", spot);

    const result = await deleteCategory(ADMIN, recessed);
    expect(result).toEqual({
      ok: true,
      data: { id: recessed },
      tags: ["categories"],
    });
    expect(await CategoryModel.exists({ _id: recessed })).toBeNull();
    const entry = await AuditLogModel.findOne({
      action: "category.delete",
    }).lean();
    expect(entry).toMatchObject({
      target: { type: "category", id: recessed },
      meta: { parentId: spot },
    });
  });

  it("is blocked while the category has subcategories", async () => {
    const spot = await create("Spot Lights");
    await create("Recessed", spot);
    await create("Surface", spot);

    const result = await deleteCategory(ADMIN, spot);
    expect(result).toEqual({
      ok: false,
      errors: {
        formErrors: [expect.stringMatching(/2 subcategories/)],
        fieldErrors: {},
      },
      tags: [],
    });
    expect(await CategoryModel.exists({ _id: spot })).not.toBeNull();
  });

  it("is blocked while a product uses it as its main category", async () => {
    const spot = await create("Spot Lights");
    await product(spot);

    const result = await deleteCategory(ADMIN, spot);
    expect(!result.ok && result.errors.formErrors).toEqual([
      expect.stringMatching(/1 product uses it/),
    ]);
    expect(await CategoryModel.exists({ _id: spot })).not.toBeNull();
  });

  it("is blocked while a product lists it as an extra category", async () => {
    const spot = await create("Spot Lights");
    const recessed = await create("Recessed Lights");
    await product(spot, [recessed]);
    await product(spot, [recessed]);

    const result = await deleteCategory(ADMIN, recessed);
    expect(!result.ok && result.errors.formErrors).toEqual([
      expect.stringMatching(/2 products use it/),
    ]);
    expect(await CategoryModel.exists({ _id: recessed })).not.toBeNull();
    expect(await auditActions()).not.toContain("category.delete");
  });

  it("names both blockers at once", async () => {
    const spot = await create("Spot Lights");
    await create("Recessed", spot);
    await product(spot);

    const result = await deleteCategory(ADMIN, spot);
    expect(!result.ok && result.errors.formErrors).toHaveLength(2);
  });

  it("returns not found for an unknown or malformed id", async () => {
    for (const id of [new ObjectId().toHexString(), "x", 7]) {
      const result = await deleteCategory(ADMIN, id);
      expect(!result.ok && result.errors.formErrors).toEqual([
        expect.stringMatching(/no longer exists/),
      ]);
    }
  });

  it("keeps the deletion and still returns the tags when the audit write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spot = await create("Spot Lights");
    vi.spyOn(AuditLogModel, "create").mockRejectedValueOnce(new Error("down"));

    const result = await deleteCategory(ADMIN, spot);
    expect(result).toEqual({
      ok: false,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
      tags: ["categories"],
    });
    expect(await CategoryModel.exists({ _id: spot })).toBeNull();
  });
});

describe("reads", () => {
  it("lists the tree in display order with subcategories nested", async () => {
    const track = await create("Track Lights");
    const spot = await create("Spot Lights");
    await create("10mm", track);
    await create("5mm", track);
    await moveCategory(ADMIN, { id: spot, direction: "up" });

    const tree = await listCategoryTree();
    expect(tree.map((node) => node.name)).toEqual([
      "Spot Lights",
      "Track Lights",
    ]);
    expect(tree[1]?.children.map((node) => node.name)).toEqual(["10mm", "5mm"]);
    expect(tree[1]?.children[0]).toMatchObject({
      parentId: track,
      slug: "10mm",
      children: [],
    });
  });

  it("shows a category whose parent is missing at the top level", async () => {
    await CategoryModel.create({
      name: "Lost",
      slug: "lost",
      parent: new ObjectId(),
    });
    expect((await listCategoryTree()).map((node) => node.name)).toEqual([
      "Lost",
    ]);
  });

  it("loads one category for the edit form, or null", async () => {
    const spot = await create("Spot Lights");
    const recessed = await create("Recessed", spot);

    expect(await getCategoryForEdit(recessed)).toEqual({
      id: recessed,
      name: "Recessed",
      slug: "recessed",
      parentId: spot,
      description: null,
    });
    expect(await getCategoryForEdit(new ObjectId().toHexString())).toBeNull();
    expect(await getCategoryForEdit({ $ne: null })).toBeNull();
  });
});
