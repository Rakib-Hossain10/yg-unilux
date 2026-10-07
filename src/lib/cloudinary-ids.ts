// The shape of the Cloudinary public ids this app creates, and which owner an
// id belongs to. Pure (no server-only): Zod form schemas, the models and the
// server-only upload services all check ids with these same patterns.

import { CLOUDINARY_AREA_FOLDER, CLOUDINARY_PRODUCT_FOLDER } from "./constants";

/*
 * Every image the app uploads gets a server-chosen id
 * `yg/<collection>/<ownerObjectId>/<uuid v4>`, all lowercase (ADR "Direct
 * uploads, server verifies"). The browser never picks the id, so it can't
 * overwrite another product's image or write outside our folders.
 */
const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const OBJECT_ID = "[0-9a-f]{24}";

/**
 * Any id of ours, whatever its folder: `yg/<folder>/<objectId>/<uuid>`. Used
 * where the owner is not known (form schemas, the shared model field).
 */
export const PUBLIC_ID_PATTERN = new RegExp(
  `^yg/[a-z]+(?:-[a-z]+)*/${OBJECT_ID}/${UUID_V4}$`,
);

/** The owners an upload can belong to, and their Cloudinary folders. */
export const IMAGE_UPLOAD_FOLDERS = {
  product: CLOUDINARY_PRODUCT_FOLDER,
  area: CLOUDINARY_AREA_FOLDER,
} as const;
export type ImageUploadTarget = keyof typeof IMAGE_UPLOAD_FOLDERS;
export const IMAGE_UPLOAD_TARGETS = Object.keys(
  IMAGE_UPLOAD_FOLDERS,
) as ImageUploadTarget[];

/** True for any id in our shape. */
export function isPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}

/**
 * True only for an id under this exact owner's folder, e.g.
 * `yg/products/<productId>/<uuid>` for that product. `ownerId` must already
 * be a lowercase 24-hex id; anything else matches nothing.
 */
export function isOwnPublicId(
  target: ImageUploadTarget,
  ownerId: string,
  publicId: string,
): boolean {
  if (!new RegExp(`^${OBJECT_ID}$`).test(ownerId)) return false;
  const pattern = new RegExp(
    `^${IMAGE_UPLOAD_FOLDERS[target]}/${ownerId}/${UUID_V4}$`,
  );
  return pattern.test(publicId);
}

/**
 * The id for a new upload. `uuid` comes from crypto.randomUUID() on the
 * server; it is checked so a bad value can never produce an id that the
 * patterns above would later refuse.
 */
export function buildPublicId(
  target: ImageUploadTarget,
  ownerId: string,
  uuid: string,
): string {
  const id = `${IMAGE_UPLOAD_FOLDERS[target]}/${ownerId}/${uuid}`;
  if (!isOwnPublicId(target, ownerId, id)) {
    throw new TypeError("buildPublicId needs a lowercase ObjectId and UUID v4");
  }
  return id;
}
