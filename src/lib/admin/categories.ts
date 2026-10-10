// Admin services for the category tree: read the tree, create, edit, move
// up/down, delete, and set the icon / cover image (verified direct uploads).
// Each write re-parses with Zod, enforces the tree rules, records an audit
// entry and returns the cache tags it touched (ADR 0035).

import "server-only";

import type { Types } from "mongoose";

import { MAX_CATEGORY_DEPTH } from "@/lib/constants";
import { connectDb, mongoose } from "@/lib/db";
import { CATALOG_TAGS, type CatalogTag } from "@/lib/revalidate";
import type { SignedUpload } from "@/lib/cloudinary";
import {
  CATEGORY_IMAGE_FORMATS,
  categoryIdSchema,
  categoryInputSchema,
  moveCategorySchema,
  setCategoryImageSchema,
  signCategoryImageSchema,
  type CategoryImageSlot,
  type CategoryInput,
} from "@/lib/schemas/category";
import { uniqueSlug, UniqueSlugError } from "@/lib/slug";
import { CategoryModel, ProductModel } from "@/models";
import type { Category } from "@/models/category";

import { assertAdminActor, refuseUnlessAdmin, type AdminActor } from "./actor";
import { signCloudinaryUpload, verifyUploadedImage } from "./uploads";
import {
  auditAndFinish,
  fieldError,
  formError,
  invalidInput,
  isDuplicateKeyError,
  unchanged,
  type ServiceResult,
} from "./write-result";

const { ObjectId } = mongoose.Types;

/*
 * Tags per write. Product pages and listings show category names and slugs
 * (breadcrumbs, filters), so an edit also expires `products`. Create, move
 * and delete only change the tree itself: a new category has no products
 * yet, and a category can only be deleted once no product uses it.
 */
const TREE_TAGS: CatalogTag[] = [CATALOG_TAGS.categories];
const EDIT_TAGS: CatalogTag[] = [
  CATALOG_TAGS.categories,
  CATALOG_TAGS.products,
];

const NOT_FOUND = "This category no longer exists. Reload the page.";
const SLUG_TAKEN =
  "Another category under the same parent already uses this slug.";

/** One row of the admin tree. */
export interface CategoryTreeNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  order: number;
  description: string | null;
  children: CategoryTreeNode[];
}

/** What the edit page is filled with (form fields + the two images). */
export interface CategoryForEdit {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  description: string | null;
  /** Cloudinary public id of the mega-menu icon, or null. */
  icon: string | null;
  /** Cloudinary public id of the cover image, or null. */
  coverImage: string | null;
}

/* Only the fields the admin tree and form show. */
const TREE_PROJECTION = {
  name: 1,
  slug: 1,
  parent: 1,
  order: 1,
  description: 1,
} as const;
type CategoryRow = Pick<
  Category,
  "_id" | "name" | "slug" | "parent" | "order" | "description"
>;

/* The edit page also shows the stored images. */
const EDIT_PROJECTION = { ...TREE_PROJECTION, icon: 1, coverImage: 1 } as const;
type CategoryEditRow = CategoryRow & Pick<Category, "icon" | "coverImage">;

/* Siblings in display order; `_id` breaks ties so the order is stable. */
const DISPLAY_ORDER = { order: 1, _id: 1 } as const;

// ---------------------------------------------------------------------------
// Reads (admin only, never cached)
// ---------------------------------------------------------------------------

/**
 * The whole tree for the admin panel: main categories in display order, each
 * with its subcategories in display order. One query; the tree is small
 * (tens of categories). A row whose parent is missing is shown at the top
 * level, so it stays visible and can be fixed or deleted.
 */
export async function listCategoryTree(
  actor: AdminActor,
): Promise<CategoryTreeNode[]> {
  await assertAdminActor(actor);
  await connectDb();
  const rows = await CategoryModel.find({}, TREE_PROJECTION)
    .sort(DISPLAY_ORDER)
    .lean<CategoryRow[]>();

  const nodes = new Map<string, CategoryTreeNode>();
  for (const row of rows) {
    nodes.set(row._id.toHexString(), {
      id: row._id.toHexString(),
      name: row.name,
      slug: row.slug,
      parentId: row.parent?.toHexString() ?? null,
      order: row.order,
      description: row.description ?? null,
      children: [],
    });
  }

  const roots: CategoryTreeNode[] = [];
  // Rows are already sorted, so appending keeps each level in display order.
  for (const node of nodes.values()) {
    const parent =
      node.parentId === null ? undefined : nodes.get(node.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** One category for the edit form, or null if the id is bad or unknown. */
export async function getCategoryForEdit(
  actor: AdminActor,
  id: unknown,
): Promise<CategoryForEdit | null> {
  await assertAdminActor(actor);
  const parsedId = categoryIdSchema.safeParse(id);
  if (!parsedId.success) return null;

  await connectDb();
  const row = await CategoryModel.findById(
    parsedId.data,
    EDIT_PROJECTION,
  ).lean<CategoryEditRow | null>();
  if (!row) return null;
  return {
    id: row._id.toHexString(),
    name: row.name,
    slug: row.slug,
    parentId: row.parent?.toHexString() ?? null,
    description: row.description ?? null,
    icon: row.icon ?? null,
    coverImage: row.coverImage ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tree rules
// ---------------------------------------------------------------------------

/*
 * Depth of a category: 1 for a main category, 2 for its subcategory ...
 * Walks up the parent chain, at most MAX_CATEGORY_DEPTH + 1 steps, so a
 * corrupt chain cannot loop. Returns null when the category is missing, and
 * `cycle: true` when `forbidden` (the category being moved) is an ancestor.
 */
async function depthOf(
  id: Types.ObjectId,
  forbidden?: Types.ObjectId,
): Promise<{ depth: number; cycle: boolean } | null> {
  let current: Types.ObjectId | null = id;
  let depth = 0;
  while (current !== null && depth <= MAX_CATEGORY_DEPTH) {
    if (forbidden?.equals(current)) return { depth, cycle: true };
    const row: Pick<Category, "parent"> | null = await CategoryModel.findById(
      current,
      { parent: 1 },
    ).lean<Pick<Category, "parent"> | null>();
    if (!row) return depth === 0 ? null : { depth, cycle: false };
    depth += 1;
    current = row.parent;
  }
  return { depth, cycle: false };
}

/*
 * How many levels hang below a category: 0 for a leaf, 1 if it has children
 * but no grandchildren ... One query per level, at most MAX_CATEGORY_DEPTH.
 */
async function subtreeHeight(id: Types.ObjectId): Promise<number> {
  let frontier: Types.ObjectId[] = [id];
  let height = 0;
  while (frontier.length > 0 && height < MAX_CATEGORY_DEPTH) {
    const children: { _id: Types.ObjectId }[] = await CategoryModel.find(
      { parent: { $in: frontier } },
      { _id: 1 },
    ).lean<{ _id: Types.ObjectId }[]>();
    if (children.length === 0) break;
    height += 1;
    frontier = children.map((child) => child._id);
  }
  return height;
}

/**
 * Checks that `parentId` may hold `self` (absent on create): the parent
 * exists, is not `self` or one of its descendants, and the deepest category
 * in `self`'s subtree stays within MAX_CATEGORY_DEPTH. With the depth at 2
 * this means: the parent must be a main category, and a category that has
 * subcategories must stay a main category. Returns an error message or null.
 */
async function parentProblem(
  parentId: Types.ObjectId | null,
  self?: Types.ObjectId,
): Promise<string | null> {
  if (parentId === null) return null;
  if (self?.equals(parentId)) return "A category cannot be its own parent.";

  const parent = await depthOf(parentId, self);
  if (!parent) return "The chosen parent category no longer exists.";
  if (parent.cycle) {
    return "A category cannot be moved under one of its own subcategories.";
  }

  const height = self ? await subtreeHeight(self) : 0;
  if (parent.depth + 1 + height > MAX_CATEGORY_DEPTH) {
    return height > 0
      ? "This category has subcategories, so it cannot be moved that deep."
      : `Categories can be at most ${MAX_CATEGORY_DEPTH} levels deep: choose a main category as the parent.`;
  }
  return null;
}

/* True when a sibling under `parent` (other than `self`) uses `slug`. */
async function slugTaken(
  parent: Types.ObjectId | null,
  slug: string,
  self?: Types.ObjectId,
): Promise<boolean> {
  const filter = self ? { parent, slug, _id: { $ne: self } } : { parent, slug };
  // Uses the unique { parent, slug } index.
  return (await CategoryModel.exists(filter)) !== null;
}

/* The order that puts a category last under `parent`. */
async function nextOrder(parent: Types.ObjectId | null): Promise<number> {
  // Uses the { parent, order } index.
  const last = await CategoryModel.findOne({ parent }, { order: 1 })
    .sort({ order: -1 })
    .lean<Pick<Category, "order"> | null>();
  return last ? last.order + 1 : 0;
}

function toObjectId(id: string | null): Types.ObjectId | null {
  return id === null ? null : new ObjectId(id);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Creates a category last among its siblings. An empty slug is made from the
 * name ("-2", "-3" ... if taken); a typed slug must be free under the parent.
 */
export async function createCategory(
  actor: AdminActor,
  input: unknown,
): Promise<ServiceResult<{ id: string }>> {
  const refused = await refuseUnlessAdmin(actor, "categories");
  if (refused) return refused;
  await connectDb();

  const parsed = categoryInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const values = parsed.data;
  const parent = toObjectId(values.parent);

  const problem = await parentProblem(parent);
  if (problem) return fieldError("parent", problem);

  const slug = await resolveSlug(values, parent);
  if (!slug.ok) return slug.result;

  let id: Types.ObjectId;
  try {
    const created = await CategoryModel.create({
      name: values.name,
      slug: slug.value,
      parent,
      order: await nextOrder(parent),
      ...(values.description === null
        ? {}
        : { description: values.description }),
    });
    id = created._id;
  } catch (error) {
    // Another write took the slug between the check and the insert.
    if (isDuplicateKeyError(error)) return fieldError("slug", SLUG_TAKEN);
    throw error;
  }

  return auditAndFinish(
    {
      actorId: actor.id,
      action: "category.create",
      target: { type: "category", id: id.toHexString() },
      meta: { parentId: parent?.toHexString() ?? null },
    },
    { id: id.toHexString() },
    TREE_TAGS,
  );
}

/*
 * The slug to save on create: the typed one if free, otherwise the first
 * free slug made from the name.
 */
async function resolveSlug(
  values: CategoryInput,
  parent: Types.ObjectId | null,
): Promise<
  { ok: true; value: string } | { ok: false; result: ServiceResult<never> }
> {
  if (values.slug !== "") {
    return (await slugTaken(parent, values.slug))
      ? { ok: false, result: fieldError("slug", SLUG_TAKEN) }
      : { ok: true, value: values.slug };
  }
  try {
    return {
      ok: true,
      value: await uniqueSlug(values.name, (slug) => slugTaken(parent, slug)),
    };
  } catch (error) {
    if (error instanceof UniqueSlugError) {
      return {
        ok: false,
        result: fieldError(
          "slug",
          "Enter a slug: one could not be made from the name.",
        ),
      };
    }
    throw error;
  }
}

/**
 * Saves the edit form. An empty slug keeps the current one. Moving the
 * category to another parent puts it last there. When nothing changed,
 * nothing is written, audited or revalidated.
 */
export async function updateCategory(
  actor: AdminActor,
  id: unknown,
  input: unknown,
): Promise<ServiceResult<{ id: string }>> {
  const refused = await refuseUnlessAdmin(actor, "categories");
  if (refused) return refused;
  await connectDb();

  const parsedId = categoryIdSchema.safeParse(id);
  if (!parsedId.success) return formError(NOT_FOUND);
  const parsed = categoryInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const values = parsed.data;
  const selfId = new ObjectId(parsedId.data);

  const current = await CategoryModel.findById(
    selfId,
    TREE_PROJECTION,
  ).lean<CategoryRow | null>();
  if (!current) return formError(NOT_FOUND);

  const parent = toObjectId(values.parent);
  const slug = values.slug === "" ? current.slug : values.slug;
  const parentChanged = !sameId(current.parent, parent);

  // Only the changed fields: their names go into the audit entry.
  const set: Partial<
    Pick<Category, "name" | "slug" | "parent" | "order" | "description">
  > = {};
  const fields: string[] = [];
  if (values.name !== current.name) {
    set.name = values.name;
    fields.push("name");
  }
  if (slug !== current.slug) {
    set.slug = slug;
    fields.push("slug");
  }
  if (parentChanged) {
    set.parent = parent;
    fields.push("parent");
  }
  const description = current.description ?? null;
  const unsetDescription = values.description === null && description !== null;
  if (values.description !== null && values.description !== description) {
    set.description = values.description;
  }
  if (unsetDescription || set.description !== undefined)
    fields.push("description");

  if (fields.length === 0) return unchanged({ id: parsedId.data });

  if (parentChanged) {
    const problem = await parentProblem(parent, selfId);
    if (problem) return fieldError("parent", problem);
    set.order = await nextOrder(parent);
  }
  if (
    (parentChanged || set.slug !== undefined) &&
    (await slugTaken(parent, slug, selfId))
  ) {
    return fieldError("slug", SLUG_TAKEN);
  }

  try {
    const result = await CategoryModel.updateOne(
      { _id: selfId },
      {
        $set: set,
        ...(unsetDescription ? { $unset: { description: 1 } } : {}),
      },
      { runValidators: true },
    );
    // Deleted between the read and the write.
    if (result.matchedCount === 0) return formError(NOT_FOUND);
  } catch (error) {
    if (isDuplicateKeyError(error)) return fieldError("slug", SLUG_TAKEN);
    throw error;
  }

  return auditAndFinish(
    {
      actorId: actor.id,
      action: "category.update",
      target: { type: "category", id: parsedId.data },
      meta: { fields },
    },
    { id: parsedId.data },
    EDIT_TAGS,
  );
}

function sameId(a: Types.ObjectId | null, b: Types.ObjectId | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

/**
 * Moves a category one place up or down among its siblings by swapping
 * positions. Siblings are renumbered 0, 1, 2 ... in the new order, writing
 * only rows whose `order` changes; with clean data that is exactly the two
 * swapped rows, and it also repairs gaps or ties left by older moves.
 * Moving the first one up (or the last one down) changes nothing.
 */
export async function moveCategory(
  actor: AdminActor,
  input: unknown,
): Promise<ServiceResult<{ moved: boolean }>> {
  const refused = await refuseUnlessAdmin(actor, "categories");
  if (refused) return refused;
  await connectDb();

  const parsed = moveCategorySchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const selfId = new ObjectId(parsed.data.id);

  const self = await CategoryModel.findById(selfId, { parent: 1 }).lean<Pick<
    Category,
    "_id" | "parent"
  > | null>();
  if (!self) return formError(NOT_FOUND);

  const siblings = await CategoryModel.find(
    { parent: self.parent },
    { order: 1 },
  )
    .sort(DISPLAY_ORDER)
    .lean<Pick<Category, "_id" | "order">[]>();
  const index = siblings.findIndex((row) => row._id.equals(selfId));
  const swapWith = parsed.data.direction === "up" ? index - 1 : index + 1;
  const neighbour = siblings[swapWith];
  const mine = siblings[index];
  if (!neighbour || !mine) return unchanged({ moved: false });

  siblings[index] = neighbour;
  siblings[swapWith] = mine;
  const updates = siblings.flatMap((row, order) =>
    row.order === order
      ? []
      : [
          {
            updateOne: {
              filter: { _id: row._id },
              update: { $set: { order } },
            },
          },
        ],
  );
  await CategoryModel.bulkWrite(updates, { ordered: true });

  return auditAndFinish(
    {
      actorId: actor.id,
      action: "category.reorder",
      target: { type: "category", id: parsed.data.id },
      meta: {
        direction: parsed.data.direction,
        swappedWithId: neighbour._id.toHexString(),
      },
    },
    { moved: true },
    TREE_TAGS,
  );
}

/**
 * Deletes a category, refused while it has subcategories or while any
 * product lists it as its main or an extra category. The admin is told how
 * many, so they know what to move first.
 */
export async function deleteCategory(
  actor: AdminActor,
  id: unknown,
): Promise<ServiceResult<{ id: string }>> {
  const refused = await refuseUnlessAdmin(actor, "categories");
  if (refused) return refused;
  await connectDb();

  const parsedId = categoryIdSchema.safeParse(id);
  if (!parsedId.success) return formError(NOT_FOUND);
  const selfId = new ObjectId(parsedId.data);

  const self = await CategoryModel.findById(selfId, { parent: 1 }).lean<Pick<
    Category,
    "_id" | "parent"
  > | null>();
  if (!self) return formError(NOT_FOUND);

  const [children, products] = await Promise.all([
    // Prefix of the { parent, slug } index.
    CategoryModel.countDocuments({ parent: selfId }),
    // Each branch uses its own index ({ mainCategory }, { extraCategories }).
    ProductModel.countDocuments({
      $or: [{ mainCategory: selfId }, { extraCategories: selfId }],
    }),
  ]);
  const blockers: string[] = [];
  if (children > 0) {
    blockers.push(
      `It has ${plural(children, "subcategory", "subcategories")}. Move or delete them first.`,
    );
  }
  if (products > 0) {
    blockers.push(
      `${plural(products, "product uses", "products use")} it. Move them to another category first.`,
    );
  }
  if (blockers.length > 0) return formError(...blockers);

  const result = await CategoryModel.deleteOne({ _id: selfId });
  if (result.deletedCount === 0) return formError(NOT_FOUND);

  return auditAndFinish(
    {
      actorId: actor.id,
      action: "category.delete",
      target: { type: "category", id: parsedId.data },
      meta: { parentId: self.parent?.toHexString() ?? null },
    },
    { id: parsedId.data },
    TREE_TAGS,
  );
}

// ---------------------------------------------------------------------------
// Icon and cover image (ADR 0045 direct uploads, Phase 4b Q7)
// ---------------------------------------------------------------------------

/* The model field each slot is stored in. */
const IMAGE_FIELD: Record<CategoryImageSlot, "icon" | "coverImage"> = {
  icon: "icon",
  cover: "coverImage",
};

/**
 * Signs one direct browser upload of a category's icon or cover, under the
 * category's own folder (`yg/categories/<id>/<uuid>`), accepting only that
 * slot's formats (icon: png, svg, webp; cover: jpg, png, webp). Nothing is
 * written, so there are no tags.
 */
export async function signCategoryImageUpload(
  actor: AdminActor,
  input: unknown,
): Promise<ServiceResult<SignedUpload>> {
  const refused = await refuseUnlessAdmin(actor, "categories");
  if (refused) return refused;
  const parsed = signCategoryImageSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { categoryId, slot } = parsed.data;
  // signCloudinaryUpload re-checks the actor (one more session read).
  return signCloudinaryUpload(
    actor,
    { target: "category", id: categoryId },
    { formats: CATEGORY_IMAGE_FORMATS[slot] },
  );
}

/* The refusal when an id is already this category's image in the other slot. */
const IMAGE_IN_OTHER_SLOT: Record<CategoryImageSlot, string> = {
  icon: "This image is already the cover. Upload a separate icon.",
  cover: "This image is already the icon. Upload a separate cover.",
};

/* True when `publicId` is stored in either image slot of the category. */
function isStoredImage(
  category: Pick<Category, "icon" | "coverImage">,
  publicId: string,
): boolean {
  return category.icon === publicId || category.coverImage === publicId;
}

/**
 * Sets or clears a category's icon or cover. A new id must be an upload in
 * this category's own folder that passes verification (exists, size, the
 * slot's formats); a rejected upload is deleted from Cloudinary and nothing
 * is saved. An id already stored in either slot is refused without any
 * check, so a live image is never destroyed (gate-A L-1). The replaced image is not deleted (ADR 0045 point 5): the
 * orphan sweep removes it once nothing references it. Only the public tree
 * shows these images, so the tag is `categories`. The audit entry names the
 * field only, never the id.
 */
export async function setCategoryImage(
  actor: AdminActor,
  input: unknown,
): Promise<
  ServiceResult<{
    id: string;
    slot: CategoryImageSlot;
    publicId: string | null;
  }>
> {
  const refused = await refuseUnlessAdmin(actor, "categories");
  if (refused) return refused;
  const parsed = setCategoryImageSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { categoryId, slot, publicId } = parsed.data;
  const field = IMAGE_FIELD[slot];
  const selfId = new ObjectId(categoryId);

  await connectDb();
  // Both slots: an id already stored on this category is live, so it is
  // never verified as a new upload (a refused one would be destroyed).
  const current = await CategoryModel.findById(selfId, {
    icon: 1,
    coverImage: 1,
  }).lean<Pick<Category, "icon" | "coverImage"> | null>();
  if (!current) return formError(NOT_FOUND);
  if ((current[field] ?? null) === publicId) {
    return unchanged({ id: categoryId, slot, publicId });
  }
  if (publicId !== null && isStoredImage(current, publicId)) {
    return fieldError("publicId", IMAGE_IN_OTHER_SLOT[slot]);
  }

  if (publicId !== null) {
    const check = await verifyUploadedImage(
      { target: "category", id: categoryId, publicId },
      { formats: CATEGORY_IMAGE_FORMATS[slot] },
    );
    if (!check.ok) return fieldError("publicId", check.message);
  }

  const result = await CategoryModel.updateOne(
    { _id: selfId },
    publicId === null
      ? { $unset: { [field]: 1 } }
      : { $set: { [field]: publicId } },
    { runValidators: true },
  );
  if (result.matchedCount === 0) return formError(NOT_FOUND);

  return auditAndFinish(
    {
      actorId: actor.id,
      action: "category.update",
      target: { type: "category", id: categoryId },
      meta: { fields: [field], cleared: publicId === null },
    },
    { id: categoryId, slot, publicId },
    TREE_TAGS,
  );
}

/* "1 subcategory", "3 subcategories". */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
