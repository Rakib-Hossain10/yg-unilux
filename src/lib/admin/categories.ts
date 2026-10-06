// Admin services for the category tree: read the tree, create, edit, move
// up/down and delete. Each write re-parses with Zod, enforces the tree rules,
// records an audit entry and returns the cache tags it touched (ADR 0035).

import "server-only";

import type { Types } from "mongoose";

import { MAX_CATEGORY_DEPTH } from "@/lib/constants";
import { connectDb, mongoose } from "@/lib/db";
import { CATALOG_TAGS, type CatalogTag } from "@/lib/revalidate";
import {
  categoryIdSchema,
  categoryInputSchema,
  moveCategorySchema,
  type CategoryInput,
} from "@/lib/schemas/category";
import { uniqueSlug, UniqueSlugError } from "@/lib/slug";
import { CategoryModel, ProductModel } from "@/models";
import type { Category } from "@/models/category";

import {
  assertActorId,
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

/** What the edit form is filled with. */
export interface CategoryForEdit {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  description: string | null;
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
export async function listCategoryTree(): Promise<CategoryTreeNode[]> {
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
  id: unknown,
): Promise<CategoryForEdit | null> {
  const parsedId = categoryIdSchema.safeParse(id);
  if (!parsedId.success) return null;

  await connectDb();
  const row = await CategoryModel.findById(
    parsedId.data,
    TREE_PROJECTION,
  ).lean<CategoryRow | null>();
  if (!row) return null;
  return {
    id: row._id.toHexString(),
    name: row.name,
    slug: row.slug,
    parentId: row.parent?.toHexString() ?? null,
    description: row.description ?? null,
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
  actorId: string,
  input: unknown,
): Promise<ServiceResult<{ id: string }>> {
  assertActorId(actorId);
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
      actorId,
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
  actorId: string,
  id: unknown,
  input: unknown,
): Promise<ServiceResult<{ id: string }>> {
  assertActorId(actorId);
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
      actorId,
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
  actorId: string,
  input: unknown,
): Promise<ServiceResult<{ moved: boolean }>> {
  assertActorId(actorId);
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
      actorId,
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
  actorId: string,
  id: unknown,
): Promise<ServiceResult<{ id: string }>> {
  assertActorId(actorId);
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
      actorId,
      action: "category.delete",
      target: { type: "category", id: parsedId.data },
      meta: { parentId: self.parent?.toHexString() ?? null },
    },
    { id: parsedId.data },
    TREE_TAGS,
  );
}

/* "1 subcategory", "3 subcategories". */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
