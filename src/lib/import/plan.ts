// Plan step of the bulk import (Phase 3 T7, ADR 0057): matches each grouped
// sheet product against the saved products by model no. (case-insensitive),
// merges by field ownership, classifies create / update / unchanged /
// blocked, builds the preview diff and the plan hash. Reads the database
// only; never writes, never uploads.

import "server-only";

import { createHash } from "node:crypto";

import type { Types } from "mongoose";

import { withoutRestrictedFilters } from "@/lib/admin/products";
import { MAX_PRODUCT_IMAGES } from "@/lib/constants";
import { connectDb } from "@/lib/db";
import { productInputSchema } from "@/lib/schemas/product";
import { uniqueSlug, UniqueSlugError } from "@/lib/slug";
import { AreaModel, CategoryModel, ProductModel } from "@/models";
import type { ProductFilters, ProductImage } from "@/models/product";
import {
  isMagneticTrackCategory,
  MODEL_NO_COLLATION,
  modelNoKey,
  type ProductStatus,
  type TrackSize,
} from "@/models/product-constants";
import {
  SPEC_COLUMNS,
  SPEC_KEYS,
  type FilterKey,
  type SpecKey,
  type SpecValues,
} from "@/models/spec-columns";

import { cleanRow } from "./clean";
import {
  groupRows,
  trackSizeOf,
  type AreaLookup,
  type CategoryLookup,
} from "./group";
import { attachImages, readEmbeddedImages, type EmbeddedImage } from "./images";
import { filtersFromSpecs } from "./numbers";
import { checkImportFile, safetyWarning } from "./safety";
import {
  importWarning,
  MAX_PLAN_CHANGES,
  type ImportImageRef,
  type ImportPlan,
  type ImportProduct,
  type ImportWarning,
  type PlanChange,
  type PlanEntry,
  type PlanExisting,
  type PlanTarget,
  type PlanVariant,
} from "./types";
import { readWorkbook } from "./workbook";

/** The category tree and areas, loaded once per plan. */
export interface PlanLookups {
  categories: CategoryLookup[];
  areas: AreaLookup[];
}

export interface PlanOptions extends PlanLookups {
  /** The admin's default main category (already checked to exist). */
  defaultCategoryId: string;
}

export type PlanFromBytes =
  | { kind: "refused"; warnings: ImportWarning[] }
  | {
      kind: "plan";
      plan: ImportPlan;
      /**
       * The sheet side of `plan.planHash` (see `sheetHash`): the commit
       * checks the preview's entry hashes against it (ADR 0061).
       */
      sheetHash: string;
      /**
       * The pictures' bytes by sha256, for the commit's upload (T8). Never
       * hashed, never sent to the browser.
       */
      files: ReadonlyMap<string, EmbeddedImage>;
    };

/* Model nos. per `$in` query; keeps each query document small. */
const MATCH_CHUNK = 1000;

/** The fields of a saved product the plan reads (sheet-owned + identity). */
interface StoredProduct {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  status: ProductStatus;
  updatedAt: Date;
  family?: string;
  type?: string;
  productNo?: number;
  modelCode?: string;
  specs?: SpecValues;
  filters?: ProductFilters;
  variants: {
    modelNo: string;
    label?: string;
    specs?: SpecValues;
    imagePublicId?: string;
  }[];
  mainCategory: Types.ObjectId;
  extraCategories: Types.ObjectId[];
  areas: Types.ObjectId[];
  trackSize?: TrackSize;
  images: Pick<ProductImage, "sourceSha256">[];
}

const STORED_PROJECTION = {
  name: 1,
  slug: 1,
  status: 1,
  updatedAt: 1,
  family: 1,
  type: 1,
  productNo: 1,
  modelCode: 1,
  specs: 1,
  filters: 1,
  variants: 1,
  mainCategory: 1,
  extraCategories: 1,
  areas: 1,
  trackSize: 1,
  "images.sourceSha256": 1,
} as const;

/** Loads the category tree and areas as the grouping step needs them. */
export async function loadPlanLookups(): Promise<PlanLookups> {
  await connectDb();
  const [categories, areas] = await Promise.all([
    CategoryModel.find({}, { name: 1, slug: 1, parent: 1 }).lean<
      {
        _id: Types.ObjectId;
        name: string;
        slug: string;
        parent: Types.ObjectId | null;
      }[]
    >(),
    AreaModel.find({}, { name: 1, slug: 1 }).lean<
      { _id: Types.ObjectId; name: string; slug: string }[]
    >(),
  ]);
  return {
    categories: categories.map((c) => ({
      id: c._id.toHexString(),
      name: c.name,
      slug: c.slug,
      parentId: c.parent?.toHexString() ?? null,
    })),
    areas: areas.map((a) => ({
      id: a._id.toHexString(),
      name: a.name,
      slug: a.slug,
    })),
  };
}

/**
 * The whole read side of an import, from the staged bytes to the plan:
 * safety check → read → clean → group → pictures → match + merge. Only the
 * CheckedImportFile reaches the readers. Writes nothing.
 */
export async function planFromBytes(
  bytes: Uint8Array,
  options: PlanOptions,
): Promise<PlanFromBytes> {
  const check = await checkImportFile(bytes);
  if (!check.ok) {
    return { kind: "refused", warnings: [safetyWarning(check.reason)] };
  }
  const read = await readWorkbook(check.file);
  if (!read.ok) return { kind: "refused", warnings: read.warnings };

  const grouped = groupRows(read.rows.map(cleanRow), options);
  const embedded = await readEmbeddedImages(
    check.file,
    read.sheets.map((sheet) => sheet.name),
  );
  const attached = attachImages(grouped.products, embedded);
  const built = await buildPlan(
    attached.products,
    [...read.warnings, ...grouped.warnings, ...attached.warnings],
    options,
  );
  return { kind: "plan", ...built, files: embedded.files };
}

/**
 * Matches grouped products against the database and builds the plan.
 * `fileWarnings` are the findings that belong to no product.
 */
export async function planProducts(
  products: readonly ImportProduct[],
  fileWarnings: readonly ImportWarning[],
  options: PlanOptions,
): Promise<ImportPlan> {
  return (await buildPlan(products, fileWarnings, options)).plan;
}

/* An entry before its hash is added. */
type UnhashedEntry = Omit<PlanEntry, "hash">;

async function buildPlan(
  products: readonly ImportProduct[],
  fileWarnings: readonly ImportWarning[],
  options: PlanOptions,
): Promise<{ plan: ImportPlan; sheetHash: string }> {
  await connectDb();
  const keepFilters = await restrictedFilterGate();
  const categoryById = new Map(options.categories.map((c) => [c.id, c]));
  const stored = await loadMatches(products);

  // Which saved products each sheet product matches, and who claims each.
  const matches = products.map((product) =>
    product.blocked ? [] : matchedIds(product, stored.byKey),
  );
  const claims = new Map<string, number[]>();
  matches.forEach((ids, index) => {
    if (ids.length !== 1) return;
    const id = ids[0] as string;
    claims.set(id, [...(claims.get(id) ?? []), index]);
  });

  const reservedSlugs = new Set<string>();
  const entries: UnhashedEntry[] = [];
  for (const [index, product] of products.entries()) {
    const ids = matches[index] as string[];
    const conflict = conflictWarnings(
      product,
      ids,
      claims,
      products,
      stored.byId,
    );
    if (product.blocked || conflict.length > 0) {
      entries.push(blockedEntry(product, conflict));
      continue;
    }
    const match = ids.length === 1 ? stored.byId.get(ids[0] as string) : null;
    entries.push(
      match
        ? updateEntry(product, match, keepFilters, categoryById, options)
        : await createEntry(
            product,
            keepFilters,
            categoryById,
            reservedSlugs,
            stored.takenSlugs,
          ),
    );
  }

  const hashed: PlanEntry[] = entries.map((entry) => ({
    ...entry,
    hash: entryHash(entry),
  }));
  const sheet = sheetHash(options.defaultCategoryId, products);
  return {
    plan: {
      entries: hashed,
      warnings: [...fileWarnings],
      summary: summarise(hashed),
      planHash: combinePlanHash(
        sheet,
        hashed.map((entry) => entry.hash),
      ),
    },
    sheetHash: sheet,
  };
}

/* ------------------------------------------------------------------------ *
 * Matching.
 * ------------------------------------------------------------------------ */

interface StoredMatches {
  /** modelNoKey → saved product id. */
  byKey: Map<string, string>;
  byId: Map<string, StoredProduct>;
  /** Root slugs of the creates that are already taken (one query). */
  takenSlugs: Set<string>;
}

/*
 * Every saved product owning one of the sheet's model nos. The query passes
 * the unique index's collation, so `$in` matches case-insensitively and uses
 * the index (ADR 0055); keys are then compared with modelNoKey.
 */
async function loadMatches(
  products: readonly ImportProduct[],
): Promise<StoredMatches> {
  const modelNos = products
    .filter((p) => !p.blocked)
    .flatMap((p) => p.variants.map((v) => v.modelNo));
  const byKey = new Map<string, string>();
  const byId = new Map<string, StoredProduct>();
  for (let at = 0; at < modelNos.length; at += MATCH_CHUNK) {
    const docs = await ProductModel.find(
      { "variants.modelNo": { $in: modelNos.slice(at, at + MATCH_CHUNK) } },
      STORED_PROJECTION,
      { collation: MODEL_NO_COLLATION },
    ).lean<StoredProduct[]>();
    for (const doc of docs) {
      const id = doc._id.toHexString();
      byId.set(id, doc);
      for (const v of doc.variants) byKey.set(modelNoKey(v.modelNo), id);
    }
  }
  const roots = [
    ...new Set(products.flatMap((p) => (p.slug === "" ? [] : [p.slug]))),
  ];
  const taken =
    roots.length === 0
      ? []
      : await ProductModel.find({ slug: { $in: roots } }, { slug: 1 }).lean<
          { slug: string }[]
        >();
  return { byKey, byId, takenSlugs: new Set(taken.map((t) => t.slug)) };
}

/* The distinct saved products owning any of the product's model nos. */
function matchedIds(
  product: ImportProduct,
  byKey: ReadonlyMap<string, string>,
): string[] {
  const ids = new Set<string>();
  for (const v of product.variants) {
    const id = byKey.get(v.modelNoKey);
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

/*
 * `model_no_conflict`: the sheet product's model nos. belong to several
 * saved products (saving would merge them), or another product of this file
 * matches the same saved product (saving would merge two sheet products).
 * Products are compared as grouped, never by a global NO. (NO. is unique per
 * sheet only).
 */
function conflictWarnings(
  product: ImportProduct,
  ids: readonly string[],
  claims: ReadonlyMap<string, number[]>,
  products: readonly ImportProduct[],
  byId: ReadonlyMap<string, StoredProduct>,
): ImportWarning[] {
  const at = { sheet: product.sheet, row: product.rows[0] };
  if (ids.length > 1) {
    const names = ids.map((id) => `"${byId.get(id)?.name ?? id}"`);
    return [
      importWarning("model_no_conflict", {
        ...at,
        column: "modelNo",
        detail: `This product's model nos. belong to ${ids.length} different saved products (${names.join(", ")}). Saving it would merge them, so it is not imported. Fix the sheet or the saved products first.`,
      }),
    ];
  }
  if (ids.length === 1) {
    const claimants = claims.get(ids[0] as string) ?? [];
    if (claimants.length > 1) {
      const others = claimants
        .map((i) => products[i] as ImportProduct)
        .filter((p) => p !== product)
        .map((p) => `${p.sheet} row ${p.rows[0]}`);
      return [
        importWarning("model_no_conflict", {
          ...at,
          column: "modelNo",
          detail: `This product and the product at ${others.join(", ")} both match the saved product "${byId.get(ids[0] as string)?.name ?? ""}". Saving both would merge them, so neither is imported.`,
        }),
      ];
    }
  }
  return [];
}

/* ------------------------------------------------------------------------ *
 * Entries.
 * ------------------------------------------------------------------------ */

function baseEntry(
  product: ImportProduct,
): Omit<UnhashedEntry, "status" | "target" | "existing" | "name"> {
  return {
    sheet: product.sheet,
    rows: [...product.rows],
    productNo: product.productNo,
    family: product.family,
    imagesToAdd: [],
    variantsRemoved: [],
    changes: [],
    moreChanges: 0,
    warnings: [...product.warnings],
  };
}

function blockedEntry(
  product: ImportProduct,
  extra: readonly ImportWarning[],
): UnhashedEntry {
  const base = baseEntry(product);
  return {
    ...base,
    status: "blocked",
    name: product.name,
    existing: null,
    target: null,
    warnings: [...base.warnings, ...extra],
  };
}

/* A filter key is kept unless its spec column is restricted. */
type FilterGate = (filters: ProductFilters) => ProductFilters;

/*
 * Restricted columns never get filter numbers (rule 9, ADR 0002). The one
 * place that knows which columns are restricted is withoutRestrictedFilters
 * (it reads the visibility setting, failing closed). It is called once with
 * every filter present, and the surviving keys gate every product, so a
 * 500-product plan reads the setting once instead of 500 times.
 */
async function restrictedFilterGate(): Promise<FilterGate> {
  const probe: Required<ProductFilters> = {
    cctK: [0],
    cri: [0],
    beamDeg: [0],
    ugr: [0],
    wattage: [0],
    ip: [0],
  };
  const kept = new Set(Object.keys(await withoutRestrictedFilters(probe)));
  return (filters) =>
    Object.fromEntries(
      Object.entries(filters).filter(([key]) => kept.has(key)),
    ) as ProductFilters;
}

function filtersOf(
  specs: SpecValues,
  variants: readonly { specs: SpecValues }[],
  keep: FilterGate,
): ProductFilters {
  return keep(filtersFromSpecs([specs, ...variants.map((v) => v.specs)]));
}

async function createEntry(
  product: ImportProduct,
  keep: FilterGate,
  categoryById: ReadonlyMap<string, CategoryLookup>,
  reserved: Set<string>,
  takenRoots: ReadonlySet<string>,
): Promise<UnhashedEntry> {
  const base = baseEntry(product);
  const root = product.slug !== "" ? product.slug : product.baseModelCode;
  let slug: string;
  try {
    // Roots were looked up in one query; only a taken root costs queries.
    slug = await uniqueSlug(root, async (candidate) => {
      if (reserved.has(candidate)) return true;
      if (candidate === root) return takenRoots.has(candidate);
      return (await ProductModel.exists({ slug: candidate })) !== null;
    });
  } catch (error) {
    if (!(error instanceof UniqueSlugError)) throw error;
    return blockedEntry(product, [
      importWarning("no_slug", {
        sheet: product.sheet,
        row: product.rows[0],
        detail:
          "No web address could be made from this product's Model Name and Model No. (they need English letters or digits). It is not imported.",
      }),
    ]);
  }

  const variants: PlanVariant[] = product.variants.map((v) => ({
    modelNo: v.modelNo,
    label: v.label,
    specs: v.specs,
    imagePublicId: null,
    imageSha256: v.imageSha256,
    isNew: true,
  }));
  const extraCategories = product.extraCategories.filter(
    (id) => id !== product.mainCategory,
  );
  const target: PlanTarget = {
    name: product.name,
    slug,
    family: product.family,
    type: product.type,
    productNo: product.productNo,
    modelCode: product.baseModelCode,
    specs: product.specs,
    filters: filtersOf(product.specs, variants, keep),
    variants,
    mainCategory: product.mainCategory,
    extraCategories,
    areas: [...product.areas],
    trackSize: trackSizeOf(
      [product.mainCategory, ...extraCategories],
      categoryById,
    ),
  };
  const invalid = recordProblems(product, target);
  if (invalid.length > 0) return blockedEntry(product, invalid);
  reserved.add(slug);
  return {
    ...base,
    status: "create",
    name: target.name,
    existing: null,
    target,
    imagesToAdd: product.images.slice(0, MAX_PRODUCT_IMAGES),
  };
}

function updateEntry(
  product: ImportProduct,
  stored: StoredProduct,
  keep: FilterGate,
  categoryById: ReadonlyMap<string, CategoryLookup>,
  options: PlanOptions,
): UnhashedEntry {
  const base = baseEntry(product);
  const warnings = [...base.warnings];
  const at = { sheet: product.sheet, row: product.rows[0] };

  // Variants: the sheet owns the list, model no. text and specs; a saved
  // label or picture is admin-owned once set.
  const savedByKey = new Map(
    stored.variants.map((v) => [modelNoKey(v.modelNo), v]),
  );
  const variants: PlanVariant[] = product.variants.map((v) => {
    const saved = savedByKey.get(v.modelNoKey);
    if (saved === undefined) {
      return {
        modelNo: v.modelNo,
        label: v.label,
        specs: v.specs,
        imagePublicId: null,
        imageSha256: v.imageSha256,
        isNew: true,
      };
    }
    return {
      modelNo: v.modelNo,
      label: saved.label ?? v.label,
      specs: v.specs,
      imagePublicId: saved.imagePublicId ?? null,
      imageSha256: null,
      isNew: false,
    };
  });
  const sheetKeys = new Set(product.variants.map((v) => v.modelNoKey));
  const variantsRemoved = stored.variants
    .filter((v) => !sheetKeys.has(modelNoKey(v.modelNo)))
    .map((v) => v.modelNo);
  for (const modelNo of variantsRemoved) {
    warnings.push(
      importWarning("variant_removed", {
        ...at,
        column: "modelNo",
        detail: `Model No. "${modelNo}" is saved on this product but not in the sheet. It will be removed if you confirm the removals.`,
      }),
    );
  }

  // Categories and areas: the sheet only when its template column resolved
  // something; otherwise the saved value stays. Same set = saved order kept.
  const savedMain = stored.mainCategory.toHexString();
  const mainCategory = product.mainCategoryFromSheet
    ? product.mainCategory
    : savedMain;
  const savedExtras = stored.extraCategories.map((id) => id.toHexString());
  const extraCategories = (
    product.extraCategoriesFromSheet
      ? sameSetOr(savedExtras, product.extraCategories)
      : savedExtras
  ).filter((id) => id !== mainCategory);
  const savedAreas = stored.areas.map((id) => id.toHexString());
  const areas = product.areasFromSheet
    ? sameSetOr(savedAreas, product.areas)
    : savedAreas;

  // Pictures are append-only, by sha256, within the per-product cap.
  const seen = new Set(
    stored.images.flatMap((image) =>
      image.sourceSha256 === undefined ? [] : [image.sourceSha256],
    ),
  );
  const fresh = product.images.filter((ref) => !seen.has(ref.sha256));
  const room = Math.max(0, MAX_PRODUCT_IMAGES - stored.images.length);
  const imagesToAdd = fresh.slice(0, room);
  if (fresh.length > room) {
    warnings.push(
      importWarning("value_truncated", {
        ...at,
        column: "image",
        detail: `This product would have more than ${MAX_PRODUCT_IMAGES} pictures; ${fresh.length - room} new picture(s) from the sheet are not added.`,
      }),
    );
  }

  const target: PlanTarget = {
    name: stored.name,
    slug: stored.slug,
    family: product.family,
    type: product.type,
    productNo: product.productNo,
    modelCode: product.baseModelCode,
    specs: product.specs,
    filters: filtersOf(product.specs, variants, keep),
    variants,
    mainCategory,
    extraCategories,
    areas,
    trackSize: mergedTrackSize(
      product,
      stored.trackSize ?? null,
      [mainCategory, ...extraCategories],
      categoryById,
    ),
  };
  const invalid = recordProblems(product, target);
  if (invalid.length > 0) return blockedEntry(product, invalid);

  const existing: PlanExisting = {
    id: stored._id.toHexString(),
    slug: stored.slug,
    name: stored.name,
    status: stored.status,
    updatedAt: stored.updatedAt.toISOString(),
  };
  const changes = describeChanges(
    stored,
    target,
    imagesToAdd,
    variantsRemoved,
    options,
  );
  return {
    ...base,
    status: changes.length === 0 ? "unchanged" : "update",
    name: stored.name,
    existing,
    target,
    imagesToAdd,
    variantsRemoved,
    changes: changes.slice(0, MAX_PLAN_CHANGES),
    moreChanges: Math.max(0, changes.length - MAX_PLAN_CHANGES),
    warnings,
  };
}

/*
 * trackSize on update (ADR 0041 + 0057): only while a merged category is
 * Magnetic Track or a child of it (else null, so a product the sheet moves
 * out of Magnetic Track loses it). A 5/10/20mm subcategory the SHEET chose
 * wins; otherwise a saved value is admin-owned, else the derived one.
 */
function mergedTrackSize(
  product: ImportProduct,
  saved: TrackSize | null,
  ids: readonly string[],
  byId: ReadonlyMap<string, CategoryLookup>,
): TrackSize | null {
  const allowed = ids.some((id) => {
    const category = byId.get(id);
    if (category === undefined) return false;
    const root =
      category.parentId === null ? category : byId.get(category.parentId);
    return (
      root !== undefined &&
      root.parentId === null &&
      isMagneticTrackCategory(root)
    );
  });
  if (!allowed) return null;
  const derived = trackSizeOf(ids, byId);
  const fromSheet =
    product.mainCategoryFromSheet || product.extraCategoriesFromSheet;
  if (fromSheet && derived !== null) return derived;
  return saved ?? derived;
}

/* `next`, unless it holds the same ids as `saved` (then the saved order). */
function sameSetOr(
  saved: readonly string[],
  next: readonly string[],
): string[] {
  const a = new Set(saved);
  const same = a.size === new Set(next).size && next.every((id) => a.has(id));
  return same ? [...saved] : [...next];
}

/*
 * Zod on every record: the merged product must pass the same schema as the
 * admin product form (lengths, option caps, MAX_VARIANTS, id shapes, no
 * repeated model no.). A failure blocks the product (`invalid_record`).
 */
function recordProblems(
  product: ImportProduct,
  target: PlanTarget,
): ImportWarning[] {
  const parsed = productInputSchema.safeParse({
    name: target.name,
    slug: target.slug,
    // The form schema's optional texts take undefined or "", not null.
    modelCode: target.modelCode,
    family: target.family ?? undefined,
    productNo: target.productNo,
    type: target.type ?? undefined,
    mainCategory: target.mainCategory,
    extraCategories: target.extraCategories,
    areas: target.areas,
    trackSize: target.trackSize,
    specs: target.specs,
    filters: target.filters,
    variants: target.variants.map((v) => ({
      modelNo: v.modelNo,
      label: v.label,
      specs: v.specs,
      imagePublicId: v.imagePublicId ?? undefined,
    })),
  });
  if (parsed.success) return [];
  return parsed.error.issues.slice(0, 3).map((issue) =>
    importWarning("invalid_record", {
      sheet: product.sheet,
      row: product.rows[0],
      detail: `${issue.path.join(".") || "product"}: ${issue.message}. This product is not imported.`,
    }),
  );
}

/* ------------------------------------------------------------------------ *
 * Diff: what an update changes, as plain text for the preview.
 * ------------------------------------------------------------------------ */

const SPEC_LABEL = new Map<SpecKey, string>(
  SPEC_COLUMNS.map((c) => [c.key as SpecKey, c.header]),
);

/* A field's value: a scalar, a list, or not set (null/undefined/""/[]). */
type Value = string | number | readonly (string | number)[] | null | undefined;

type Push = (field: string, label: string, before: Value, after: Value) => void;

/* Not set → null; everything else kept as is (lists in order). */
function normal(
  value: Value,
): string | number | readonly (string | number)[] | null {
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return value;
}

/* Compared on the raw values, so ["A / B"] and ["A", "B"] differ. */
function differs(a: Value, b: Value): boolean {
  return stableJson(normal(a)) !== stableJson(normal(b));
}

/* What the admin reads: lists joined " / "; not set = null. */
function shown(value: Value): string | null {
  const v = normal(value);
  if (v === null) return null;
  return Array.isArray(v) ? v.join(" / ") : String(v);
}

function describeChanges(
  stored: StoredProduct,
  target: PlanTarget,
  imagesToAdd: readonly ImportImageRef[],
  variantsRemoved: readonly string[],
  options: PlanOptions,
): PlanChange[] {
  const changes: PlanChange[] = [];
  const push: Push = (field, label, before, after) => {
    if (differs(before, after)) {
      changes.push({
        field,
        label,
        before: shown(before),
        after: shown(after),
      });
    }
  };

  push("family", "Model Name", stored.family, target.family);
  push("type", "Model Type", stored.type, target.type);
  push("productNo", "NO.", stored.productNo, target.productNo);
  push("modelCode", "Base model code", stored.modelCode, target.modelCode);
  specChanges(stored.specs ?? {}, target.specs, "specs", "", push);

  const savedByKey = new Map(
    stored.variants.map((v) => [modelNoKey(v.modelNo), v]),
  );
  for (const v of target.variants) {
    const saved = savedByKey.get(modelNoKey(v.modelNo));
    const path = `variants.${v.modelNo}`;
    if (saved === undefined) {
      push(path, `Variant ${v.modelNo}`, null, "added");
      continue;
    }
    push(
      `${path}.modelNo`,
      `${v.modelNo} · Model No.`,
      saved.modelNo,
      v.modelNo,
    );
    push(`${path}.label`, `${v.modelNo} · Label`, saved.label, v.label);
    specChanges(
      saved.specs ?? {},
      v.specs,
      `${path}.specs`,
      `${v.modelNo} · `,
      push,
    );
  }
  for (const modelNo of variantsRemoved) {
    push(`variants.${modelNo}`, `Variant ${modelNo}`, "saved", "removed");
  }
  const order = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  const savedTargetVariants = target.variants
    .filter((v) => !v.isNew)
    .map((v) => modelNoKey(v.modelNo));
  const savedOrder = stored.variants
    .map((v) => modelNoKey(v.modelNo))
    .filter((key) => savedTargetVariants.includes(key));
  if (!order(savedOrder, savedTargetVariants)) {
    push("variants", "Variant order", "saved order", "sheet order");
  }

  const names = categoryNames(options.categories);
  const areaNames = new Map(options.areas.map((a) => [a.id, a.name]));
  const nameOf = (map: ReadonlyMap<string, string>) => (id: string) =>
    map.get(id) ?? id;
  push(
    "mainCategory",
    "Category",
    nameOf(names)(stored.mainCategory.toHexString()),
    nameOf(names)(target.mainCategory),
  );
  push(
    "extraCategories",
    "Extra categories",
    stored.extraCategories.map((id) => nameOf(names)(id.toHexString())),
    target.extraCategories.map(nameOf(names)),
  );
  push(
    "areas",
    "Areas",
    stored.areas.map((id) => nameOf(areaNames)(id.toHexString())),
    target.areas.map(nameOf(areaNames)),
  );
  push("trackSize", "Track size", stored.trackSize, target.trackSize);
  for (const key of FILTER_KEYS) {
    push(
      `filters.${key}`,
      `Filter numbers · ${key}`,
      stored.filters?.[key],
      target.filters[key],
    );
  }
  if (imagesToAdd.length > 0) {
    push(
      "images",
      "Pictures",
      null,
      `${imagesToAdd.length} new picture${imagesToAdd.length === 1 ? "" : "s"}`,
    );
  }
  return changes;
}

const FILTER_KEYS: readonly FilterKey[] = [
  "cctK",
  "cri",
  "beamDeg",
  "ugr",
  "wattage",
  "ip",
];

function specChanges(
  before: SpecValues,
  after: SpecValues,
  path: string,
  prefix: string,
  push: Push,
): void {
  for (const key of SPEC_KEYS) {
    push(
      `${path}.${key}`,
      `${prefix}${SPEC_LABEL.get(key) ?? key}`,
      before[key],
      after[key],
    );
  }
}

/* "Main › Sub" for each category id. */
function categoryNames(
  categories: readonly CategoryLookup[],
): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return new Map(
    categories.map((c) => {
      const parent = c.parentId === null ? undefined : byId.get(c.parentId);
      return [c.id, parent ? `${parent.name} › ${c.name}` : c.name];
    }),
  );
}

/* ------------------------------------------------------------------------ *
 * Summary and hash.
 * ------------------------------------------------------------------------ */

function summarise(entries: readonly UnhashedEntry[]): ImportPlan["summary"] {
  const summary = {
    create: 0,
    update: 0,
    unchanged: 0,
    blocked: 0,
    variantsRemoved: 0,
    imagesToAdd: 0,
  };
  for (const entry of entries) {
    summary[entry.status] += 1;
    summary.variantsRemoved += entry.variantsRemoved.length;
    summary.imagesToAdd += entry.imagesToAdd.length;
  }
  return summary;
}

/*
 * Bumped when the hashed shape changes, so an old preview cannot commit.
 * 2: the plan hash is built from per-entry hashes (T8, ADR 0061).
 */
const PLAN_HASH_VERSION = 2;

/*
 * JSON with object keys sorted, so equal plans hash equal. Arrays keep their
 * order (sheet order is part of the plan). Undefined values are dropped,
 * like JSON.stringify does.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * sha256 (hex) of one entry: what the commit would do for that product
 * (status, rows, the matched product's id and `updatedAt`, the merged
 * target, pictures to add, removals). Warnings and the diff text are not
 * part of it: they describe the entry, they are not written.
 */
export function entryHash(entry: Omit<PlanEntry, "hash">): string {
  return sha256Hex(
    stableJson({
      version: PLAN_HASH_VERSION,
      status: entry.status,
      sheet: entry.sheet,
      rows: entry.rows,
      existing: entry.existing,
      target: entry.target,
      imagesToAdd: entry.imagesToAdd,
      variantsRemoved: entry.variantsRemoved,
    }),
  );
}

/**
 * sha256 (hex) of the sheet side of a plan: the default category and every
 * grouped product as the sheet gave it (its pictures by `images[].sha256`
 * and `variants[].imageSha256`, never the picture bytes). It does not
 * depend on the database, so it stays the same while the commit writes.
 */
export function sheetHash(
  defaultCategoryId: string,
  products: readonly ImportProduct[],
): string {
  return sha256Hex(
    stableJson({ version: PLAN_HASH_VERSION, defaultCategoryId, products }),
  );
}

/** The plan hash from its sheet hash and its entry hashes, in sheet order. */
export function combinePlanHash(
  sheet: string,
  entryHashes: readonly string[],
): string {
  return sha256Hex(
    stableJson({ version: PLAN_HASH_VERSION, sheet, entries: entryHashes }),
  );
}

/**
 * sha256 (hex) of the canonical plan: the sheet hash plus every entry hash.
 * A change to the file, the database (a matched product's `updatedAt`) or
 * the visibility setting between preview and commit changes it. The commit
 * (ADR 0061) re-plans, proves the preview's entry hashes against it, then
 * compares each product of its batch on its own entry hash, so batches
 * already written do not invalidate the ones still to come.
 */
export function planHash(
  defaultCategoryId: string,
  products: readonly ImportProduct[],
  entries: readonly Omit<PlanEntry, "hash">[],
): string {
  return combinePlanHash(
    sheetHash(defaultCategoryId, products),
    entries.map(entryHash),
  );
}
