// Browser side of a direct image upload to Cloudinary (ADR 0045): the checks
// run before asking the server to sign, the POST with progress, the check of
// Cloudinary's answer and admin preview URLs. Client-safe: no server imports.

import { MAX_IMAGE_BYTES } from "@/lib/constants";

/**
 * What a sign action returns (the shape of `SignedUpload` in
 * src/lib/cloudinary.ts, repeated here so client code never imports a
 * server-only module). `fields` holds the signature: post it, never log it.
 */
export interface SignedImageUpload {
  uploadUrl: string;
  cloudName: string;
  publicId: string;
  fields: Readonly<Record<SignedFieldName, string>>;
}

/** The form fields Cloudinary's signed upload expects next to the file. */
export type SignedFieldName =
  | "api_key"
  | "timestamp"
  | "public_id"
  | "allowed_formats"
  | "overwrite"
  | "signature";

/*
 * MIME types the picker and the pre-sign check accept. Cloudinary's signed
 * `allowed_formats` and the server's verification after upload are the real
 * gate; this check only saves the admin a pointless upload.
 */
export const ACCEPTED_IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/webp": "WebP",
  "image/avif": "AVIF",
};

/** The file input's `accept`: MIME types plus extensions for older pickers. */
export const IMAGE_ACCEPT = [
  ...Object.keys(ACCEPTED_IMAGE_TYPES),
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
].join(",");

const MB = 1024 * 1024;

/**
 * "10 MB", "2.4 MB", "640 KB": sizes as people read them. Rounded UP to one
 * decimal, so a file just over the 10 MB limit reads "10.1 MB", never a
 * misleading "10.0 MB".
 */
export function formatBytes(bytes: number): string {
  const kb = Math.max(1, Math.ceil(bytes / 1024));
  if (kb < 1024) return `${kb} KB`;
  const mb = Math.ceil((bytes / MB) * 10) / 10;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

const FORMATS_TEXT = "JPG, PNG, WebP or AVIF";

/**
 * Which files one picker takes: MIME types (the pre-sign check), the
 * `accept` string and the formats as people read them. The server's signed
 * `allowed_formats` and its verification stay the real gate.
 */
export interface ImageFileRules {
  types: Readonly<Record<string, string>>;
  accept: string;
  formatsText: string;
}

/** Product and area images: JPG, PNG, WebP or AVIF. */
export const DEFAULT_IMAGE_RULES: ImageFileRules = {
  types: ACCEPTED_IMAGE_TYPES,
  accept: IMAGE_ACCEPT,
  formatsText: FORMATS_TEXT,
};

/**
 * A category icon: PNG, SVG or WebP (Cloudinary stores the SVG; the site
 * always gets a raster copy, never SVG markup).
 */
export const CATEGORY_ICON_RULES: ImageFileRules = {
  types: { "image/png": "PNG", "image/svg+xml": "SVG", "image/webp": "WebP" },
  accept: "image/png,image/svg+xml,image/webp,.png,.svg,.webp",
  formatsText: "PNG, SVG or WebP",
};

/** A category cover image: JPG, PNG or WebP. */
export const CATEGORY_COVER_RULES: ImageFileRules = {
  types: { "image/jpeg": "JPG", "image/png": "PNG", "image/webp": "WebP" },
  accept: "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp",
  formatsText: "JPG, PNG or WebP",
};

/** Help text under a multi-file picker. */
export const IMAGE_RULES_TEXT = `${FORMATS_TEXT}, up to ${formatBytes(MAX_IMAGE_BYTES)} each.`;

/** Help text under a one-file picker. */
export function singleImageRulesText(
  rules: ImageFileRules = DEFAULT_IMAGE_RULES,
): string {
  return `${rules.formatsText}, up to ${formatBytes(MAX_IMAGE_BYTES)}.`;
}

/** Help text under a one-file product/area picker. */
export const SINGLE_IMAGE_RULES_TEXT = singleImageRulesText();

/**
 * Why this file can't be uploaded, or null when it may be. Runs BEFORE the
 * sign request, so a wrong file never costs a signature or an upload.
 */
export function checkImageFile(
  file: {
    name: string;
    size: number;
    type: string;
  },
  rules: ImageFileRules = DEFAULT_IMAGE_RULES,
): string | null {
  if (!Object.hasOwn(rules.types, file.type)) {
    return `${file.name} is not a ${rules.formatsText} image.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_IMAGE_BYTES) {
    return `${file.name} is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_IMAGE_BYTES)}.`;
  }
  return null;
}

/** "Uploading 45%" for the status text; whole percents from 0 to 100. */
export function progressPercent(loaded: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
}

export type UploadOutcome = { ok: true } | { ok: false; message: string };

export const UPLOAD_FAILED =
  "The upload failed. Check your connection and try again.";
const UPLOAD_CANCELLED = "The upload was cancelled.";
export const UPLOAD_MISMATCH =
  "Cloudinary stored the file under a different name, so it was not used. Upload it again.";

/**
 * Reads Cloudinary's answer to the upload POST. Success needs a 2xx status
 * AND `public_id` equal to the id the server signed: anything else is a
 * failure, so the editor never shows an image the save would refuse.
 */
export function readUploadResponse(
  status: number,
  body: string,
  expectedPublicId: string,
): UploadOutcome {
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  const record =
    typeof json === "object" && json !== null
      ? (json as Record<string, unknown>)
      : {};
  if (status < 200 || status >= 300) {
    const error = record.error;
    const message =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message.slice(0, 200)
        : "";
    return {
      ok: false,
      message: message === "" ? UPLOAD_FAILED : `Upload refused: ${message}`,
    };
  }
  return record.public_id === expectedPublicId
    ? { ok: true }
    : { ok: false, message: UPLOAD_MISMATCH };
}

/**
 * POSTs one file to Cloudinary with every signed field, reporting progress
 * in whole percents. XMLHttpRequest, not fetch, because fetch has no upload
 * progress. `signal` aborts it (the page was left). Never logs anything:
 * the fields carry the signature.
 */
export function uploadImage(
  signed: SignedImageUpload,
  file: Blob,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(signed.fields)) {
      body.append(key, value);
    }
    body.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", signed.uploadUrl);
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(progressPercent(event.loaded, event.total));
      }
    };
    const cancel = () => xhr.abort();
    // Settles once and lets go of the shared signal.
    const finish = (outcome: UploadOutcome) => {
      signal?.removeEventListener("abort", cancel);
      resolve(outcome);
    };
    xhr.onload = () =>
      finish(readUploadResponse(xhr.status, xhr.responseText, signed.publicId));
    xhr.onerror = () => finish({ ok: false, message: UPLOAD_FAILED });
    xhr.onabort = () => finish({ ok: false, message: UPLOAD_CANCELLED });
    if (signal) {
      if (signal.aborted) {
        resolve({ ok: false, message: UPLOAD_CANCELLED });
        return;
      }
      signal.addEventListener("abort", cancel, { once: true });
    }
    xhr.send(body);
  });
}

/*
 * Cloud names are letters, digits, "-" and "_" (src/lib/cloudinary-url.ts);
 * anything else gives no URL rather than a URL built from odd input.
 */
const CLOUD_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Delivery formats a preview may ask for. */
export type PreviewFormat = "auto" | "png";

/**
 * A small admin preview of one stored image, fitted (never cropped) within
 * `width` px, in the browser's best format (`f_auto`) or as PNG (`f_png`:
 * category icons, whose SVG originals are always shown as a raster). Loaded
 * straight from res.cloudinary.com, which the CSP's img-src allows. Null
 * without a cloud name (Cloudinary not configured): the card shows a
 * placeholder instead.
 */
export function previewUrl(
  cloudName: string | null,
  publicId: string,
  width = 480,
  format: PreviewFormat = "auto",
): string | null {
  if (cloudName === null || !CLOUD_NAME.test(cloudName)) return null;
  return `https://res.cloudinary.com/${cloudName}/image/upload/c_limit,w_${width},h_${width},f_${format},q_auto/${publicId}`;
}
