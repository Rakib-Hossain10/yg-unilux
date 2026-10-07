// Pure logic of the product images editor: the editable list, reorder and
// remove, "unsaved" detection, the save payload, client checks and mapping the
// server's errors onto cards. No React; tested in images-editor.test.ts.

import { MAX_PRODUCT_IMAGES } from "@/lib/constants";
import { productImageInputSchema } from "@/lib/schemas/product";
import {
  PRODUCT_IMAGE_KINDS,
  type ProductImageKind,
} from "@/models/product-constants";

import type { ServiceErrors } from "../action-result";

/** One stored image as the edit page passes it (plain JSON). */
export interface StoredImage {
  publicId: string;
  alt?: string;
  order: number;
  kind: ProductImageKind;
}

/**
 * One card of the editor. The public id is unique within a product (the
 * schema refuses duplicates), so it doubles as the React key and the stable
 * part of DOM ids.
 */
export interface EditorImage {
  publicId: string;
  alt: string;
  kind: ProductImageKind;
}

/** Per-card error messages, by field. */
export type CardErrors = Partial<Record<"publicId" | "alt" | "kind", string>>;

/** Labels for the kind select, in PRODUCT_IMAGE_KINDS order. */
export const IMAGE_KIND_LABELS: Readonly<Record<ProductImageKind, string>> = {
  gallery: "Gallery",
  dimension: "Dimension drawing",
  installation: "Installation",
};

export const KIND_OPTIONS = PRODUCT_IMAGE_KINDS.map((kind) => ({
  value: kind,
  label: IMAGE_KIND_LABELS[kind],
}));

export function isImageKind(value: string): value is ProductImageKind {
  return (PRODUCT_IMAGE_KINDS as readonly string[]).includes(value);
}

/** The stored images in display order, as editor cards. */
export function toEditorImages(stored: readonly StoredImage[]): EditorImage[] {
  return [...stored]
    .sort((a, b) => a.order - b.order)
    .map((image) => ({
      publicId: image.publicId,
      alt: image.alt ?? "",
      kind: image.kind,
    }));
}

/** A new upload's card: no alt text yet, shown in the gallery. */
export function newImage(publicId: string): EditorImage {
  return { publicId, alt: "", kind: "gallery" };
}

/**
 * The list with the image at `index` moved one place up or down; the same
 * array when it is already at that edge (the button is aria-disabled there).
 */
export function moveImage(
  list: readonly EditorImage[],
  index: number,
  direction: "up" | "down",
): readonly EditorImage[] {
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || index >= list.length) return list;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** The list without the image with this id. */
export function removeImage(
  list: readonly EditorImage[],
  publicId: string,
): readonly EditorImage[] {
  return list.filter((image) => image.publicId !== publicId);
}

/** The list with one card's fields changed. */
export function updateImage(
  list: readonly EditorImage[],
  publicId: string,
  change: Partial<Pick<EditorImage, "alt" | "kind">>,
): readonly EditorImage[] {
  return list.map((image) =>
    image.publicId === publicId ? { ...image, ...change } : image,
  );
}

/** What the save action receives: the FULL ordered list, alt trimmed. */
export function buildSavePayload(
  productId: string,
  list: readonly EditorImage[],
): {
  productId: string;
  images: { publicId: string; alt: string; kind: ProductImageKind }[];
} {
  return {
    productId,
    images: list.map((image) => ({
      publicId: image.publicId,
      alt: image.alt.trim(),
      kind: image.kind,
    })),
  };
}

/* A list in the shape the server would store (order = position, alt trimmed). */
function comparable(list: readonly EditorImage[]): string {
  return JSON.stringify(buildSavePayload("", list).images);
}

/** True when the list differs from what is saved (order, alt, kind, ids). */
export function hasUnsavedChanges(
  saved: readonly EditorImage[],
  current: readonly EditorImage[],
): boolean {
  return comparable(saved) !== comparable(current);
}

/** Ids in `current` that are not saved on the product yet ("not saved yet"). */
export function unsavedIds(
  saved: readonly EditorImage[],
  current: readonly EditorImage[],
): Set<string> {
  const stored = new Set(saved.map((image) => image.publicId));
  return new Set(
    current
      .filter((image) => !stored.has(image.publicId))
      .map((image) => image.publicId),
  );
}

/** How many more images may be added (uploads in progress count too). */
export function remainingSlots(listLength: number, inProgress: number): number {
  return Math.max(0, MAX_PRODUCT_IMAGES - listLength - inProgress);
}

/**
 * Client checks before saving, with the same Zod rule the server uses for
 * alt text (required, at most MAX_IMAGE_ALT_LENGTH). Keyed by public id.
 */
export function checkImages(
  list: readonly EditorImage[],
): Map<string, CardErrors> {
  const errors = new Map<string, CardErrors>();
  for (const image of list) {
    const alt = productImageInputSchema.shape.alt.safeParse(image.alt);
    if (!alt.success) {
      errors.set(image.publicId, {
        alt: alt.error.issues[0]?.message ?? "Enter alt text",
      });
    }
  }
  return errors;
}

const CARD_FIELD = /^images\.(\d+)\.(publicId|alt|kind)$/;

/**
 * Splits the save action's errors into card errors and section messages.
 * Server keys name cards by their position in the list AS SENT
 * (`images.2.alt`). If the admin changed the list while the save ran,
 * position 2 may now be another card, so then every message goes to the
 * section alert instead of landing on the wrong card (ADR 0044 point 6).
 */
export function mapSaveErrors(
  errors: ServiceErrors,
  sent: readonly EditorImage[],
  current: readonly EditorImage[],
): { cards: Map<string, CardErrors>; messages: string[] } {
  const cards = new Map<string, CardErrors>();
  const messages = [...errors.formErrors];
  const unchanged =
    sent.length === current.length &&
    sent.every((image, index) => image.publicId === current[index]?.publicId);

  for (const [key, list] of Object.entries(errors.fieldErrors)) {
    const message = list[0];
    if (message === undefined) continue;
    const match = CARD_FIELD.exec(key);
    const image = match ? sent[Number(match[1])] : undefined;
    if (match && image && unchanged) {
      const field = match[2] as keyof CardErrors;
      cards.set(image.publicId, {
        ...cards.get(image.publicId),
        [field]: message,
      });
      continue;
    }
    // `images`, `productId` or a card that moved: say which card if known.
    const prefix = match && image ? `Image ${Number(match[1]) + 1}: ` : "";
    for (const text of list) messages.push(`${prefix}${text}`);
  }
  return { cards, messages: [...new Set(messages)] };
}

/** "3 of 30 images", for the section header. */
export function countText(count: number): string {
  return `${count} of ${MAX_PRODUCT_IMAGES} images`;
}
