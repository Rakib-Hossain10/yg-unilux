// Plain view models (DTOs) of the public catalog and the pure helpers that
// build them: projections from column visibility, the variant merge rule and
// the lean-document-to-view mapping. No server-only: types are shared.

import type { Types } from "mongoose";

import type { Product, ProductImageKind } from "@/models/product";
import {
  restrictedSpecKeys,
  SPEC_KEYS,
  type SpecKey,
  type SpecValues,
  type SpecVisibility,
} from "@/models/spec-columns";

// ---------------------------------------------------------------------------
// View types (string ids, ISO dates, plain data only: they are JSON-cached)
// ---------------------------------------------------------------------------

/** A Cloudinary image of a product, as the public site shows it. */
export interface PublicImageView {
  publicId: string;
  alt: string | null;
  order: number;
  kind: ProductImageKind;
}

/** One model no. of a product. `specs` = public values merged (variant wins). */
export interface PublicVariantView {
  modelNo: string;
  /**
   * The optic switch label, or null (the page shows the model no.). Always
   * null while any of VARIANT_LABEL_SOURCE_KEYS is restricted: the import
   * builds labels from those values (ADR 0063).
   */
  label: string | null;
  imagePublicId: string | null;
  specs: SpecValues;
}

/** An application area the product belongs to (the "Applications" row). */
export interface PublicAreaView {
  id: string;
  name: string;
  slug: string;
  bwImage: string | null;
}

export interface PublicExtraSpecView {
  group: string | null;
  label: string;
  value: string;
}

export interface PublicFileView {
  label: string;
  url: string;
}

/**
 * A published product page's data with every restricted column projected away
 * (ADR 0002, 0063). Never holds the datasheet id, filters, status or any
 * admin-only field: only what the cached public page may show.
 */
export interface PublicProductView {
  id: string;
  slug: string;
  name: string;
  family: string | null;
  modelCode: string | null;
  productNo: number | null;
  type: string | null;
  description: string | null;
  mainCategoryId: string;
  extraCategoryIds: string[];
  areas: PublicAreaView[];
  trackSize: number | null;
  /** Sorted by `order`. */
  images: PublicImageView[];
  /** Product-level public specs (shared by every variant). */
  specs: SpecValues;
  /** In stored order; the first one is what the static page shows. */
  variants: PublicVariantView[];
  extraSpecs: PublicExtraSpecView[];
  publicFiles: PublicFileView[];
  /** A datasheet is attached. The id itself never reaches cached HTML. */
  hasDatasheet: boolean;
  updatedAt: string;
}

/** A small product card (family and related strips). Holds no spec values. */
export interface ProductCardView {
  id: string;
  slug: string;
  name: string;
  family: string | null;
  modelCode: string | null;
  image: PublicImageView | null;
}

/** One step of the category path, main category first. */
export interface BreadcrumbItem {
  id: string;
  name: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// Spec helpers
// ---------------------------------------------------------------------------

/** Column visibility by key (the admin setting, or a partial override). */
export type VisibilityByKey = Partial<Record<SpecKey, SpecVisibility>>;

/** The public spec keys under this visibility, in sheet order. */
export function publicSpecKeys(visibility: VisibilityByKey): SpecKey[] {
  const restricted = new Set(restrictedSpecKeys(visibility));
  return SPEC_KEYS.filter((key) => !restricted.has(key));
}

/* A stored spec value as a clean list of strings; anything else is dropped. */
function cleanValues(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string" && entry !== "",
  );
  return strings.length > 0 ? strings : null;
}

/**
 * Copies only the allowed keys with a non-empty value, in sheet order. The
 * second guard after the projection: a key outside `allowed` can never be
 * copied into a view, whatever the query returned.
 */
export function pickSpecs(
  specs: SpecValues | null | undefined,
  allowed: readonly SpecKey[],
): SpecValues {
  const out: SpecValues = {};
  if (!specs) return out;
  const allowedSet = new Set(allowed);
  for (const key of SPEC_KEYS) {
    if (!allowedSet.has(key)) continue;
    const values = cleanValues(specs[key]);
    if (values) out[key] = [...values];
  }
  return out;
}

/**
 * The values one variant shows: its own value for a key when it has one,
 * otherwise the product's (variant specs hold only what differs). Keys
 * absent from both stay absent ("not applicable"). Sheet order.
 */
export function mergeVariantSpecs(
  productSpecs: SpecValues | null | undefined,
  variantSpecs: SpecValues | null | undefined,
): SpecValues {
  const out: SpecValues = {};
  for (const key of SPEC_KEYS) {
    const values =
      cleanValues(variantSpecs?.[key]) ?? cleanValues(productSpecs?.[key]);
    if (values) out[key] = [...values];
  }
  return out;
}

/**
 * The columns variant labels are built from (the import's optic keys,
 * src/lib/import/group.ts). A label may hold their values, so it is public
 * only while all of them are.
 */
export const VARIANT_LABEL_SOURCE_KEYS: readonly SpecKey[] = [
  "lens",
  "reflector",
  "diffuser",
];

/** Variant labels may be shown: every label source column is public. */
export function variantLabelsArePublic(
  publicKeys: readonly SpecKey[],
): boolean {
  const allowed = new Set(publicKeys);
  return VARIANT_LABEL_SOURCE_KEYS.every((key) => allowed.has(key));
}

// ---------------------------------------------------------------------------
// Projections (inclusion only: a field nobody listed is never loaded)
// ---------------------------------------------------------------------------

export type Projection = Record<string, 1>;

/**
 * The product-page query's projection: identity, images, extras, the
 * datasheet reference and ONLY the public spec keys, at product and variant
 * level. Restricted columns are not in the result at all (ADR 0002); neither
 * is the variant label while a label source column is restricted.
 */
export function publicProductProjection(
  publicKeys: readonly SpecKey[],
): Projection {
  const projection: Projection = {
    name: 1,
    slug: 1,
    family: 1,
    modelCode: 1,
    productNo: 1,
    type: 1,
    description: 1,
    mainCategory: 1,
    extraCategories: 1,
    areas: 1,
    trackSize: 1,
    "images.publicId": 1,
    "images.alt": 1,
    "images.order": 1,
    "images.kind": 1,
    "variants.modelNo": 1,
    "variants.imagePublicId": 1,
    "extraSpecs.group": 1,
    "extraSpecs.label": 1,
    "extraSpecs.value": 1,
    "publicFiles.label": 1,
    "publicFiles.url": 1,
    datasheetId: 1,
    updatedAt: 1,
  };
  if (variantLabelsArePublic(publicKeys)) projection["variants.label"] = 1;
  for (const key of publicKeys) {
    projection[`specs.${key}`] = 1;
    projection[`variants.specs.${key}`] = 1;
  }
  return projection;
}

/** The card projection: no specs, no variants, no datasheet. */
export const PRODUCT_CARD_PROJECTION: Projection = {
  name: 1,
  slug: 1,
  family: 1,
  modelCode: 1,
  "images.publicId": 1,
  "images.alt": 1,
  "images.order": 1,
  "images.kind": 1,
};

// ---------------------------------------------------------------------------
// Lean document -> view
// ---------------------------------------------------------------------------

/** The fields the public projection loads (all optional: projected docs). */
export type PublicProductDoc = Pick<Product, "_id" | "name" | "slug"> &
  Partial<
    Pick<
      Product,
      | "family"
      | "modelCode"
      | "productNo"
      | "type"
      | "description"
      | "mainCategory"
      | "extraCategories"
      | "areas"
      | "trackSize"
      | "images"
      | "specs"
      | "variants"
      | "extraSpecs"
      | "publicFiles"
      | "datasheetId"
      | "updatedAt"
    >
  >;

export type ProductCardDoc = Pick<Product, "_id" | "name" | "slug"> &
  Partial<Pick<Product, "family" | "modelCode" | "images">>;

const hex = (id: Types.ObjectId | string): string => String(id);
const orNull = <T>(value: T | null | undefined): T | null => value ?? null;

function imagesOf(doc: { images?: Product["images"] }): PublicImageView[] {
  return [...(doc.images ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((image) => ({
      publicId: image.publicId,
      alt: orNull(image.alt),
      order: image.order,
      kind: image.kind,
    }));
}

/**
 * Maps a projected product to its public view. `publicKeys` is applied again
 * (pickSpecs), so a restricted key cannot pass even if the projection were
 * wrong. `areas` are the resolved area records, in display order.
 */
export function toPublicProductView(
  doc: PublicProductDoc,
  publicKeys: readonly SpecKey[],
  areas: PublicAreaView[],
): PublicProductView {
  const specs = pickSpecs(doc.specs, publicKeys);
  const showLabels = variantLabelsArePublic(publicKeys);
  return {
    id: hex(doc._id),
    slug: doc.slug,
    name: doc.name,
    family: orNull(doc.family),
    modelCode: orNull(doc.modelCode),
    productNo: orNull(doc.productNo),
    type: orNull(doc.type),
    description: orNull(doc.description),
    mainCategoryId: doc.mainCategory ? hex(doc.mainCategory) : "",
    extraCategoryIds: (doc.extraCategories ?? []).map(hex),
    areas,
    trackSize: orNull(doc.trackSize),
    images: imagesOf(doc),
    specs,
    variants: (doc.variants ?? []).map((variant) => ({
      modelNo: variant.modelNo,
      // Second guard after the projection: a label may hold restricted values.
      label: showLabels ? orNull(variant.label) : null,
      imagePublicId: orNull(variant.imagePublicId),
      specs: mergeVariantSpecs(specs, pickSpecs(variant.specs, publicKeys)),
    })),
    extraSpecs: (doc.extraSpecs ?? []).map((extra) => ({
      group: orNull(extra.group),
      label: extra.label,
      value: extra.value,
    })),
    publicFiles: (doc.publicFiles ?? []).map((file) => ({
      label: file.label,
      url: file.url,
    })),
    hasDatasheet: doc.datasheetId != null,
    updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : "",
  };
}

/** The card's picture: the first gallery photo, else the first image. */
export function toProductCardView(doc: ProductCardDoc): ProductCardView {
  const images = imagesOf(doc);
  const image =
    images.find((candidate) => candidate.kind === "gallery") ??
    images[0] ??
    null;
  return {
    id: hex(doc._id),
    slug: doc.slug,
    name: doc.name,
    family: orNull(doc.family),
    modelCode: orNull(doc.modelCode),
    image,
  };
}
