// Admin services for products: list (search, filter, pages), read one for the
// edit form, create a draft, save the form, publish/unpublish and delete.
// Each write re-parses with Zod, checks references, audits and returns tags.

import "server-only";

import { z } from "zod";
import type { Types } from "mongoose";

import { connectDb, mongoose } from "@/lib/db";
import { CATALOG_TAGS, productTags, type CatalogTag } from "@/lib/revalidate";
import { MAX_PRODUCT_NAME_LENGTH } from "@/lib/constants";
import { objectIdSchema } from "@/lib/schemas/common";
import {
  productIdSchema,
  productInputSchema,
  publishCheck,
  type ProductFormValues,
  type ProductInput,
  type PublishProblem,
} from "@/lib/schemas/product";
import { uniqueSlug, UniqueSlugError } from "@/lib/slug";
import {
  AreaModel,
  CategoryModel,
  DatasheetModel,
  ProductModel,
} from "@/models";
import type { Product, ProductImage } from "@/models/product";
import {
  PRODUCT_STATUSES,
  type ProductStatus,
} from "@/models/product-constants";
import { SPEC_KEYS, type SpecValues } from "@/models/spec-columns";

import {
  assertActorId,
  auditAndFinish,
  formError,
  invalidInput,
  isDuplicateKeyError,
  unchanged,
  type ServiceErrors,
  type ServiceResult,
} from "./write-result";

const { ObjectId } = mongoose.Types;

/** Rows per admin list page. */
export const PRODUCTS_PAGE_SIZE = 25;
/** Longest search text used; longer input is cut, not refused. */
export const MAX_PRODUCT_SEARCH_LENGTH = 80;
/** The slug of the main category that may carry a `trackSize` (see below). */
export const MAGNETIC_TRACK_SLUG = "magnetic-track";

const NOT_FOUND = "This product no longer exists. Reload the page.";
/** Shown when the product is gone (deleted in another tab). */
export const PRODUCT_NOT_FOUND = NOT_FOUND;
/** A variant points at an image the product doesn't have (gate B L-C). */
export const VARIANT_IMAGE_NOT_OWN =
  "Choose one of this product's own images, or leave it empty.";
const MODEL_NO_TAKEN = "This model no. already belongs to another product";
const SLUG_TAKEN = "Another product already uses this slug.";
/** A save or status change from a page loaded before the latest write. */
export const PRODUCT_CHANGED =
  "This product changed since you opened it. Reload to see the latest version.";

/*
 * Optimistic concurrency (T10a). The edit page sends the `updatedAt` it was
 * loaded with; a write only lands while the stored value still matches, so a
 * stale tab can't overwrite newer data. Given but malformed = refused.
 */
const expectedUpdatedAtSchema = z.iso
  .datetime({ offset: true })
  .transform((iso) => new Date(iso));

export interface ProductWriteOptions {
  /** The ISO `updatedAt` the form was loaded with. Absent = no check. */
  expectedUpdatedAt?: unknown;
}

/**
 * The parsed expected `updatedAt`, null when no check was asked for, or
 * "bad" when the key is present but not an ISO date-time. Shared with the
 * images save (product-images.ts).
 */
export function expectedVersion(
  options: ProductWriteOptions,
): Date | null | "bad" {
  if (!("expectedUpdatedAt" in options)) return null;
  const parsed = expectedUpdatedAtSchema.safeParse(options.expectedUpdatedAt);
  return parsed.success ? parsed.data : "bad";
}

/**
 * Tags. A draft is invisible to the public, so only the product list tags are
 * expired. Anything that is or was published also expires category and area
 * listings (they show product counts and cards).
 */
export function tagsFor(id: string, public_: boolean): CatalogTag[] {
  return public_
    ? [...productTags(id), CATALOG_TAGS.categories, CATALOG_TAGS.areas]
    : productTags(id);
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One row of the admin product list (list fields only, no spec values). */
export interface ProductListItem {
  id: string;
  name: string;
  slug: string;
  family: string | null;
  modelCode: string | null;
  status: ProductStatus;
  mainCategoryId: string;
  mainCategoryName: string | null;
  variantCount: number;
  /** The first model no., for recognising the row. */
  firstModelNo: string | null;
  imageCount: number;
  /** Cloudinary public id of the first image, for a thumbnail. */
  thumbPublicId: string | null;
  updatedAt: string;
}

export interface ProductListPage {
  items: ProductListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** What the edit form is filled with, plus the read-only image list. */
export interface ProductForEdit {
  id: string;
  values: ProductFormValues;
  images: ProductImage[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Reads (admin only, never cached)
// ---------------------------------------------------------------------------

/*
 * List query input. Every field falls back to its default when it is bad
 * (the values come from the URL), so a crafted query string, an operator
 * object like {"$ne":""} or a huge page number never reaches MongoDB.
 */
const listQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .transform((q) => q.slice(0, MAX_PRODUCT_SEARCH_LENGTH).trim())
    .catch(""),
  status: z.enum(PRODUCT_STATUSES).optional().catch(undefined),
  category: objectIdSchema.optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(100_000).catch(1),
});

/* Escapes regex metacharacters so the search text is matched literally. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ListRow = Pick<
  Product,
  | "_id"
  | "name"
  | "slug"
  | "family"
  | "modelCode"
  | "status"
  | "mainCategory"
  | "updatedAt"
> & {
  variants?: { modelNo: string }[];
  images?: { publicId: string; order: number }[];
};

/* Only what the list shows. Never `specs` / `variants.specs`. */
const LIST_PROJECTION = {
  name: 1,
  slug: 1,
  family: 1,
  modelCode: 1,
  status: 1,
  mainCategory: 1,
  updatedAt: 1,
  "variants.modelNo": 1,
  "images.publicId": 1,
  "images.order": 1,
} as const;

/**
 * One page of products, newest edit first. `q` matches name, slug, family,
 * model code and every variant's model no. (literal, case-insensitive);
 * `category` matches products whose main or extra category is that category or
 * one of its children. Bad input falls back to the defaults.
 */
export async function listProducts(
  input: unknown = {},
): Promise<ProductListPage> {
  const raw = typeof input === "object" && input !== null ? input : {};
  const query = listQuerySchema.parse(raw);
  await connectDb();

  const filter: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];
  if (query.status) filter.status = query.status;
  if (query.q !== "") {
    const pattern = new RegExp(escapeRegex(query.q), "i");
    and.push({
      $or: [
        { name: pattern },
        { slug: pattern },
        { family: pattern },
        { modelCode: pattern },
        { "variants.modelNo": pattern },
      ],
    });
  }
  if (query.category) {
    const parent = new ObjectId(query.category);
    const children = await CategoryModel.find({ parent }, { _id: 1 }).lean();
    const ids = [parent, ...children.map((child) => child._id)];
    and.push({
      $or: [{ mainCategory: { $in: ids } }, { extraCategories: { $in: ids } }],
    });
  }
  if (and.length > 0) filter.$and = and;

  const [rows, total] = await Promise.all([
    ProductModel.find(filter, LIST_PROJECTION)
      .sort({ updatedAt: -1, _id: -1 })
      .skip((query.page - 1) * PRODUCTS_PAGE_SIZE)
      .limit(PRODUCTS_PAGE_SIZE)
      .lean<ListRow[]>(),
    ProductModel.countDocuments(filter),
  ]);

  const categories = await CategoryModel.find(
    {
      _id: { $in: [...new Set(rows.map((r) => r.mainCategory.toHexString()))] },
    },
    { name: 1 },
  ).lean();
  const names = new Map(categories.map((c) => [c._id.toHexString(), c.name]));

  return {
    items: rows.map((row) => {
      const images = [...(row.images ?? [])].sort((a, b) => a.order - b.order);
      return {
        id: row._id.toHexString(),
        name: row.name,
        slug: row.slug,
        family: row.family ?? null,
        modelCode: row.modelCode ?? null,
        status: row.status,
        mainCategoryId: row.mainCategory.toHexString(),
        mainCategoryName: names.get(row.mainCategory.toHexString()) ?? null,
        variantCount: row.variants?.length ?? 0,
        firstModelNo: row.variants?.[0]?.modelNo ?? null,
        imageCount: images.length,
        thumbPublicId: images[0]?.publicId ?? null,
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    total,
    page: query.page,
    pageSize: PRODUCTS_PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(total / PRODUCTS_PAGE_SIZE)),
  };
}

/* Stored document -> the parsed-input shape, so stored and new compare 1:1. */
function toInput(doc: Product): ProductInput {
  const specs = (source: SpecValues | undefined): SpecValues => {
    const kept: SpecValues = {};
    for (const key of SPEC_KEYS) {
      const values = source?.[key];
      if (values && values.length > 0) kept[key] = [...values];
    }
    return kept;
  };
  return {
    name: doc.name,
    slug: doc.slug,
    modelCode: doc.modelCode ?? null,
    family: doc.family ?? null,
    productNo: doc.productNo ?? null,
    type: doc.type ?? null,
    description: doc.description ?? null,
    mainCategory: doc.mainCategory.toHexString(),
    extraCategories: doc.extraCategories.map((id) => id.toHexString()),
    areas: doc.areas.map((id) => id.toHexString()),
    trackSize: doc.trackSize ?? null,
    specs: specs(doc.specs),
    filters: Object.fromEntries(
      Object.entries(doc.filters ?? {}).filter(
        ([, numbers]) => Array.isArray(numbers) && numbers.length > 0,
      ),
    ),
    variants: doc.variants.map((variant) => ({
      modelNo: variant.modelNo,
      label: variant.label ?? null,
      specs: specs(variant.specs),
      imagePublicId: variant.imagePublicId ?? null,
    })),
    extraSpecs: doc.extraSpecs.map((extra) => ({
      group: extra.group ?? null,
      label: extra.label,
      value: extra.value,
    })),
    publicFiles: doc.publicFiles.map((file) => ({
      label: file.label,
      url: file.url,
    })),
    datasheetId: doc.datasheetId ? doc.datasheetId.toHexString() : null,
    status: doc.status,
  };
}

/** One product for the edit form, or null if the id is bad or unknown. */
export async function getProductForEdit(
  id: unknown,
): Promise<ProductForEdit | null> {
  const parsedId = productIdSchema.safeParse(id);
  if (!parsedId.success) return null;

  await connectDb();
  const doc = await ProductModel.findById(parsedId.data).lean<Product | null>();
  if (!doc) return null;

  const stored = toInput(doc);
  const text = (value: string | null) => value ?? "";
  return {
    id: doc._id.toHexString(),
    values: {
      ...stored,
      modelCode: text(stored.modelCode),
      family: text(stored.family),
      type: text(stored.type),
      description: text(stored.description),
      variants: stored.variants.map((variant) => ({
        ...variant,
        label: text(variant.label),
        imagePublicId: text(variant.imagePublicId),
      })),
      extraSpecs: stored.extraSpecs.map((extra) => ({
        ...extra,
        group: text(extra.group),
      })),
    },
    images: doc.images.map((image) => ({
      publicId: image.publicId,
      ...(image.alt === undefined ? {} : { alt: image.alt }),
      order: image.order,
      kind: image.kind,
    })),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/* A failure with several field errors at once; nothing written. */
function fieldErrors(fields: Record<string, string[]>): ServiceResult<never> {
  const errors: ServiceErrors = { formErrors: [], fieldErrors: fields };
  return { ok: false, errors, tags: [] };
}

/* publishCheck problems as form errors, plus a note on the status field. */
function publishRefusal(problems: PublishProblem[]): ServiceResult<never> {
  const fields: Record<string, string[]> = {
    status: ["This product cannot be published yet. Fix the problems below."],
  };
  for (const problem of problems) {
    (fields[problem.field] ??= []).push(problem.message);
  }
  return fieldErrors(fields);
}

/* True when another product (not `self`) uses `slug`. Uses the unique index. */
async function slugTaken(
  slug: string,
  self?: Types.ObjectId,
): Promise<boolean> {
  const filter = self ? { slug, _id: { $ne: self } } : { slug };
  return (await ProductModel.exists(filter)) !== null;
}

/* Stable JSON (object keys sorted) so stored and new values compare equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

/*
 * Turns a duplicate-key error from the unique indexes into a field error:
 * `slug`, or `variants.N.modelNo` for the row(s) holding the clashing value.
 * Reads the server's keyPattern/keyValue; falls back to `variants`.
 */
function duplicateKeyResult(
  error: unknown,
  variants: ProductInput["variants"],
): ServiceResult<never> {
  const info =
    typeof error === "object" && error !== null
      ? (error as {
          keyPattern?: Record<string, unknown>;
          keyValue?: Record<string, unknown>;
        })
      : {};
  if (info.keyPattern && "slug" in info.keyPattern) {
    return fieldErrors({ slug: [SLUG_TAKEN] });
  }
  const value = info.keyValue?.["variants.modelNo"];
  const hits = variants.flatMap((variant, index) =>
    variant.modelNo === value ? [index] : [],
  );
  if (hits.length > 0) {
    return fieldErrors(
      Object.fromEntries(
        hits.map((index) => [`variants.${index}.modelNo`, [MODEL_NO_TAKEN]]),
      ),
    );
  }
  return fieldErrors({ variants: [MODEL_NO_TAKEN] });
}

interface CategoryRef {
  _id: Types.ObjectId;
  slug: string;
  name: string;
  parent: Types.ObjectId | null;
}

/*
 * The trackSize rule: a product may carry a track size only when its main
 * category or one of its extra categories is Magnetic Track, or a child of it.
 * "Magnetic Track" is recognised by being a MAIN category (parent null) with
 * slug `magnetic-track` or the name "Magnetic Track" (case-insensitive). The
 * tree is at most 2 deep, so one parent lookup is enough.
 */
async function isMagneticTrack(categories: CategoryRef[]): Promise<boolean> {
  const isRoot = (c: CategoryRef) =>
    c.parent === null &&
    (c.slug === MAGNETIC_TRACK_SLUG ||
      c.name.trim().toLowerCase() === "magnetic track");
  if (categories.some(isRoot)) return true;
  const parentIds = categories.flatMap((c) => (c.parent ? [c.parent] : []));
  if (parentIds.length === 0) return false;
  const parents = await CategoryModel.find(
    { _id: { $in: parentIds } },
    { slug: 1, name: 1, parent: 1 },
  ).lean<CategoryRef[]>();
  return parents.some(isRoot);
}

/*
 * Checks every referenced id exists and the track-size rule. Returns the
 * field errors found (empty = fine).
 */
async function checkReferences(
  values: ProductInput,
): Promise<Record<string, string[]>> {
  const errors: Record<string, string[]> = {};
  const add = (field: string, message: string) => {
    (errors[field] ??= []).push(message);
  };

  if (values.extraCategories.includes(values.mainCategory)) {
    add("extraCategories", "The main category is already the main one");
  }
  const categoryIds = [values.mainCategory, ...values.extraCategories];
  const categories = await CategoryModel.find(
    { _id: { $in: categoryIds.map((id) => new ObjectId(id)) } },
    { slug: 1, name: 1, parent: 1 },
  ).lean<CategoryRef[]>();
  const found = new Set(categories.map((c) => c._id.toHexString()));
  if (!found.has(values.mainCategory)) {
    add("mainCategory", "This category no longer exists");
  }
  if (values.extraCategories.some((id) => !found.has(id))) {
    add("extraCategories", "A chosen category no longer exists");
  }

  if (values.areas.length > 0) {
    const count = await AreaModel.countDocuments({
      _id: { $in: values.areas.map((id) => new ObjectId(id)) },
    });
    if (count !== values.areas.length) {
      add("areas", "A chosen area no longer exists");
    }
  }
  if (values.datasheetId !== null) {
    const exists = await DatasheetModel.exists({
      _id: new ObjectId(values.datasheetId),
    });
    if (!exists) add("datasheetId", "This datasheet no longer exists");
  }
  if (values.trackSize !== null && !(await isMagneticTrack(categories))) {
    add("trackSize", "Track size only applies to Magnetic Track products");
  }
  return errors;
}

/* Variant rows whose model no. another product already uses. */
async function takenModelNos(
  variants: ProductInput["variants"],
  self: Types.ObjectId,
): Promise<Record<string, string[]>> {
  if (variants.length === 0) return {};
  const modelNos = variants.map((variant) => variant.modelNo);
  // Uses the { variants.modelNo } index.
  const others = await ProductModel.find(
    { _id: { $ne: self }, "variants.modelNo": { $in: modelNos } },
    { "variants.modelNo": 1 },
  ).lean<{ variants: { modelNo: string }[] }[]>();
  const taken = new Set(
    others.flatMap((o) => o.variants.map((v) => v.modelNo)),
  );
  const errors: Record<string, string[]> = {};
  variants.forEach((variant, index) => {
    if (taken.has(variant.modelNo)) {
      errors[`variants.${index}.modelNo`] = [MODEL_NO_TAKEN];
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const createDraftSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name")
    .max(
      MAX_PRODUCT_NAME_LENGTH,
      `At most ${MAX_PRODUCT_NAME_LENGTH} characters`,
    ),
  mainCategory: objectIdSchema,
});

/**
 * Creates a draft with a slug made from the name ("-2", "-3" ... if taken).
 * The main category must exist. The rest is filled in on the edit form.
 */
export async function createDraft(
  actorId: string,
  input: unknown,
): Promise<ServiceResult<{ id: string }>> {
  assertActorId(actorId);
  await connectDb();

  const parsed = createDraftSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { name, mainCategory } = parsed.data;

  const category = await CategoryModel.exists({
    _id: new ObjectId(mainCategory),
  });
  if (!category)
    return fieldErrors({ mainCategory: ["This category no longer exists"] });

  let slug: string;
  try {
    slug = await uniqueSlug(name, (candidate) => slugTaken(candidate));
  } catch (error) {
    if (error instanceof UniqueSlugError) {
      return fieldErrors({
        name: ["The name needs letters or digits to make a URL from"],
      });
    }
    throw error;
  }

  let id: Types.ObjectId;
  try {
    const created = await ProductModel.create({
      name,
      slug,
      mainCategory: new ObjectId(mainCategory),
      status: "draft",
    });
    id = created._id;
  } catch (error) {
    // Another write took the slug between the check and the insert.
    if (isDuplicateKeyError(error)) return fieldErrors({ slug: [SLUG_TAKEN] });
    throw error;
  }

  return auditAndFinish(
    {
      actorId,
      action: "product.create",
      target: { type: "product", id: id.toHexString() },
    },
    { id: id.toHexString() },
    tagsFor(id.toHexString(), false),
  );
}

/*
 * The stored shape of each form field that may change, converting hex ids to
 * ObjectIds and dropping empty optional values (the model leaves them out).
 */
function storedVariants(variants: ProductInput["variants"]) {
  return variants.map((variant) => ({
    modelNo: variant.modelNo,
    ...(variant.label === null ? {} : { label: variant.label }),
    ...(Object.keys(variant.specs).length === 0
      ? {}
      : { specs: variant.specs }),
    ...(variant.imagePublicId === null
      ? {}
      : { imagePublicId: variant.imagePublicId }),
  }));
}

/* Form fields written as-is when they change; optional ones are unset when null. */
const OPTIONAL_FIELDS = [
  "modelCode",
  "family",
  "productNo",
  "type",
  "description",
  "trackSize",
] as const;
// `status` is not here: only publishProduct/unpublishProduct change it.
const REQUIRED_FIELDS = ["name", "extraSpecs", "publicFiles"] as const;
const OBJECT_FIELDS = ["specs", "filters"] as const;

/**
 * Saves the edit form. An empty slug keeps the current one. Images are never
 * touched, and neither is `status` (T10a): it is accepted by the schema but
 * ignored, so a save from a stale tab can't re-publish or unpublish; use
 * publishProduct/unpublishProduct. With `expectedUpdatedAt`, a product
 * written since the form loaded is refused with PRODUCT_CHANGED. When nothing
 * changed, nothing is written, audited or revalidated.
 */
export async function updateProduct(
  actorId: string,
  id: unknown,
  input: unknown,
  options: ProductWriteOptions = {},
): Promise<ServiceResult<{ id: string }>> {
  assertActorId(actorId);
  await connectDb();

  const parsedId = productIdSchema.safeParse(id);
  if (!parsedId.success) return formError(NOT_FOUND);
  const expected = expectedVersion(options);
  if (expected === "bad") return formError(PRODUCT_CHANGED);
  const parsed = productInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const values = parsed.data;
  const selfId = new ObjectId(parsedId.data);

  const doc = await ProductModel.findById(selfId).lean<Product | null>();
  if (!doc) return formError(NOT_FOUND);
  if (expected && doc.updatedAt.getTime() !== expected.getTime()) {
    return formError(PRODUCT_CHANGED);
  }
  const stored = toInput(doc);

  const errors = {
    ...(await checkReferences(values)),
    ...(await takenModelNos(values.variants, selfId)),
  };
  /*
   * A variant image must be one of the product's own saved images (gate B
   * L-C): only those passed upload verification. The write below also
   * requires them atomically, in case an image is removed meanwhile.
   */
  const ownImages = new Set(doc.images.map((image) => image.publicId));
  const variantImages = new Set<string>();
  values.variants.forEach((variant, index) => {
    if (variant.imagePublicId === null) return;
    if (ownImages.has(variant.imagePublicId)) {
      variantImages.add(variant.imagePublicId);
    } else {
      errors[`variants.${index}.imagePublicId`] = [VARIANT_IMAGE_NOT_OWN];
    }
  });
  const slug = values.slug === "" ? stored.slug : values.slug;
  if (slug !== stored.slug && (await slugTaken(slug, selfId))) {
    errors.slug = [SLUG_TAKEN];
  }
  if (Object.keys(errors).length > 0) return fieldErrors(errors);

  /*
   * A published product must stay publishable: a save that would break
   * publishCheck (e.g. removing the last variant) is refused.
   */
  if (doc.status === "published") {
    const problems = publishCheck({
      mainCategory: values.mainCategory,
      variants: values.variants,
      images: doc.images,
    });
    if (problems.length > 0) return publishRefusal(problems);
  }

  // Only the changed fields: their names go into the audit entry.
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  const fields: string[] = [];
  const changed = (a: unknown, b: unknown) => stable(a) !== stable(b);

  if (slug !== stored.slug) {
    set.slug = slug;
    fields.push("slug");
  }
  for (const key of REQUIRED_FIELDS) {
    if (changed(values[key], stored[key])) {
      set[key] = values[key];
      fields.push(key);
    }
  }
  for (const key of OPTIONAL_FIELDS) {
    if (!changed(values[key], stored[key])) continue;
    if (values[key] === null) unset[key] = 1;
    else set[key] = values[key];
    fields.push(key);
  }
  for (const key of OBJECT_FIELDS) {
    if (!changed(values[key], stored[key])) continue;
    if (Object.keys(values[key]).length === 0) unset[key] = 1;
    else set[key] = values[key];
    fields.push(key);
  }
  if (values.mainCategory !== stored.mainCategory) {
    set.mainCategory = new ObjectId(values.mainCategory);
    fields.push("mainCategory");
  }
  if (changed(values.extraCategories, stored.extraCategories)) {
    set.extraCategories = values.extraCategories.map((c) => new ObjectId(c));
    fields.push("extraCategories");
  }
  if (changed(values.areas, stored.areas)) {
    set.areas = values.areas.map((a) => new ObjectId(a));
    fields.push("areas");
  }
  if (values.datasheetId !== stored.datasheetId) {
    set.datasheetId =
      values.datasheetId === null ? null : new ObjectId(values.datasheetId);
    fields.push("datasheetId");
  }
  if (changed(values.variants, stored.variants)) {
    set.variants = storedVariants(values.variants);
    fields.push("variants");
  }

  if (fields.length === 0) return unchanged({ id: parsedId.data });

  try {
    const result = await ProductModel.updateOne(
      {
        _id: selfId,
        // With a version, only while nobody wrote since the read above.
        ...(expected ? { updatedAt: expected } : {}),
        // Only while every image a variant points at is still saved.
        ...(variantImages.size > 0
          ? { "images.publicId": { $all: [...variantImages] } }
          : {}),
      },
      {
        ...(Object.keys(set).length > 0 ? { $set: set } : {}),
        ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
      },
      { runValidators: true },
    );
    if (result.matchedCount === 0) {
      // Deleted, or written by someone else meanwhile (a newer version, or
      // a variant's image removed by the images editor).
      const exists = await ProductModel.exists({ _id: selfId });
      return formError(exists ? PRODUCT_CHANGED : NOT_FOUND);
    }
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return duplicateKeyResult(error, values.variants);
    }
    throw error;
  }

  return auditAndFinish(
    {
      actorId,
      action: "product.update",
      target: { type: "product", id: parsedId.data },
      meta: { fields, variantCount: values.variants.length },
    },
    { id: parsedId.data },
    tagsFor(parsedId.data, doc.status === "published"),
  );
}

/* Shared body of publishProduct / unpublishProduct. */
async function setStatus(
  actorId: string,
  id: unknown,
  status: ProductStatus,
  options: ProductWriteOptions,
): Promise<ServiceResult<{ id: string }>> {
  assertActorId(actorId);
  await connectDb();

  const parsedId = productIdSchema.safeParse(id);
  if (!parsedId.success) return formError(NOT_FOUND);
  const expected = expectedVersion(options);
  if (expected === "bad") return formError(PRODUCT_CHANGED);
  const selfId = new ObjectId(parsedId.data);

  const doc = await ProductModel.findById(selfId, {
    status: 1,
    mainCategory: 1,
    "variants.modelNo": 1,
    images: 1,
    updatedAt: 1,
  }).lean<Pick<
    Product,
    "status" | "mainCategory" | "variants" | "images" | "updatedAt"
  > | null>();
  if (!doc) return formError(NOT_FOUND);
  if (expected && doc.updatedAt.getTime() !== expected.getTime()) {
    return formError(PRODUCT_CHANGED);
  }
  if (doc.status === status) return unchanged({ id: parsedId.data });

  if (status === "published") {
    const problems = publishCheck({
      mainCategory: doc.mainCategory,
      variants: doc.variants,
      images: doc.images,
    });
    if (problems.length > 0) return publishRefusal(problems);
  }

  const result = await ProductModel.updateOne(
    expected ? { _id: selfId, updatedAt: expected } : { _id: selfId },
    { $set: { status } },
  );
  if (result.matchedCount === 0) {
    const exists = await ProductModel.exists({ _id: selfId });
    return formError(exists ? PRODUCT_CHANGED : NOT_FOUND);
  }

  return auditAndFinish(
    {
      actorId,
      action: status === "published" ? "product.publish" : "product.unpublish",
      target: { type: "product", id: parsedId.data },
    },
    { id: parsedId.data },
    tagsFor(parsedId.data, true),
  );
}

/** Publishes a draft; refused with field errors while publishCheck() fails. */
export function publishProduct(
  actorId: string,
  id: unknown,
  options: ProductWriteOptions = {},
): Promise<ServiceResult<{ id: string }>> {
  return setStatus(actorId, id, "published", options);
}

/** Takes a product back to draft. */
export function unpublishProduct(
  actorId: string,
  id: unknown,
  options: ProductWriteOptions = {},
): Promise<ServiceResult<{ id: string }>> {
  return setStatus(actorId, id, "draft", options);
}

/**
 * Deletes the product document only. Its Cloudinary images are left for the
 * T17 orphan report (images are public, and a delete can't be undone); the
 * audit entry holds ids and counts, never names.
 */
export async function deleteProduct(
  actorId: string,
  id: unknown,
): Promise<ServiceResult<{ id: string }>> {
  assertActorId(actorId);
  await connectDb();

  const parsedId = productIdSchema.safeParse(id);
  if (!parsedId.success) return formError(NOT_FOUND);
  const selfId = new ObjectId(parsedId.data);

  const doc = await ProductModel.findById(selfId, {
    status: 1,
    "variants.modelNo": 1,
    "images.publicId": 1,
  }).lean<Pick<Product, "status" | "variants" | "images"> | null>();
  if (!doc) return formError(NOT_FOUND);

  const result = await ProductModel.deleteOne({ _id: selfId });
  if (result.deletedCount === 0) return formError(NOT_FOUND);

  return auditAndFinish(
    {
      actorId,
      action: "product.delete",
      target: { type: "product", id: parsedId.data },
      meta: {
        status: doc.status,
        variantCount: doc.variants.length,
        imageCount: doc.images.length,
      },
    },
    { id: parsedId.data },
    tagsFor(parsedId.data, doc.status === "published"),
  );
}
