// Server-only Cloudinary access for public images: signing a direct browser
// upload, uploading a server-held image (bulk import), checking what was
// uploaded (size, format) and deleting a rejected upload. Credentials come
// only from env.cloudinary() (ADR 0016).

import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";

import { ALLOWED_IMAGE_FORMATS, MAX_IMAGE_BYTES } from "./constants";
import { buildPublicId, isOwnPublicId, isPublicId } from "./cloudinary-ids";
import { env } from "./env";

/*
 * Configures the SDK explicitly from our validated env (ADR 0016) instead of
 * letting it read CLOUDINARY_URL by itself. Called before every SDK use: it
 * is a cheap object merge, nothing is read at import time, and a changed env
 * (tests, a rotated key) is always picked up. Returns the credentials so a
 * caller never reads them twice.
 */
function configure() {
  const credentials = env.cloudinary();
  cloudinary.config({
    cloud_name: credentials.cloudName,
    api_key: credentials.apiKey,
    api_secret: credentials.apiSecret,
    secure: true,
  });
  return credentials;
}

/**
 * Exactly the form fields the browser posts to Cloudinary's Upload API next
 * to the file. Every field except `api_key` (and the file) is covered by the
 * signature, so the browser cannot change the id, the formats or overwrite.
 */
export interface SignedUploadFields {
  api_key: string;
  timestamp: string;
  public_id: string;
  allowed_formats: string;
  /** "false": a replayed signature can't replace an image after it was verified. */
  overwrite: "false";
  signature: string;
}

export interface SignedUpload {
  /** POST target: https://api.cloudinary.com/v1_1/<cloud>/image/upload */
  uploadUrl: string;
  cloudName: string;
  publicId: string;
  fields: SignedUploadFields;
}

/**
 * Signs a direct upload of one image to the server-chosen `publicId`.
 * `timestampSeconds` is the Unix time in seconds (Cloudinary refuses
 * signatures older than an hour). The API secret never leaves this function.
 */
export function signImageUpload(
  publicId: string,
  timestampSeconds: number,
): SignedUpload {
  if (!isPublicId(publicId)) {
    throw new TypeError("signImageUpload needs a server-built public id");
  }
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
    throw new TypeError("signImageUpload needs a Unix timestamp in seconds");
  }
  const { cloudName, apiKey, apiSecret } = configure();

  // The parameters that are signed: everything the browser sends except
  // file, api_key, cloud_name and resource_type (Cloudinary's signing rules).
  const signed = {
    timestamp: String(timestampSeconds),
    public_id: publicId,
    allowed_formats: ALLOWED_IMAGE_FORMATS.join(","),
    overwrite: "false" as const,
  };
  const signature = cloudinary.utils.api_sign_request(signed, apiSecret);

  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    cloudName,
    publicId,
    fields: { ...signed, api_key: apiKey, signature },
  };
}

/** Why an uploaded image was not accepted. */
export type ImageRejection =
  /** Cloudinary has no image with this id (never uploaded, or deleted). */
  | "missing"
  /** Larger than MAX_IMAGE_BYTES. */
  | "too_large"
  /** Not jpg, png, webp or avif, or not an image at all. */
  | "bad_format"
  /** Cloudinary could not be asked (network, rate limit, outage). */
  | "unavailable";

export type ImageCheck =
  | { ok: true; bytes: number; format: string; width: number; height: number }
  | { ok: false; reason: ImageRejection };

/* Reads `http_code` from the SDK's rejection shapes ({error: {...}} or flat). */
function httpCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const nested = (error as { error?: { http_code?: unknown } }).error;
  const code =
    nested?.http_code ?? (error as { http_code?: unknown }).http_code;
  return typeof code === "number" ? code : undefined;
}

const FORMATS: ReadonlySet<string> = new Set(ALLOWED_IMAGE_FORMATS);

/**
 * Asks Cloudinary's Admin API what is stored under `publicId` and checks it
 * against our limits. The signed upload cannot cap the size, so this check
 * after the upload is what enforces MAX_IMAGE_BYTES.
 */
export async function inspectImage(publicId: string): Promise<ImageCheck> {
  configure();
  let resource: unknown;
  try {
    resource = await cloudinary.api.resource(publicId, {
      resource_type: "image",
      type: "upload",
    });
  } catch (error) {
    if (httpCode(error) === 404) return { ok: false, reason: "missing" };
    // Never log the error object: it carries the request options.
    console.error(
      `[cloudinary] resource lookup failed (http ${httpCode(error) ?? "n/a"})`,
    );
    return { ok: false, reason: "unavailable" };
  }

  return checkStoredImage(resource);
}

/*
 * The limits every stored image must meet, applied to what Cloudinary says it
 * stored: an Admin API resource (browser uploads) or the Upload API response
 * the server received itself (uploadImageBuffer). Both carry the same fields.
 */
function checkStoredImage(resource: unknown): ImageCheck {
  const { bytes, format, width, height, resource_type } = (resource ??
    {}) as Record<string, unknown>;
  if (resource_type !== "image" || typeof format !== "string") {
    return { ok: false, reason: "bad_format" };
  }
  if (!FORMATS.has(format.toLowerCase())) {
    return { ok: false, reason: "bad_format" };
  }
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, reason: "bad_format" };
  }
  if (bytes > MAX_IMAGE_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  return {
    ok: true,
    bytes,
    format: format.toLowerCase(),
    width: typeof width === "number" ? width : 0,
    height: typeof height === "number" ? height : 0,
  };
}

/**
 * Deletes one uploaded image and asks the CDN to drop cached copies. Best
 * effort: used to clean up a rejected upload, so a failure is logged (without
 * the id's owner data or SDK details) and never thrown.
 */
export async function destroyImage(publicId: string): Promise<boolean> {
  if (!isPublicId(publicId)) return false;
  try {
    configure();
    const result: unknown = await cloudinary.uploader.destroy(publicId, {
      resource_type: "image",
      type: "upload",
      invalidate: true,
    });
    const outcome = (result as { result?: unknown } | null)?.result;
    return outcome === "ok" || outcome === "not found";
  } catch (error) {
    console.error(
      `[cloudinary] destroy failed (http ${httpCode(error) ?? "n/a"})`,
    );
    return false;
  }
}

/** One uploaded image as listed by the Admin API. */
export interface ListedImage {
  publicId: string;
  createdAt: Date | undefined;
}

/**
 * Every uploaded image whose public id starts with `prefix` (follows
 * pagination). For the orphan sweep. Throws on failure with a message that
 * carries only the HTTP code, never the request options.
 */
export async function listImages(prefix: string): Promise<ListedImage[]> {
  configure();
  const found: ListedImage[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = (await cloudinary.api.resources({
        resource_type: "image",
        type: "upload",
        prefix,
        max_results: 500,
        next_cursor: cursor,
      })) as {
        resources?: { public_id?: unknown; created_at?: unknown }[];
        next_cursor?: unknown;
      };
      for (const item of page.resources ?? []) {
        if (typeof item.public_id !== "string") continue;
        const created =
          typeof item.created_at === "string"
            ? new Date(item.created_at)
            : undefined;
        found.push({
          publicId: item.public_id,
          createdAt:
            created && !Number.isNaN(created.getTime()) ? created : undefined,
        });
      }
      cursor =
        typeof page.next_cursor === "string" && page.next_cursor
          ? page.next_cursor
          : undefined;
    } while (cursor !== undefined);
  } catch (error) {
    throw new Error(
      `Cloudinary listing failed (http ${httpCode(error) ?? "n/a"})`,
    );
  }
  return found;
}

/** Why a server-side upload was not kept. */
export type ServerUploadRejection =
  | ImageRejection
  /** Cloudinary already had an asset under the new id (never ours to touch). */
  | "exists";

/** One image uploaded and verified from the server (bulk import, Phase 3). */
export interface UploadedImage {
  /** `yg/products/<productId>/<uuid v4>`, chosen here. */
  publicId: string;
  /**
   * sha256 (64 lowercase hex) of the bytes uploaded, computed here so the
   * stored `ProductImage.sourceSha256` always matches the file (ADR 0055).
   */
  sourceSha256: string;
  bytes: number;
  format: string;
  width: number;
  height: number;
}

export type ServerUploadResult =
  | { ok: true; image: UploadedImage }
  | { ok: false; reason: ServerUploadRejection };

/* Sends `data` through the SDK's upload stream (no base64 copy in memory). */
function uploadStream(
  data: Uint8Array,
  options: Record<string, unknown>,
): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error || !result) reject(error ?? new Error("empty response"));
        else resolve(result);
      },
    );
    stream.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  });
}

/**
 * Uploads one image held by the server to a new, server-chosen id under the
 * product's folder (`yg/products/<productId>/<uuid>`), signed with our API
 * secret, `overwrite: false`, only jpg/png/webp/avif. The stored asset then
 * gets the same checks as a browser upload (inspectImage's limits), applied
 * to the Upload API response the server received itself: unlike a browser
 * upload, nothing in between could have forged it, and skipping the Admin API
 * lookup keeps a large import inside Cloudinary's hourly Admin API limit. If
 * the checks fail, or Cloudinary answers with another id, the new asset is
 * destroyed (best effort, it is referenced by nothing) and the reason
 * returned. Nothing is uploaded for an empty or oversize buffer.
 * `productId` must be a lowercase 24-hex id (TypeError otherwise).
 */
export async function uploadImageBuffer(
  productId: string,
  data: Uint8Array,
): Promise<ServerUploadResult> {
  const publicId = buildPublicId("product", productId, randomUUID());
  if (data.byteLength === 0) return { ok: false, reason: "bad_format" };
  if (data.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  configure();
  // Hashed before the upload awaits, so it describes exactly the bytes sent.
  const sourceSha256 = createHash("sha256").update(data).digest("hex");

  let result: UploadApiResponse;
  try {
    result = await uploadStream(data, {
      public_id: publicId,
      resource_type: "image",
      type: "upload",
      overwrite: false,
      allowed_formats: [...ALLOWED_IMAGE_FORMATS],
    });
  } catch (error) {
    const code = httpCode(error);
    // Never log the error object: it carries the request options.
    console.error(`[cloudinary] server upload failed (http ${code ?? "n/a"})`);
    // 400: Cloudinary refused the file itself (not an image, format not allowed).
    return { ok: false, reason: code === 400 ? "bad_format" : "unavailable" };
  }

  // overwrite:false answers with the EXISTING asset when the id is taken. A
  // fresh uuid makes that practically impossible, but if it happens the asset
  // is someone else's: never inspect, keep or destroy it.
  if ((result as { existing?: unknown }).existing === true) {
    return { ok: false, reason: "exists" };
  }
  if (result.public_id !== publicId) {
    if (
      typeof result.public_id === "string" &&
      isOwnPublicId("product", productId, result.public_id)
    ) {
      await destroyImage(result.public_id);
    }
    return { ok: false, reason: "unavailable" };
  }

  const check = checkStoredImage(result);
  if (!check.ok) {
    await destroyImage(publicId);
    return { ok: false, reason: check.reason };
  }
  return {
    ok: true,
    image: {
      publicId,
      sourceSha256,
      bytes: check.bytes,
      format: check.format,
      width: check.width,
      height: check.height,
    },
  };
}
