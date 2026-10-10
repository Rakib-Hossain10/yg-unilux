// Admin service for a product's images: saves the images editor's full
// ordered list (add, remove, reorder, alt text, kind) after verifying every
// new Cloudinary upload. Audits `product.images.update` with counts only.
// An imported image's sourceSha256 is kept by the server, never sent by the
// browser, so the import's dedupe survives every editor save (ADR 0055).

import "server-only";

import { isOwnPublicId } from "@/lib/cloudinary-ids";
import { connectDb, mongoose } from "@/lib/db";
import {
  productImagesInputSchema,
  type ProductImageInput,
} from "@/lib/schemas/product";
import { ProductModel } from "@/models";
import type { Product, ProductImage } from "@/models/product";

import { refuseUnlessAdmin, type AdminActor } from "./actor";
import {
  expectedVersion,
  PRODUCT_CHANGED,
  PRODUCT_NOT_FOUND,
  tagsFor,
  type ProductWriteOptions,
} from "./products";
import { IMAGE_REJECTED, verifyUploadedImage } from "./uploads";
import {
  auditAndFinish,
  formError,
  invalidInput,
  unchanged,
  type ServiceResult,
} from "./write-result";

const { ObjectId } = mongoose.Types;

/** A published product must keep at least one image (ADR 0019). */
export const PUBLISHED_NEEDS_IMAGE =
  "A published product needs at least one image. Unpublish it first to remove the last one.";

export interface SavedProductImages {
  id: string;
  images: ProductImage[];
}

type ImagesRow = Pick<Product, "images" | "status" | "updatedAt"> & {
  variants: { modelNo: string; imagePublicId?: string }[];
};

/* A failure with several field errors; nothing written. */
function fieldErrors(fields: Record<string, string[]>): ServiceResult<never> {
  return {
    ok: false,
    errors: { formErrors: [], fieldErrors: fields },
    tags: [],
  };
}

/* One stored image; sourceSha256 only when there is one (keeps key order). */
function storedImage(
  image: Pick<ProductImage, "publicId" | "kind"> & { alt: string },
  order: number,
  sourceSha256: string | undefined,
): ProductImage {
  return {
    publicId: image.publicId,
    alt: image.alt,
    order,
    kind: image.kind,
    ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
  };
}

/*
 * The stored form of the list: position = order, alt and kind as given.
 * sourceSha256 is not an editor field: it is copied from the image already
 * saved under the same publicId (new uploads have none).
 */
function toStored(
  images: ProductImageInput[],
  saved: ProductImage[],
): ProductImage[] {
  const hashes = new Map(
    saved.map((image) => [image.publicId, image.sourceSha256]),
  );
  return images.map((image, order) =>
    storedImage(image, order, hashes.get(image.publicId)),
  );
}

/* Stored images in display order, in a shape that compares 1:1. */
function normalised(images: ProductImage[]): ProductImage[] {
  return [...images]
    .sort((a, b) => a.order - b.order)
    .map((image, order) =>
      storedImage(
        { ...image, alt: image.alt ?? "" },
        order,
        image.sourceSha256,
      ),
    );
}

/**
 * Saves the full ordered image list of one product. Idempotent: the same
 * list twice changes nothing the second time. Rules:
 * - an id must already be saved on this product, or be a NEW upload in this
 *   product's own folder that passes verification (exists, size, format);
 *   a rejected new upload is deleted from Cloudinary and nothing is saved;
 * - an image a variant points at can't be removed (pick another first);
 * - a published product keeps at least one image;
 * - with `expectedUpdatedAt`, a product changed since the page loaded is
 *   refused with PRODUCT_CHANGED (ADR 0043).
 * Removed images are NOT deleted from Cloudinary here: they are public, a
 * stale tab or the cached public page may still show them, and a delete
 * can't be undone. The T17 orphan report lists them.
 */
export async function saveProductImages(
  actor: AdminActor,
  input: unknown,
  options: ProductWriteOptions = {},
): Promise<ServiceResult<SavedProductImages>> {
  const refused = await refuseUnlessAdmin(actor, "product-images");
  if (refused) return refused;
  const expected = expectedVersion(options);
  if (expected === "bad") return formError(PRODUCT_CHANGED);
  const parsed = productImagesInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { productId, images } = parsed.data;
  const selfId = new ObjectId(productId);

  await connectDb();
  const doc = await ProductModel.findById(selfId, {
    images: 1,
    status: 1,
    updatedAt: 1,
    "variants.modelNo": 1,
    "variants.imagePublicId": 1,
  }).lean<ImagesRow | null>();
  if (!doc) return formError(PRODUCT_NOT_FOUND);
  if (expected && doc.updatedAt.getTime() !== expected.getTime()) {
    return formError(PRODUCT_CHANGED);
  }

  const stored = new Set(doc.images.map((image) => image.publicId));
  const wanted = new Set(images.map((image) => image.publicId));
  const errors: Record<string, string[]> = {};

  // Only saved ids or uploads in this product's own folder.
  const fresh: { index: number; publicId: string }[] = [];
  images.forEach((image, index) => {
    if (stored.has(image.publicId)) return;
    if (isOwnPublicId("product", productId, image.publicId)) {
      fresh.push({ index, publicId: image.publicId });
    } else {
      errors[`images.${index}.publicId`] = [IMAGE_REJECTED.foreign];
    }
  });

  const removed = [...stored].filter((publicId) => !wanted.has(publicId));
  const usedBy = doc.variants.filter(
    (variant) =>
      variant.imagePublicId !== undefined &&
      removed.includes(variant.imagePublicId),
  );
  if (usedBy.length > 0) {
    errors.images = [
      `An image you removed is used by ${usedBy.length === 1 ? "variant" : "variants"} ${usedBy
        .map((variant) => variant.modelNo)
        .join(
          ", ",
        )}. Choose another image for ${usedBy.length === 1 ? "it" : "them"} first.`,
    ];
  }
  if (doc.status === "published" && images.length === 0) {
    (errors.images ??= []).push(PUBLISHED_NEEDS_IMAGE);
  }
  if (Object.keys(errors).length > 0) return fieldErrors(errors);

  const next = toStored(images, doc.images);
  if (JSON.stringify(next) === JSON.stringify(normalised(doc.images))) {
    return unchanged({ id: productId, images: next });
  }

  // Verify every new upload (Cloudinary Admin API); bad ones are deleted.
  const checks = await Promise.all(
    fresh.map(async ({ index, publicId }) => ({
      index,
      result: await verifyUploadedImage({
        target: "product",
        id: productId,
        publicId,
      }),
    })),
  );
  for (const { index, result } of checks) {
    if (!result.ok) errors[`images.${index}.publicId`] = [result.message];
  }
  if (Object.keys(errors).length > 0) return fieldErrors(errors);

  const result = await ProductModel.updateOne(
    {
      _id: selfId,
      ...(expected ? { updatedAt: expected } : {}),
      // Atomic guards for the checks above, in case of a concurrent write.
      ...(removed.length > 0
        ? { "variants.imagePublicId": { $nin: removed } }
        : {}),
      ...(next.length === 0 ? { status: { $ne: "published" } } : {}),
    },
    { $set: { images: next } },
    { runValidators: true },
  );
  if (result.matchedCount === 0) {
    const exists = await ProductModel.exists({ _id: selfId });
    return formError(exists ? PRODUCT_CHANGED : PRODUCT_NOT_FOUND);
  }

  return auditAndFinish(
    {
      actorId: actor.id,
      action: "product.images.update",
      target: { type: "product", id: productId },
      meta: {
        imageCount: next.length,
        added: fresh.length,
        removed: removed.length,
      },
    },
    { id: productId, images: next },
    tagsFor(productId, doc.status === "published"),
  );
}
