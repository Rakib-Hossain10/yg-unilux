// Public product and area images on the site: the Cloudinary cloud name (read
// on the server, never a public env variable) and the plain delivery URL that
// next/image optimises. The cloud name is public; key and secret never leave.

import "server-only";

import { env, EnvError } from "@/lib/env";

/** The cloud name, or null when Cloudinary is not configured (dev, CI). */
export function siteCloudName(): string | null {
  try {
    return env.cloudinary().cloudName;
  } catch (error) {
    if (error instanceof EnvError) return null;
    throw error;
  }
}

/**
 * The untransformed delivery URL of a public image, or null without a cloud
 * name. next/image resizes it (remotePatterns are pinned to our cloud, ADR
 * 0016), so no Cloudinary transformation is put in the URL.
 */
export function cloudinaryImageUrl(
  cloudName: string | null,
  publicId: string,
): string | null {
  if (!cloudName || publicId === "") return null;
  const path = publicId.split("/").map(encodeURIComponent).join("/");
  return `https://res.cloudinary.com/${encodeURIComponent(cloudName)}/image/upload/${path}`;
}
