// The product gallery's image list, built on the server from the public view:
// photos first, drawings after (labelled in the alt text), absolute URLs only
// for images that have one, and "{name}, image n of N" when no alt was written.

import type { PublicImageView } from "@/lib/catalog/view";
import type { ProductImageKind } from "@/models/product-constants";

/** One gallery image as the client gallery receives it (public data only). */
export interface GalleryImage {
  src: string;
  alt: string;
  /** Matches a variant's `imagePublicId` (the switch jumps to it). */
  publicId: string;
  /** Photo ("gallery") or drawing; decides how the frame fits it. */
  kind: ProductImageKind;
}

/*
 * How a fixed frame fits an image (gate C, H-1). Photos fill the frame
 * (object-cover: no grey bars around a photograph); drawings are shown
 * whole (object-contain) and multiplied onto the frame's grey so their
 * white paper does not read as a box inside the box. The lightbox always
 * shows the whole image and does not use this.
 */
const FIT: Record<ProductImageKind, string> = {
  gallery: "object-cover",
  dimension: "object-contain mix-blend-multiply",
  installation: "object-contain mix-blend-multiply",
};

/** The `object-fit` classes for an image of `kind` in a fixed frame. */
export function frameFitClass(kind: ProductImageKind): string {
  return FIT[kind];
}

/* How a non-photo kind is named in the alt text. */
const KIND_LABEL: Record<Exclude<ProductImageKind, "gallery">, string> = {
  dimension: "dimension drawing",
  installation: "installation drawing",
};

/**
 * The gallery in display order. `toSrc` turns a public id into the delivery
 * URL (null = not servable, the image is left out before numbering, so the
 * "n of N" in the alt text always matches what the visitor sees).
 */
export function galleryImages(
  images: readonly PublicImageView[],
  productName: string,
  toSrc: (publicId: string) => string | null,
): GalleryImage[] {
  const ordered = [
    ...images.filter((image) => image.kind === "gallery"),
    ...images.filter((image) => image.kind !== "gallery"),
  ].flatMap((image) => {
    const src = toSrc(image.publicId);
    return src ? [{ image, src }] : [];
  });
  const total = ordered.length;
  return ordered.map(({ image, src }, index) => {
    const written = image.alt?.trim();
    const base = written || `${productName}, image ${index + 1} of ${total}`;
    return {
      src,
      publicId: image.publicId,
      kind: image.kind,
      alt:
        image.kind === "gallery" ? base : `${base} (${KIND_LABEL[image.kind]})`,
    };
  });
}

/** The index of the image a variant points to, or null. */
export function imageIndexFor(
  images: readonly Pick<GalleryImage, "publicId">[],
  publicId: string | null | undefined,
): number | null {
  if (!publicId) return null;
  const index = images.findIndex((image) => image.publicId === publicId);
  return index < 0 ? null : index;
}
