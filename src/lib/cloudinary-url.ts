/**
 * Parser for CLOUDINARY_URL, the single credential string the Cloudinary
 * console shows under API Keys:
 *
 *   cloudinary://<api_key>:<api_secret>@<cloud_name>
 *
 * Shared by `src/lib/env.ts` (credentials, server-only) and `next.config.ts`
 * (cloud name for the image allow-list), so this module must not import
 * `server-only` or anything else that is server-only.
 *
 * The input contains the API secret: never put it, or any part of it, into an
 * error, a log or a return value other than `apiSecret`.
 */

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/** Cloudinary cloud names: letters, digits, "-" and "_". */
const CLOUD_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Cloudinary API keys are numeric. */
const API_KEY = /^\d+$/;
/** API secrets are URL-safe base64-like strings. */
const API_SECRET = /^[A-Za-z0-9_-]+$/;

export const CLOUDINARY_URL_FORMAT =
  "cloudinary://<api_key>:<api_secret>@<cloud_name> (Cloudinary console → API Keys → API environment variable)";

/** Returns the credentials, or `null` if the value is not a well-formed CLOUDINARY_URL. */
export function parseCloudinaryUrl(
  value: string,
): CloudinaryCredentials | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  // Only the plain form is supported. Private-CDN options passed as query
  // parameters are rejected rather than silently ignored.
  if (
    url.protocol !== "cloudinary:" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return null;
  }

  let apiKey: string;
  let apiSecret: string;
  try {
    apiKey = decodeURIComponent(url.username);
    apiSecret = decodeURIComponent(url.password);
  } catch {
    return null;
  }
  const cloudName = url.hostname;

  if (
    !API_KEY.test(apiKey) ||
    !API_SECRET.test(apiSecret) ||
    !CLOUD_NAME.test(cloudName)
  ) {
    return null;
  }

  return { cloudName, apiKey, apiSecret };
}
