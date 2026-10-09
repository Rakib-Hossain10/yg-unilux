// Admin services for direct image uploads to Cloudinary: sign one upload to a
// server-chosen public id, and verify an upload afterwards (owner, size,
// format), deleting a rejected one. Saving the id is the caller's job.

import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  buildPublicId,
  IMAGE_UPLOAD_TARGETS,
  isOwnPublicId,
  type ImageUploadTarget,
} from "@/lib/cloudinary-ids";
import {
  destroyImage,
  inspectImage,
  signImageUpload,
  type ImageFormatList,
  type ImageRejection,
  type SignedUpload,
} from "@/lib/cloudinary";
import { ALLOWED_IMAGE_FORMATS, MAX_IMAGE_BYTES } from "@/lib/constants";
import { connectDb, mongoose } from "@/lib/db";
import { objectIdSchema } from "@/lib/schemas/common";
import { AreaModel, CategoryModel, ProductModel } from "@/models";

import {
  assertActorId,
  formError,
  invalidInput,
  type ServiceResult,
} from "./write-result";

const { ObjectId } = mongoose.Types;

/**
 * What the upload is for: a product's images, an area's b/w image or a
 * category's icon/cover.
 */
export const signUploadSchema = z.strictObject({
  target: z.enum(IMAGE_UPLOAD_TARGETS),
  id: objectIdSchema,
});

const OWNER_GONE: Record<ImageUploadTarget, string> = {
  product: "This product no longer exists. Reload the page.",
  area: "This area no longer exists. Reload the page.",
  category: "This category no longer exists. Reload the page.",
};

/* True when the product, area or category the upload is for exists. */
async function ownerExists(
  target: ImageUploadTarget,
  id: string,
): Promise<boolean> {
  const filter = { _id: new ObjectId(id) };
  switch (target) {
    case "product":
      return (await ProductModel.exists(filter)) !== null;
    case "area":
      return (await AreaModel.exists(filter)) !== null;
    case "category":
      return (await CategoryModel.exists(filter)) !== null;
  }
}

/** Server-chosen upload options; never taken from the browser. */
export interface UploadFormatOptions {
  /** Cloudinary formats accepted (default jpg/png/webp/avif). */
  formats?: ImageFormatList;
}

/**
 * Signs one direct browser upload (ADR "Direct uploads, server verifies").
 * The server picks the public id (`yg/<folder>/<ownerId>/<uuid>`), so the
 * browser can only upload a new file under this owner, in an allowed format,
 * without overwriting anything. Nothing is written, so there are no tags.
 * The UI then POSTs `fields` + the file to `uploadUrl`, and passes the
 * `publicId` to the save action, which verifies it.
 */
export async function signCloudinaryUpload(
  actorId: string,
  input: unknown,
  options: UploadFormatOptions = {},
): Promise<ServiceResult<SignedUpload>> {
  assertActorId(actorId);
  const parsed = signUploadSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { target, id } = parsed.data;

  await connectDb();
  if (!(await ownerExists(target, id))) return formError(OWNER_GONE[target]);

  const publicId = buildPublicId(target, id, randomUUID());
  const timestamp = Math.floor(Date.now() / 1000);
  const signed =
    options.formats === undefined
      ? signImageUpload(publicId, timestamp)
      : signImageUpload(publicId, timestamp, options.formats);
  return { ok: true, data: signed, tags: [] };
}

/** Messages for the admin, one per rejection reason. */
export const IMAGE_REJECTED: Record<ImageRejection | "foreign", string> = {
  foreign: "This image was not uploaded for this item. Upload it again.",
  missing: "The upload was not found. Upload the image again.",
  too_large: `The image is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB. It was removed; upload a smaller one.`,
  bad_format: `Only ${ALLOWED_IMAGE_FORMATS.join(", ")} images are accepted. The file was removed.`,
  unavailable:
    "The image could not be checked right now. Try saving again in a minute.",
};

/** The bad-format message for a custom format list, e.g. "png, svg, webp". */
export function badFormatMessage(formats: ImageFormatList): string {
  return `Only ${formats.join(", ")} images are accepted. The file was removed.`;
}

export const verifyUploadSchema = signUploadSchema.extend({
  publicId: z.string().max(255),
});

export type VerifyResult =
  | { ok: true; publicId: string }
  | { ok: false; reason: ImageRejection | "foreign"; message: string };

/**
 * Checks one NEW upload before its id is saved: it must sit in this owner's
 * own folder, exist in Cloudinary, be at most MAX_IMAGE_BYTES and be jpg,
 * png, webp or avif. A rejected upload of ours is deleted at once (best
 * effort). An id outside the owner's folder is refused and NEVER deleted,
 * because it may be another product's live image. When Cloudinary can't be
 * reached nothing is deleted; the admin retries.
 */
export async function verifyUploadedImage(
  input: unknown,
  options: UploadFormatOptions = {},
): Promise<VerifyResult> {
  const parsed = verifyUploadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "foreign", message: IMAGE_REJECTED.foreign };
  }
  const { target, id, publicId } = parsed.data;
  if (!isOwnPublicId(target, id, publicId)) {
    return { ok: false, reason: "foreign", message: IMAGE_REJECTED.foreign };
  }

  const check =
    options.formats === undefined
      ? await inspectImage(publicId)
      : await inspectImage(publicId, options.formats);
  if (check.ok) return { ok: true, publicId };
  if (check.reason !== "unavailable") await destroyImage(publicId);
  return {
    ok: false,
    reason: check.reason,
    message:
      check.reason === "bad_format" && options.formats !== undefined
        ? badFormatMessage(options.formats)
        : IMAGE_REJECTED[check.reason],
  };
}
