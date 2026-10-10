// Admin services for the application areas: list, read one for the edit form,
// create, edit, set its b/w image, move up/down and delete. Each write
// re-parses with Zod, records an audit entry and returns its tags (ADR 0035).

import "server-only";

import type { Types } from "mongoose";
import { z } from "zod";

import { connectDb, mongoose } from "@/lib/db";
import { CATALOG_TAGS, type CatalogTag } from "@/lib/revalidate";
import {
  areaIdSchema,
  areaInputSchema,
  moveAreaSchema,
  type AreaInput,
} from "@/lib/schemas/area";
import { objectIdSchema, optionalPublicIdSchema } from "@/lib/schemas/common";
import { uniqueSlug, UniqueSlugError } from "@/lib/slug";
import { AreaModel, ProductModel } from "@/models";
import type { Area } from "@/models/area";

import { assertAdminActor, refuseUnlessAdmin, type AdminActor } from "./actor";
import { verifyUploadedImage } from "./uploads";
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
 * Tags per write. Product pages and listings show area names and slugs, so an
 * edit also expires `products`. Create, move and delete only change the list
 * itself: a new area has no products yet, and an area can only be deleted
 * once no product uses it.
 */
const LIST_TAGS: CatalogTag[] = [CATALOG_TAGS.areas];
const EDIT_TAGS: CatalogTag[] = [CATALOG_TAGS.areas, CATALOG_TAGS.products];

const NOT_FOUND = "This area no longer exists. Reload the page.";
const SLUG_TAKEN = "Another area already uses this slug.";
/*
 * A new b/w image is set only through setAreaImage(), which verifies the
 * upload. The form may keep or clear the stored one.
 */
export const BW_IMAGE_USE_UPLOADER =
  "Use the image uploader to change this image.";
export const BW_IMAGE_AFTER_CREATE =
  "Save the area first, then upload its image.";

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
export async function listAreas(actor: AdminActor): Promise<AreaListItem[]> {
  await assertAdminActor(actor);
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
export async function getAreaForEdit(
  actor: AdminActor,
  id: unknown,
): Promise<AreaForEdit | null> {
  await assertAdminActor(actor);
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
  actor: AdminActor,
  input: unknown,
): Promise<ServiceResult<{ id: string }>> {
  const refused = await refuseUnlessAdmin(actor, "areas");
  if (refused) return refused;
  await connectDb();

  const parsed = areaInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const values = parsed.data;
  // The upload folder is named after the area id, which doesn't exist yet.
  if (values.bwImage !== null) {
    return fieldError("bwImage", BW_IMAGE_AFTER_CREATE);
  }

  const slug = await resolveSlug(values);
  if (!slug.ok) return slug.result;

  let id: Types.ObjectId;
  try {
    const created = await AreaModel.create({
      name: values.name,
      slug: slug.value,
      order: await nextOrder(),
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
  actor: AdminActor,
  id: unknown,
  input: unknown,
): Promise<ServiceResult<{ id: string }>> {
  const refused = await refuseUnlessAdmin(actor, "areas");
  if (refused) return refused;
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
  const set: Partial<Pick<Area, "name" | "slug">> = {};
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
  // Keep or clear only; a different id must go through setAreaImage().
  if (values.bwImage !== null && values.bwImage !== bwImage) {
    return fieldError("bwImage", BW_IMAGE_USE_UPLOADER);
  }
  if (unsetBwImage) fields.push("bwImage");

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
      actorId: actor.id,
      action: "area.update",
      target: { type: "area", id: parsedId.data },
      meta: { fields },
    },
    { id: parsedId.data },
    EDIT_TAGS,
  );
}

/** Set (a verified new upload) or clear (null / "") an area's b/w image. */
export const setAreaImageSchema = z.strictObject({
  areaId: objectIdSchema,
  publicId: optionalPublicIdSchema.nullable().transform((id) => id ?? null),
});

/**
 * Sets or clears an area's black-and-white image. A new id must be an upload
 * in this area's own folder (`yg/areas/<areaId>/<uuid>`) that passes
 * verification (exists, size, format); a rejected upload is deleted from
 * Cloudinary and nothing is saved. The replaced image is not deleted (see
 * saveProductImages: the T17 orphan report lists it).
 */
export async function setAreaImage(
  actor: AdminActor,
  input: unknown,
): Promise<ServiceResult<{ id: string; bwImage: string | null }>> {
  const refused = await refuseUnlessAdmin(actor, "areas");
  if (refused) return refused;
  const parsed = setAreaImageSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { areaId, publicId } = parsed.data;
  const selfId = new ObjectId(areaId);

  await connectDb();
  const current = await AreaModel.findById(selfId, {
    bwImage: 1,
  }).lean<Pick<Area, "bwImage"> | null>();
  if (!current) return formError(NOT_FOUND);
  if ((current.bwImage ?? null) === publicId) {
    return unchanged({ id: areaId, bwImage: publicId });
  }

  if (publicId !== null) {
    const check = await verifyUploadedImage({
      target: "area",
      id: areaId,
      publicId,
    });
    if (!check.ok) return fieldError("publicId", check.message);
  }

  const result = await AreaModel.updateOne(
    { _id: selfId },
    publicId === null
      ? { $unset: { bwImage: 1 } }
      : { $set: { bwImage: publicId } },
    { runValidators: true },
  );
  if (result.matchedCount === 0) return formError(NOT_FOUND);

  return auditAndFinish(
    {
      actorId: actor.id,
      action: "area.update",
      target: { type: "area", id: areaId },
      meta: { fields: ["bwImage"], cleared: publicId === null },
    },
    { id: areaId, bwImage: publicId },
    LIST_TAGS,
  );
}

/**
 * Moves an area one place up or down by swapping positions. Areas are
 * renumbered 0, 1, 2 ... in the new order, writing only rows whose `order`
 * changes (this also repairs gaps or ties). Moving the first one up or the
 * last one down changes nothing.
 */
export async function moveArea(
  actor: AdminActor,
  input: unknown,
): Promise<ServiceResult<{ moved: boolean }>> {
  const refused = await refuseUnlessAdmin(actor, "areas");
  if (refused) return refused;
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
      actorId: actor.id,
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
  actor: AdminActor,
  id: unknown,
): Promise<ServiceResult<{ id: string }>> {
  const refused = await refuseUnlessAdmin(actor, "areas");
  if (refused) return refused;
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
      actorId: actor.id,
      action: "area.delete",
      target: { type: "area", id: parsedId.data },
    },
    { id: parsedId.data },
    LIST_TAGS,
  );
}
