// Admin services for the application areas: list, read one for the edit form,
// create, edit, move up/down and delete. Each write re-parses with Zod,
// records an audit entry and returns the cache tags it touched (ADR 0035).

import "server-only";

import type { Types } from "mongoose";

import { connectDb, mongoose } from "@/lib/db";
import { CATALOG_TAGS, type CatalogTag } from "@/lib/revalidate";
import {
  areaIdSchema,
  areaInputSchema,
  moveAreaSchema,
  type AreaInput,
} from "@/lib/schemas/area";
import { uniqueSlug, UniqueSlugError } from "@/lib/slug";
import { AreaModel, ProductModel } from "@/models";
import type { Area } from "@/models/area";

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
 * Tags per write. Product pages and listings show area names and slugs, so an
 * edit also expires `products`. Create, move and delete only change the list
 * itself: a new area has no products yet, and an area can only be deleted
 * once no product uses it.
 */
const LIST_TAGS: CatalogTag[] = [CATALOG_TAGS.areas];
const EDIT_TAGS: CatalogTag[] = [CATALOG_TAGS.areas, CATALOG_TAGS.products];

const NOT_FOUND = "This area no longer exists. Reload the page.";
const SLUG_TAKEN = "Another area already uses this slug.";

/** One row of the admin list. */
export interface AreaListItem {
  id: string;
  name: string;
  slug: string;
  bwImage: string | null;
  order: number;
}

/** What the edit form is filled with. */
export interface AreaForEdit {
  id: string;
  name: string;
  slug: string;
  bwImage: string | null;
}

/* Only the fields the admin list and form show. */
const PROJECTION = { name: 1, slug: 1, bwImage: 1, order: 1 } as const;
type AreaRow = Pick<Area, "_id" | "name" | "slug" | "bwImage" | "order">;

/* Display order; `_id` breaks ties so the order is stable. */
const DISPLAY_ORDER = { order: 1, _id: 1 } as const;

// ---------------------------------------------------------------------------
// Reads (admin only, never cached)
// ---------------------------------------------------------------------------

/** All areas in display order (a handful of rows, one query). */
export async function listAreas(): Promise<AreaListItem[]> {
  await connectDb();
  const rows = await AreaModel.find({}, PROJECTION)
    .sort(DISPLAY_ORDER)
    .lean<AreaRow[]>();
  return rows.map((row) => ({
    id: row._id.toHexString(),
    name: row.name,
    slug: row.slug,
    bwImage: row.bwImage ?? null,
    order: row.order,
  }));
}

/** One area for the edit form, or null if the id is bad or unknown. */
export async function getAreaForEdit(id: unknown): Promise<AreaForEdit | null> {
  const parsedId = areaIdSchema.safeParse(id);
  if (!parsedId.success) return null;

  await connectDb();
  const row = await AreaModel.findById(
    parsedId.data,
    PROJECTION,
  ).lean<AreaRow | null>();
  if (!row) return null;
  return {
    id: row._id.toHexString(),
    name: row.name,
    slug: row.slug,
    bwImage: row.bwImage ?? null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/* True when another area (not `self`) uses `slug`. Uses the unique slug index. */
async function slugTaken(
  slug: string,
  self?: Types.ObjectId,
): Promise<boolean> {
  const filter = self ? { slug, _id: { $ne: self } } : { slug };
  return (await AreaModel.exists(filter)) !== null;
}

/* The order that puts an area last. */
async function nextOrder(): Promise<number> {
  const last = await AreaModel.findOne({}, { order: 1 })
    .sort({ order: -1 })
    .lean<Pick<Area, "order"> | null>();
  return last ? last.order + 1 : 0;
}

/*
 * The slug to save on create: the typed one if free, otherwise the first
 * free slug made from the name.
 */
async function resolveSlug(
  values: AreaInput,
): Promise<
  { ok: true; value: string } | { ok: false; result: ServiceResult<never> }
> {
  if (values.slug !== "") {
    return (await slugTaken(values.slug))
      ? { ok: false, result: fieldError("slug", SLUG_TAKEN) }
      : { ok: true, value: values.slug };
  }
  try {
    return { ok: true, value: await uniqueSlug(values.name, slugTaken) };
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

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Creates an area last in the list. An empty slug is made from the name
 * ("-2", "-3" ... if taken); a typed slug must be free.
 */
export async function createArea(
  actorId: string,
  input: unknown,
): Promise<ServiceResult<{ id: string }>> {
  assertActorId(actorId);
  await connectDb();

  const parsed = areaInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const values = parsed.data;

  const slug = await resolveSlug(values);
  if (!slug.ok) return slug.result;

  let id: Types.ObjectId;
  try {
    const created = await AreaModel.create({
      name: values.name,
      slug: slug.value,
      order: await nextOrder(),
      ...(values.bwImage === null ? {} : { bwImage: values.bwImage }),
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
      action: "area.create",
      target: { type: "area", id: id.toHexString() },
    },
    { id: id.toHexString() },
    LIST_TAGS,
  );
}

/**
 * Saves the edit form. An empty slug keeps the current one. When nothing
 * changed, nothing is written, audited or revalidated.
 */
export async function updateArea(
  actorId: string,
  id: unknown,
  input: unknown,
): Promise<ServiceResult<{ id: string }>> {
  assertActorId(actorId);
  await connectDb();

  const parsedId = areaIdSchema.safeParse(id);
  if (!parsedId.success) return formError(NOT_FOUND);
  const parsed = areaInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const values = parsed.data;
  const selfId = new ObjectId(parsedId.data);

  const current = await AreaModel.findById(
    selfId,
    PROJECTION,
  ).lean<AreaRow | null>();
  if (!current) return formError(NOT_FOUND);

  const slug = values.slug === "" ? current.slug : values.slug;

  // Only the changed fields: their names go into the audit entry.
  const set: Partial<Pick<Area, "name" | "slug" | "bwImage">> = {};
  const fields: string[] = [];
  if (values.name !== current.name) {
    set.name = values.name;
    fields.push("name");
  }
  if (slug !== current.slug) {
    set.slug = slug;
    fields.push("slug");
  }
  const bwImage = current.bwImage ?? null;
  const unsetBwImage = values.bwImage === null && bwImage !== null;
  if (values.bwImage !== null && values.bwImage !== bwImage) {
    set.bwImage = values.bwImage;
  }
  if (unsetBwImage || set.bwImage !== undefined) fields.push("bwImage");

  if (fields.length === 0) return unchanged({ id: parsedId.data });

  if (set.slug !== undefined && (await slugTaken(slug, selfId))) {
    return fieldError("slug", SLUG_TAKEN);
  }

  try {
    const result = await AreaModel.updateOne(
      { _id: selfId },
      {
        $set: set,
        ...(unsetBwImage ? { $unset: { bwImage: 1 } } : {}),
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
      action: "area.update",
      target: { type: "area", id: parsedId.data },
      meta: { fields },
    },
    { id: parsedId.data },
    EDIT_TAGS,
  );
}

/**
 * Moves an area one place up or down by swapping positions. Areas are
 * renumbered 0, 1, 2 ... in the new order, writing only rows whose `order`
 * changes (this also repairs gaps or ties). Moving the first one up or the
 * last one down changes nothing.
 */
export async function moveArea(
  actorId: string,
  input: unknown,
): Promise<ServiceResult<{ moved: boolean }>> {
  assertActorId(actorId);
  await connectDb();

  const parsed = moveAreaSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const selfId = new ObjectId(parsed.data.id);

  const rows = await AreaModel.find({}, { order: 1 })
    .sort(DISPLAY_ORDER)
    .lean<Pick<Area, "_id" | "order">[]>();
  const index = rows.findIndex((row) => row._id.equals(selfId));
  if (index === -1) return formError(NOT_FOUND);

  const swapWith = parsed.data.direction === "up" ? index - 1 : index + 1;
  const neighbour = rows[swapWith];
  const mine = rows[index];
  if (!neighbour || !mine) return unchanged({ moved: false });

  rows[index] = neighbour;
  rows[swapWith] = mine;
  const updates = rows.flatMap((row, order) =>
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
  await AreaModel.bulkWrite(updates, { ordered: true });

  return auditAndFinish(
    {
      actorId,
      action: "area.reorder",
      target: { type: "area", id: parsed.data.id },
      meta: {
        direction: parsed.data.direction,
        swappedWithId: neighbour._id.toHexString(),
      },
    },
    { moved: true },
    LIST_TAGS,
  );
}

/**
 * Deletes an area, refused while any product lists it. The admin is told how
 * many products, so they know what to change first.
 */
export async function deleteArea(
  actorId: string,
  id: unknown,
): Promise<ServiceResult<{ id: string }>> {
  assertActorId(actorId);
  await connectDb();

  const parsedId = areaIdSchema.safeParse(id);
  if (!parsedId.success) return formError(NOT_FOUND);
  const selfId = new ObjectId(parsedId.data);

  const exists = await AreaModel.exists({ _id: selfId });
  if (!exists) return formError(NOT_FOUND);

  // Uses the { areas } index.
  const products = await ProductModel.countDocuments({ areas: selfId });
  if (products > 0) {
    return formError(
      `${products} ${products === 1 ? "product uses" : "products use"} this area. Remove it from them first.`,
    );
  }

  const result = await AreaModel.deleteOne({ _id: selfId });
  if (result.deletedCount === 0) return formError(NOT_FOUND);

  return auditAndFinish(
    {
      actorId,
      action: "area.delete",
      target: { type: "area", id: parsedId.data },
    },
    { id: parsedId.data },
    LIST_TAGS,
  );
}
